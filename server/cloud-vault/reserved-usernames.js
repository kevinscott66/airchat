/**
 * Зеркало клиентского списка занятых имён (`src/core/identity/reservedUsernames.ts`).
 *
 * Реестр имён — общий на всё приложение, и последнее слово в нём за сервером:
 * клиент можно пересобрать, отключить проверку и попросить себе `support`.
 * Поэтому те же правила стоят и здесь — длина, набор символов, список
 * оставленных приложению имён. Список продублирован намеренно: сервер живёт в
 * отдельном процессе на CommonJS и не собирается вместе с приложением.
 * Расхождение ловит тест `username-registry.test.js`, который читает исходник
 * клиента и сверяет оба множества.
 */
const USERNAME_MIN_SELF_SERVICE = 5;
/** Нижняя граница протокола (`src/core/identity/username.ts`). */
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;

const RESERVED_USERNAMES = new Set([
  // приложение и его разделы
  'airchat', 'air', 'chat', 'chats', 'app', 'news', 'feed', 'group', 'groups',
  'channel', 'channels', 'story', 'stories', 'call', 'calls', 'settings',
  'profile', 'profiles', 'account', 'accounts', 'wallet', 'wallets',
  // роли и служебные адреса
  'owner', 'founder', 'admin', 'admins', 'administrator', 'root', 'system',
  'sys', 'staff', 'team', 'mod', 'mods', 'moderator', 'moderators',
  'support', 'help', 'helpdesk', 'service', 'security', 'abuse', 'legal',
  'official', 'verify', 'verified', 'verification', 'noreply', 'no_reply',
  'postmaster', 'webmaster', 'hostmaster', 'operator', 'bot', 'bots',
  // денежные и «подарочные» вывески
  'gift', 'gifts', 'giveaway', 'airdrop', 'bonus', 'promo', 'reward',
  'rewards', 'nft', 'nfts', 'crypto', 'coin', 'coins', 'token', 'tokens',
  'pay', 'payment', 'payments', 'billing', 'invoice', 'bank', 'shop',
  'store', 'market', 'sale', 'deal', 'deals',
  // обращения ко всем
  'me', 'you', 'all', 'everyone', 'anyone', 'nobody', 'null', 'undefined',
  'test', 'demo', 'example',
]);

/**
 * Приводит имя к каноническому виду и отвергает всё, что нельзя занять.
 * Возвращает нормализованное имя либо `null` — причину сервер не называет:
 * подробный разбор ошибки человеку показывает экран, который проверил то же
 * самое до отправки.
 *
 * `unlocked` (v4.32.548) — имя из ПРОВЕРЕННОЙ бумаги на галочку, а не строка
 * из запроса: его выдаёт `official-badge.grantedUsername` после проверки
 * подписи и привязки к аккаунту. Зеркало клиентского `checkUsernameClaim`:
 * открывается ровно одно имя, то самое, и обе нижние границы — длина и список
 * — обходятся только для него. Бумага на `founder` не открывает `support`.
 */
function normalizeClaimableUsername(value, unlocked) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(raw)) return null;
  // v4.32.615: имя из одних цифр не занимается вообще (зеркало клиентского
  // `digits_only`). Рядом с юзернеймами ходят числовые идентификаторы — номер
  // профиля, номер группы, — и `@12345` от них не отличить. Клиентская
  // проверка есть с v4.32.594, но последнее слово здесь: пересобранное
  // приложение попросило бы себе `@1` и получило бы его. Стоит ДО разрешения
  // по бумаге — цифровое имя не выдаётся и ею.
  if (/^\d+$/.test(raw)) return null;
  if (raw.length > USERNAME_MAX) return null;
  // v4.32.936: нижняя граница протокола — абсолютная, бумага её не открывает.
  // До этой версии её здесь не было совсем, и имя из одной-двух букв,
  // выписанное бумагой, сервер принимал. Клиент такое имя не разрешает нигде:
  // и `resolveMentionTarget`, и разбор чужого профиля проходят через
  // `normalizeUsername` с порогом в три символа. Строка в реестре была бы, а
  // дойти по ней до аккаунта было бы нельзя.
  if (raw.length < USERNAME_MIN) return null;
  const granted = typeof unlocked === 'string' && unlocked.trim().toLowerCase() === raw;
  if (!granted && raw.length < USERNAME_MIN_SELF_SERVICE) return null;
  if (!granted && RESERVED_USERNAMES.has(raw)) return null;
  return raw;
}

/**
 * Имя для справочного запроса.
 *
 * v4.32.936: граница та же, что у занятия, — 3 символа. Раньше здесь стояла
 * единица, и это был второй канон имени на одном сервере: спросить можно было
 * про то, что занять нельзя. Клиент короче трёх не спрашивает никогда
 * (`normalizeUsername`), так что смысла у послабления не было, а расхождение
 * было.
 */
function normalizeLookupUsername(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(raw)) return null;
  if (raw.length < USERNAME_MIN || raw.length > USERNAME_MAX) return null;
  return raw;
}

module.exports = {
  RESERVED_USERNAMES,
  USERNAME_MIN_SELF_SERVICE,
  USERNAME_MIN,
  USERNAME_MAX,
  normalizeClaimableUsername,
  normalizeLookupUsername,
};
