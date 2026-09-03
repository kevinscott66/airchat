/**
 * linkProof — привязка внешнего профиля (GitHub, X) доказательством владения
 * (v4.32.573).
 *
 * Прежде ссылки на GitHub и X были двумя обычными полями ввода: что человек
 * туда напечатал, то и показывалось. Это ровно та же дыра, из-за которой
 * галочка аккаунта сделана выданной бумагой, а не полем `verified: true` (см.
 * identity/verification): поле, которое аккаунт заполняет себе сам, не
 * подтверждает ничего. Написать в своём профиле «github.com/torvalds» может
 * кто угодно, и до этой версии выглядело это неотличимо от правды.
 *
 * Поэтому связь доказывается, а не заявляется, и доказательство устроено так,
 * что проверить его может любой, ни у кого не спрашивая разрешения:
 *
 *  1. Приложение подписывает своим ключом короткую запись: «этот аккаунт
 *     (открытый ключ k) заявляет, что ему принадлежит @h на площадке p».
 *  2. Человек публикует эту запись ТАМ — в открытом gist на GitHub, в записи
 *     на X. Опубликовать её под чужим именем нельзя: для этого нужен доступ к
 *     тому самому аккаунту, а это и есть проверяемое утверждение.
 *  3. Проверяющий читает опубликованное, сверяет автора публикации с именем
 *     внутри записи и проверяет подпись открытым ключом аккаунта.
 *
 * Обе половины обязательны, и каждая закрывает свою подделку. Без подписи
 * достаточно скопировать чужую публикацию себе в профиль. Без сверки автора
 * достаточно опубликовать свою запись где угодно и назвать её чужим именем:
 * подпись-то своя. Вместе они не оставляют места: подпись привязывает запись
 * к аккаунту AirChat, имя внутри подписанного — к конкретной учётной записи
 * на площадке, а автор публикации доказывает доступ к этой учётной записи.
 *
 * Срока годности у доказательства нет намеренно. Оно перестаёт действовать
 * само: публикацию удалили — проверка перестанет проходить у всех, кто её
 * повторит. Дата в записи нужна не для протухания, а чтобы две публикации
 * одного и того же аккаунта отличались друг от друга.
 *
 * Модуль чистый: ни сети, ни базы, ни экрана. Сеть — в linkProofCheck.
 */
import { publicKeyFromB64 } from '../crypto/pubKeyFormat';
import { verifyBytes, verifySignedJson } from '../crypto/signature';
// v4.32.575: правила имён и адресов площадок переехали в linkPlatform —
// они нужны и разбору конверта профиля, куда криптографии ходу нет. Здесь
// они по-прежнему видны наружу: этот модуль остаётся дверью в привязку, и
// вызывающим местам незачем знать, что правило лежит этажом ниже.
import {
  PLATFORM_LABEL,
  normalizeHandle,
  normalizeProofUrl,
  profileUrl,
  sameHandle,
  type LinkPlatform,
} from './linkPlatform';

export { PLATFORM_LABEL, normalizeHandle, normalizeProofUrl, profileUrl, sameHandle };
export type { LinkPlatform };

/** Что подписывается. Короткое: запись публикуют вручную, её будут видеть. */
export type ProofPayload = {
  /** Версия формата: менять правила проверки, не ломая старые публикации. */
  v: 1 | 2;
  p: LinkPlatform;
  /** Имя учётной записи на площадке. */
  h: string;
  /** Открытый ключ аккаунта AirChat, base64. */
  k: string;
  /** Когда собрано. Не срок годности — различитель двух публикаций. */
  t: number;
};

export const PROOF_PREFIX = 'airchat-proof:v1:';

/** Токен целиком: две части base64url через точку. */
const TOKEN_RE = /airchat-proof:v1:([A-Za-z0-9_-]{16,1024})\.([A-Za-z0-9_-]{86,88})/g;

