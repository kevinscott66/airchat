/**
 * official-badge — проверка бумаги на официальную галочку (v4.32.548).
 *
 * Зеркало клиентского `src/core/identity/verification.ts`, и заведено оно ради
 * одного места: захвата зарезервированного имени. Клиент уже умеет открывать
 * `@founder` тому, у кого есть подписанная бумага, но последнее слово о
 * юзернеймах за сервером — иначе список оставленных приложению имён обходится
 * пересборкой клиента. Значит, ту же бумагу должен уметь читать и сервер.
 *
 * Открытая половина ключа здесь — это всё, что серверу нужно и что ему можно
 * доверить: подписывают бумаги снаружи, закрытый ключ в образ не попадает.
 *
 * Что связывает бумагу с предъявителем. Нагрузка содержит `did` аккаунта, а
 * подписан сам запрос ключом аккаунта (`accountPublicKeyB64`). Совпадение
 * этих двух — единственное, что мешает переписать чужую бумагу себе: она
 * ездит в конверте профиля открытым текстом, и любой собеседник официального
 * аккаунта видел бы её целиком.
 *
 * Оговорка, которую важно знать. Запрос синхронизации подписывается ключом
 * НУЛЕВОГО вывода сид-фразы (`deriveKeyPairFromMnemonic`), а галочка лежит в
 * карточке конкретного профиля. На основном профиле это один и тот же ключ, и
 * проверка точна. Для дополнительных профилей (их до четырёх на сид-фразу)
 * did не совпадёт, и сервер имя не откроет. Так и задумано: расширять доверие
 * на братские профили пришлось бы «на слово клиента», а слову клиента в
 * реестре имён веры нет — ровно за этим сервер и проверяет всё заново.
 */
const { ed25519 } = require('@noble/curves/ed25519.js');

/**
 * Открытые ключи, чьей подписи достаточно для галочки. Список, а не одно
 * значение: смена ключа должна быть возможна без дня, когда старые бумаги уже
 * не читаются, а новые ещё не выданы. Клиентская копия — в
 * `src/core/identity/officialKeys.ts`; расхождение ловит тест.
 */
const OFFICIAL_VERIFIER_KEYS = Object.freeze([
  'mhew8W95ET6owjdkGJFFtcDUu9JZNk11gJYpeTOopDM=',
]);

/** Потолок строки бумаги — тот же, что у клиента (`MAX_GRANT_LEN`). */
const MAX_GRANT_LEN = 1024;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * base58btc над байтами. Написано руками: у сервера в зависимостях нет
 * `multiformats`, а тянуть её сюда ради тридцати четырёх байт — менять размер
 * образа и поверхность зависимостей на удобство.
 *
 * Ведущие нули кодируются символом '1' поштучно — это часть определения base58
 * и единственное, что в ней легко забыть: без этого did:key ключа, начавшегося
 * с нулевого байта, отличался бы от клиентского.
 */
function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/**
 * Открытый ключ base64 → did:key. Форма та же, что у клиентского
 * `publicKeyToDidKey`: multicodec 0xed 0x01 перед ключом, всё вместе в
 * base58btc с мультибейз-префиксом 'z'.
 */
function didKeyFromPublicKeyB64(publicKeyB64) {
  if (typeof publicKeyB64 !== 'string') return null;
  const key = Buffer.from(publicKeyB64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== publicKeyB64) return null;
  return `did:key:z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), key]))}`;
}

/**
 * Что подтверждает бумага, предъявленная владельцем `expectedDid`.
 * Возвращает имя в нижнем регистре либо null. Причина отказа не называется:
 * снаружи «бумаги нет» и «бумага чужая» — одно и то же событие.
 *
 * `keys` существует только для тестов: подписать настоящей бумагой они не
 * могут, а обойти проверку подписи ради удобства — значит не проверить её
 * вовсе. В проде параметр не передаётся, и единственный вызов в index.js
 * пользуется списком по умолчанию.
 */
function grantedUsername(raw, expectedDid, keys = OFFICIAL_VERIFIER_KEYS) {
  if (typeof raw !== 'string' || typeof expectedDid !== 'string' || !expectedDid) return null;
  const text = raw.trim();
  if (!text || text.length > MAX_GRANT_LEN) return null;

  let grant;
  try {
    grant = JSON.parse(text);
  } catch {
    return null;
  }
  if (!grant || typeof grant !== 'object') return null;
  if (typeof grant.payload !== 'string' || typeof grant.signature !== 'string') return null;
  const sig = Buffer.from(grant.signature, 'base64');
  if (sig.length !== 64) return null;
  const message = Buffer.from(grant.payload, 'utf8');

  for (const keyB64 of keys) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) continue;
    let ok = false;
    try {
      ok = ed25519.verify(sig, message, key);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    // Подпись настоящая: дальше по списку идти незачем, нагрузка одна и та же
    // и другим ключом другого не скажет.
    return readClaim(grant.payload, expectedDid);
  }
  return null;
}

/** Разбор проверенной нагрузки. Неизвестная версия или вид — отказ. */
function readClaim(payloadText, expectedDid) {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.v !== 1 || payload.kind !== 'official') return null;
  if (payload.did !== expectedDid) return null;
  if (typeof payload.username !== 'string') return null;
  const username = payload.username.trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(username) ? username : null;
}

module.exports = {
  OFFICIAL_VERIFIER_KEYS,
  MAX_GRANT_LEN,
  base58Encode,
  didKeyFromPublicKeyB64,
  grantedUsername,
};
