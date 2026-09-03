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
import { verifySignedJson } from '../crypto/signature';
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
  v: 1;
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
  const re = new RegExp(TOKEN_RE.source, 'g');
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
 * Проверить одну строку доказательства.
 *
 * Сверка автора публикации сюда не входит: этот модуль не ходит в сеть, а
 * автора знает только тот, кто её оттуда достал. Без этой второй половины
 * проверка неполна — поэтому в UI её результат не показывается сам по себе.
 */
export async function verifyProofToken(token: string, expect: ProofExpectation): Promise<ProofCheck> {
  const parts = decodeProofToken(token);
  if (!parts) return { ok: false, reason: 'bad_token' };
  const pub = publicKeyFromB64(expect.publicKeyB64);
  if (!pub) return { ok: false, reason: 'wrong_account' };
  const obj = await verifySignedJson(pub, parts);
  if (!obj) return { ok: false, reason: 'bad_signature' };
  const payload = readProofPayload(obj);
  if (!payload) return { ok: false, reason: 'bad_token' };
  if (payload.k !== expect.publicKeyB64) return { ok: false, reason: 'wrong_account' };
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