/**
 * Формат v2 (v4.32.575): то же самое, но помещается в запись X.
 *
 * У v1 нагрузка — это JSON, закодированный в base64url. Он несёт ровно четыре
 * значения, но платит за это дважды: сначала за имена полей и кавычки, потом
 * за треть сверху при кодировании. Токен выходил 238 символов, и вместе с
 * человеческой фразой — 313 при потолке X в 280. То есть подтвердить X было
 * нельзя в принципе: способ, которым это делается, не влезал туда, где его
 * надо опубликовать.
 *
 * Здесь те же четыре значения записаны как есть, через двоеточие:
 *
 *   airchat-proof:v2:<площадка>:<имя>:<ключ>:<время>.<подпись>
 *
 * Ключ — base64url без выравнивания (43 символа вместо 44 и без `=`, который
 * площадки любят превращать в часть ссылки). Время — минуты от эпохи в
 * тридцатишестеричной записи: секунды и миллисекунды тут не нужны, дата в
 * записи не срок годности, а различитель двух публикаций одного аккаунта.
 * Выходит 167 символов — с фразой около 240, и в запись X это влезает.
 *
 * Подписывается СТРОКА ТОКЕНА целиком, вместе с префиксом `airchat-proof:v2:`
 * и без подписи на конце. Префикс внутри подписанного — не украшение: без
 * него та же подпись под теми же байтами могла бы быть предъявлена в другом
 * месте протокола, где четыре поля через двоеточие значат что-то своё.
 */
export const PROOF_PREFIX_V2 = 'airchat-proof:v2:';

const TOKEN_RE_V2 =
  /airchat-proof:v2:(github|x):([A-Za-z0-9_-]{1,39}):([A-Za-z0-9_-]{43}):([0-9a-z]{1,10})\.([A-Za-z0-9_-]{86,88})/g;

/** Разумный потолок разбора: настоящая запись — пара сотен байт. */
const MAX_PAYLOAD_CHARS = 768;
/** Сколько текста публикации вообще просматривается на предмет токена. */
export const MAX_SCAN_CHARS = 256 * 1024;
/** Больше одной попытки в публикации быть может, но не сотня. */
const MAX_TOKENS = 8;

function b64uFromB64(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64FromB64u(b64u: string): string {
  return b64u.replace(/-/g, '+').replace(/_/g, '/');
}

/**
 * Подпись в байты. Длину проверяет ed25519 сам, но пустой ввод сюда лучше не
 * доводить: Buffer.from молча выбрасывает всё, чего не понимает.
 */
function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function b64uEncodeText(text: string): string {
  return b64uFromB64(Buffer.from(text, 'utf8').toString('base64'));
}

function b64uDecodeText(b64u: string): string | null {
  try {
    const buf = Buffer.from(b64FromB64u(b64u), 'base64');
    if (buf.length === 0 || buf.length > MAX_PAYLOAD_CHARS) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Собрать токен из уже подписанного (см. crypto/signature.signJson). */
export function encodeProofToken(payloadJson: string, signatureB64: string): string {
  return `${PROOF_PREFIX}${b64uEncodeText(payloadJson)}.${b64uFromB64(signatureB64)}`;
}

/**
 * Тело токена v2 — то, что подписывается и что потом проверяется байт в байт.
 *
 * Отдельной функцией, а не строкой в двух местах: собрать и проверить нужно
 * ОДИНАКОВО, и любое расхождение здесь выглядит как неверная подпись, что
 * ищется дольше всего.
 */
function proofBodyV2(p: LinkPlatform, h: string, kB64u: string, minutes: number): string {
  return `${PROOF_PREFIX_V2}${p}:${h}:${kB64u}:${minutes.toString(36)}`;
}

/** Собрать токен v2 из уже подписанного тела. */
export function encodeProofTokenV2(body: string, signatureB64: string): string {
  return `${body}.${b64uFromB64(signatureB64)}`;
}

/**
 * Тело для подписи. Возвращает и его, и разобранную нагрузку: подписывающему
 * нужно первое, а вызывающему — знать, что именно он подписал.
 */
export function proofBodyFor(
  platform: LinkPlatform,
  handle: string,
  publicKeyB64: string,
  now: number
): { body: string; payload: ProofPayload } | null {
  const h = normalizeHandle(platform, handle);
  if (!h) return null;
  if (!publicKeyFromB64(publicKeyB64)) return null;
  const minutes = Math.floor(now / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return {
    body: proofBodyV2(platform, h, b64uFromB64(publicKeyB64), minutes),
    payload: { v: 2, p: platform, h, k: publicKeyB64, t: minutes * 60_000 },
  };
}

/**
 * Разобрать токен v2: что подписано (message) и чем (signature).
 *
 * Нагрузка тут не декодируется из чего-то — она и есть сам текст токена,
 * поэтому подделать её, не тронув подписанные байты, невозможно.
 */
function decodeProofTokenV2(
  token: unknown
): { message: string; signature: string; payload: ProofPayload } | null {
  if (typeof token !== 'string' || token.length > MAX_SCAN_CHARS) return null;
  const m = new RegExp(TOKEN_RE_V2.source).exec(token);
  if (!m) return null;
  const [, p, rawHandle, kB64u, t36, sig] = m;
  const platform = p as LinkPlatform;
  const h = normalizeHandle(platform, rawHandle);
  // Имя обязано быть уже каноническим: регулярное выражение пропускает и то,
  // что правилам площадки не отвечает, — например дефис по краям у GitHub.
  if (!h || h !== rawHandle) return null;
  const k = b64FromB64u(kB64u) + '=';
  if (!publicKeyFromB64(k)) return null;
  const minutes = parseInt(t36, 36);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return {
    message: proofBodyV2(platform, h, kB64u, minutes),
    signature: b64FromB64u(sig),
    payload: { v: 2, p: platform, h, k, t: minutes * 60_000 },
  };
}

/** Разобрать токен обратно в то, что проверяет verifySignedJson. */
export function decodeProofToken(token: unknown): { payload: string; signature: string } | null {
  if (typeof token !== 'string' || token.length > MAX_SCAN_CHARS) return null;
  const re = new RegExp(TOKEN_RE.source);
  const m = re.exec(token);
  if (!m) return null;
  const payload = b64uDecodeText(m[1]);
  if (payload === null) return null;
  return { payload, signature: b64FromB64u(m[2]) };
}

/**
 * Найти токены в тексте публикации.
 *
 * Текст приходит из сети и целиком недоверенный: это чужая страница, в которой
 * наша строка лежит среди чего угодно. Поэтому потолки — и на длину просмотра,
 * и на число находок.
 */
export function findProofTokens(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const slice = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const out: string[] = [];
  // Оба формата разом: в публикации может лежать и старая строка (её
  // выпустили до 4.32.575 и никто не обязан переделывать), и новая.
  const re = new RegExp(`${TOKEN_RE_V2.source}|${TOKEN_RE.source}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    out.push(m[0]);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** Прочитать разобранную нагрузку, ничего не принимая на веру. */
export function readProofPayload(v: unknown): ProofPayload | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.p !== 'github' && o.p !== 'x') return null;
  if (typeof o.h !== 'string' || typeof o.k !== 'string') return null;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return null;
  const h = normalizeHandle(o.p, o.h);
  if (!h) return null;
  if (!publicKeyFromB64(o.k)) return null;
  return { v: 1, p: o.p, h, k: o.k, t: o.t };
}

/** Что именно не сошлось. Каждая причина ведёт человека в своё место. */
export type ProofFailure =
  /** В публикации нет нашей строки — не ту открыли или не сохранили. */
  | 'no_token'
  /** Строка есть, но покалечена: перенос, обрезка, лишний символ. */
  | 'bad_token'
  /** Подпись не сходится с ключом — строку правили руками. */
  | 'bad_signature'
  /** Подписано, но другим аккаунтом AirChat: чужое доказательство. */
  | 'wrong_account'
  /** Подписано на другое имя или другую площадку. */
  | 'wrong_handle'
  /** Автор публикации — не тот, кому её приписывают. Главная проверка. */
  | 'owner_mismatch'
  /** Площадка не ответила. Ничего не доказано и не опровергнуто. */
  | 'network'
  /** По адресу ничего нет: удалено, приватное, опечатка. */
  | 'not_found'
  /** Адрес не похож на публикацию, из которой можно достать автора. */
  | 'bad_url';

export type ProofCheck = { ok: true; payload: ProofPayload } | { ok: false; reason: ProofFailure };

export type ProofExpectation = {
  platform: LinkPlatform;
  handle: string;
  /** Открытый ключ своего аккаунта, base64. */
  publicKeyB64: string;
};

/**
 * Один и тот же ключ, записанный по-разному.
 *
 * v1 несёт ключ обычным base64 с выравниванием, v2 — base64url без него.
 * Сравнивать строки как есть значило бы отвергать собственный же новый
 * формат, поэтому сравнение идёт по каноническому виду.
 */
function sameKeyB64(a: string, b: string): boolean {
  return b64uFromB64(a) === b64uFromB64(b);
}

/** Подписанная нагрузка обоих форматов — или null, если подпись не сошлась. */
async function readVerifiedPayload(token: string, pub: Uint8Array): Promise<ProofPayload | null> {
  const v2 = decodeProofTokenV2(token);
  if (v2) {
    const ok = await verifyBytes(pub, new TextEncoder().encode(v2.message), b64ToBytes(v2.signature));
    return ok ? v2.payload : null;
  }
  const v1 = decodeProofToken(token);
  if (!v1) return null;
  const obj = await verifySignedJson(pub, v1);
  return obj ? readProofPayload(obj) : null;
}

/**
 * Проверить одну строку доказательства.
 *
 * Сверка автора публикации сюда не входит: этот модуль не ходит в сеть, а
 * автора знает только тот, кто её оттуда достал. Без этой второй половины
 * проверка неполна — поэтому в UI её результат не показывается сам по себе.
 */
export async function verifyProofToken(token: string, expect: ProofExpectation): Promise<ProofCheck> {
  const pub = publicKeyFromB64(expect.publicKeyB64);
  if (!pub) return { ok: false, reason: 'wrong_account' };
  // Версия решает только то, как достать подписанное и нагрузку. Дальше —
  // одни и те же правила: иначе у старого формата со временем завелись бы
  // свои послабления, чего при живых публикациях никто бы не заметил.
  const payload = await readVerifiedPayload(token, pub);
  if (!payload) {
    // Различить «строка покалечена» и «подпись не сходится» можно только по
    // тому, разобралась ли она вообще.
    const parsed = decodeProofTokenV2(token) ?? decodeProofToken(token);
    return { ok: false, reason: parsed ? 'bad_signature' : 'bad_token' };
  }
  if (!sameKeyB64(payload.k, expect.publicKeyB64)) return { ok: false, reason: 'wrong_account' };
  if (payload.p !== expect.platform) return { ok: false, reason: 'wrong_handle' };
  if (!sameHandle(payload.h, expect.handle)) return { ok: false, reason: 'wrong_handle' };
  return { ok: true, payload };
}

/**
 * Проверить всё, что нашлось в тексте публикации.
 *
 * Возвращается первая сошедшаяся строка, а причина отказа — от последней
 * несошедшейся: человеку важно не «одна из восьми не подошла», а что делать.
 */
export async function verifyProofInText(text: string, expect: ProofExpectation): Promise<ProofCheck> {
  const tokens = findProofTokens(text);
  if (tokens.length === 0) return { ok: false, reason: 'no_token' };
  let last: ProofCheck = { ok: false, reason: 'no_token' };
  for (const t of tokens) {
    const res = await verifyProofToken(t, expect);
    if (res.ok) return res;
    last = res;
  }
  return last;
}

/**
 * Текст, который человек публикует.
 *
 * Первая строка — для людей: тот, кто наткнётся на публикацию, должен понять,
 * что это, без чтения base64. Вторая — для машин. Ссылка на аккаунт даётся в
 * виде AC-кода: он читается глазами и выводится из того же ключа.
 */
export function proofStatementText(token: string, accountRef: string, platform: LinkPlatform): string {
  return [
    `Подтверждаю, что этот ${PLATFORM_LABEL[platform]} принадлежит мне же в AirChat: ${accountRef}.`,
    token,
  ].join('\n');
}

/**
 * Что хранится рядом с именем после успешной проверки.
 *
 * Адрес публикации хранится не ради красоты: подтверждение — не вечная
 * истина, а факт «в такой-то день по такому-то адресу лежала подписанная
 * строка». Публикацию можно удалить, а имя на площадке — передать другому
 * человеку. Поэтому запись всегда предъявляется вместе с адресом и датой:
 * так её можно перепроверить, а не поверить на слово.
 */
export type LinkRecord = { url: string; verifiedAt: number };

export function encodeLinkProofRecord(rec: LinkRecord): string {
  return JSON.stringify({ url: rec.url, verifiedAt: rec.verifiedAt });
}

export function readLinkProofRecord(raw: unknown): LinkRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { url?: unknown; verifiedAt?: unknown };
  if (typeof o.url !== 'string' || o.url.length === 0) return null;
  if (typeof o.verifiedAt !== 'number' || !Number.isFinite(o.verifiedAt) || o.verifiedAt <= 0) return null;
  return { url: o.url, verifiedAt: o.verifiedAt };
}

/**
 * Три состояния ссылки, а не два.
 *
 * «Заявлено» — это не ошибка и не полуподтверждение: человек вправе указать
 * своё имя на площадке, не публикуя ничего. Показывать такое имя рядом с
 * подтверждённым без разницы нельзя — тогда галочка не значит ничего; но и
 * прятать его нельзя — тогда поле просто исчезнет у тех, кто не захотел
 * публиковать.
 */
export type LinkState = 'empty' | 'claimed' | 'verified';

export function linkState(handle: unknown, record: LinkRecord | null): LinkState {
  if (typeof handle !== 'string' || handle.trim().length === 0) return 'empty';
  return record ? 'verified' : 'claimed';
}

/**
 * Причина отказа человеческими словами.
 *
 * Разделение здесь не косметическое: «мы не смогли проверить» и «это не
 * сходится» — разные новости. Первое означает «попробуйте позже», второе —
 * «так подтверждения не будет». Слить их в одно «ошибка» значит либо пугать
 * человека, у которого просто не открылся сайт, либо успокаивать того, чьё
 * доказательство подписано чужим ключом.
 */
export function proofFailureText(reason: ProofFailure, platform: LinkPlatform): string {
  const site = PLATFORM_LABEL[platform];
  switch (reason) {
    case 'no_token':
      return 'В публикации нет строки подтверждения. Проверьте, что сохранили её целиком и открыли именно ту публикацию.';
    case 'bad_token':
      return 'Строка подтверждения повреждена: похоже, она скопировалась не целиком.';
    case 'bad_signature':
      return 'Подпись не сходится. Опубликуйте строку заново — эту правили после копирования.';
    case 'wrong_account':
      return 'Эта строка подписана другим аккаунтом AirChat.';
    case 'wrong_handle':
      return 'Строка подписана на другое имя. Начните заново с тем именем, которое указали здесь.';
    case 'owner_mismatch':
      return `Публикация принадлежит другому аккаунту ${site}. Опубликуйте строку со своего.`;
    case 'network':
      return `${site} не ответил. Ничего не проверено — попробуйте ещё раз позже.`;
    case 'not_found':
      return 'По этому адресу ничего нет: публикация удалена, скрыта или в адресе опечатка.';
    case 'bad_url':
      return platform === 'github'
        ? 'Нужен адрес gist — вида gist.github.com/…'
        : 'Нужен адрес поста — вида x.com/имя/status/…';
  }
}
