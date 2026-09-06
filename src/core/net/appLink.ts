/**
 * appLink — одна ссылка на всё приложение: один сборщик, один разборщик.
 *
 * v4.32.606. До этой версии ссылок как явления не было. «Копировать ссылку» на
 * сообщении клало в буфер `airchat://dm/…/msg/…`, а разбирал deep link только
 * `applyTabUrl` в App.tsx, и он знал ровно две формы: `join-group/<payload>` и
 * `tab/<имя>`. Всё остальное молча возвращалось из обработчика: человек
 * копировал ссылку на сообщение, отправлял её, получатель нажимал — и не
 * происходило ничего. У профиля и публикации ссылки не было вовсе: в буфер
 * уезжал голый DID, а «Поделиться» отдавало текст без адреса.
 *
 * Здесь собраны обе стороны, и вот три решения, из которых состоит модуль.
 *
 * 1. Хост живёт в одном месте — LINK_BASE. Сменить его значит поправить одну
 *    строку (или задать EXPO_PUBLIC_LINK_BASE при сборке).
 *
 * 2. Разбор НЕ СМОТРИТ на хост. Ссылка узнаётся по форме пути, а не по имени
 *    сервера, и списка разрешённых хостов здесь нет намеренно. Это и есть
 *    ответ на «сменить адрес и не потерять доступ к старым ссылкам»: всё, что
 *    люди уже разослали под прежним доменом, продолжает открываться в
 *    приложении, а новые ссылки собираются уже под новым. Цена решения
 *    честная: чужой сайт может выложить путь такой же формы. Открытие ссылки
 *    само по себе ничего не подтверждает и ничего не отправляет — это переход
 *    к экрану, — а приглашение в группу и добавление контакта как требовали
 *    подтверждения человеком, так и требуют.
 *
 * 3. Ключ собеседника уезжает в путь в алфавите base64url. Обычный base64
 *    содержит '/', а путь режется по '/' — ссылка приходила бы обрезанной.
 *    Разбор принимает три записи ключа: base64url, обычный base64 (так его
 *    писали прежние сборки, через encodeURIComponent) и did:key — чтобы уже
 *    скопированные ссылки не перестали работать.
 *
 * Модуль чистый: ни сети, ни БД, ни React. Разбор недоверенной строки
 * проверяется тестами целиком.
 */

import { publicKeyFromB64, publicKeyToB64 } from '../crypto/pubKeyFormat';
import { parseDidKey } from '../identity/did';

/** Схема приложения. Её же понимает iOS/Android как зарегистрированную. */
export const APP_SCHEME = 'airchat';

/**
 * Адрес, под которым ссылки собираются СЕЙЧАС.
 *
 * Менять здесь — и только здесь. Ссылки, выданные под прежним адресом,
 * продолжают открываться: разбор смотрит на форму пути, а не на хост.
 */
export const DEFAULT_LINK_BASE = 'https://air.dobropalm.tech';

/**
 * Отрезок пути, с которого начинаются наши https-ссылки: `/l/<путь>`.
 *
 * Короткий и свой: сайт живёт в корне того же домена, и без отдельного
 * префикса ссылка на публикацию спорила бы с обычной страницей.
 */
export const LINK_PATH_PREFIX = 'l';

/** Потолок на всю строку — защита от подсунутой гигантской ссылки. */
export const APP_LINK_MAX = 16384;
/** Потолок на один отрезок пути. Самый длинный из наших — приглашение. */
const SEGMENT_MAX = 8192;
/** Потолок на число отрезков. Наши формы укладываются в четыре. */
const PARTS_MAX = 8;

export type AppLink =
  | { kind: 'dm'; peerPubB64: string; msgId?: string }
  | { kind: 'group'; groupId: string; msgId?: string }
  | { kind: 'contact'; peerPubB64: string }
  | { kind: 'post'; postId: string }
  | { kind: 'joinGroup'; payload: string }
  | { kind: 'tab'; tab: string };

/** Обычный base64 → base64url: '+/'→'-_', хвостовые '=' не нужны. */
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Адрес, под которым собираются новые ссылки.
 *
 * Значение из сборки (EXPO_PUBLIC_LINK_BASE) старше константы — так адрес
 * меняется вообще без правки исходника. Негодное значение игнорируется: пустая
 * или кривая переменная не должна превращать все ссылки в мусор.
 */
export function linkBase(): string {
  const fromEnv =
    typeof process !== 'undefined' && typeof process.env?.EXPO_PUBLIC_LINK_BASE === 'string'
      ? process.env.EXPO_PUBLIC_LINK_BASE.trim()
      : '';
  const raw = /^https?:\/\/[^/?#\s]+/i.test(fromEnv) ? fromEnv : DEFAULT_LINK_BASE;
  return raw.replace(/\/+$/, '');
}

/** Путь → пара ссылок: схема приложения и https под текущим адресом. */
function build(path: string): { app: string; web: string } {
  return { app: `${APP_SCHEME}://${path}`, web: `${linkBase()}/${LINK_PATH_PREFIX}/${path}` };
}

/**
 * Ссылка, которую показывают человеку и кладут в буфер.
 *
 * Это https-форма: она открывается и у того, у кого приложения нет, — там его
 * встретит страница с предложением установить. Схема приложения остаётся для
 * внутренних переходов и для тех, кто вводит её руками.
 */
export type BuiltLink = { app: string; web: string };

export function buildDmLink(peerPubB64: string, msgId?: string): BuiltLink {
  const key = publicKeyFromB64(peerPubB64);
  const seg = key ? toBase64Url(publicKeyToB64(key)) : toBase64Url(peerPubB64);
  return build(msgId ? `dm/${seg}/msg/${encodeURIComponent(msgId)}` : `dm/${seg}`);
}

export function buildGroupLink(groupId: string, msgId?: string): BuiltLink {
  const g = encodeURIComponent(groupId);
  return build(msgId ? `group/${g}/msg/${encodeURIComponent(msgId)}` : `group/${g}`);
}

export function buildContactLink(peerPubB64OrDid: string): BuiltLink {
  const key = peerPubB64OrDid.startsWith('did:key:')
    ? parseDidKey(peerPubB64OrDid)
    : publicKeyFromB64(peerPubB64OrDid);
  const seg = key ? toBase64Url(publicKeyToB64(key)) : toBase64Url(peerPubB64OrDid);
  return build(`u/${seg}`);
}

export function buildPostLink(postId: string): BuiltLink {
  return build(`post/${encodeURIComponent(postId)}`);
}

/**
 * Ключ из отрезка пути в обычный base64 — тот вид, в котором ключ живёт
 * внутри приложения.
 *
 * Три записи принимаются намеренно: base64url собираем мы сейчас, обычный
 * base64 лежит в ссылках, скопированных прежними сборками, did:key человек
 * может вставить руками из QR.
 */
function decodePeerSegment(seg: string): string | null {
  if (!seg) return null;
  const key = seg.startsWith('did:key:') ? parseDidKey(seg) : publicKeyFromB64(seg);
  return key ? publicKeyToB64(key) : null;
}

/** Отрезок пути в исходный вид; кривая процент-запись — не наша ссылка. */
function decodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/**
 * Разбирает недоверенную строку. null — ссылка не наша либо не проходит по
 * форме; вызывающему остаётся не делать ничего.
 *
 * Принимаются `airchat://<путь>` и `https?://<любой хост>/l/<путь>`. Хост не
 * проверяется — см. решение 2 в шапке модуля.
 */
export function parseAppLink(raw: unknown): AppLink | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > APP_LINK_MAX) return null;

  let path: string;
  const lower = s.toLowerCase();
  if (lower.startsWith(`${APP_SCHEME}://`)) {
    path = s.slice(`${APP_SCHEME}://`.length);
  } else if (/^https?:\/\//i.test(s)) {
    const afterHost = s.slice(s.indexOf('://') + 3);
    const slash = afterHost.indexOf('/');
    if (slash < 0) return null;
    const rest = afterHost.slice(slash + 1);
    const prefix = `${LINK_PATH_PREFIX}/`;
    if (!rest.toLowerCase().startsWith(prefix)) return null;
    path = rest.slice(prefix.length);
  } else {
    return null;
  }

  path = path.split(/[?#]/)[0];
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > PARTS_MAX) return null;
  if (parts.some((p) => p.length > SEGMENT_MAX)) return null;

  const head = parts[0].toLowerCase();

  if (head === 'dm' && parts.length >= 2) {
    const peerPubB64 = decodePeerSegment(decodeSegment(parts[1]) ?? '');
    if (!peerPubB64) return null;
    if (parts.length === 2) return { kind: 'dm', peerPubB64 };
    if (parts.length === 4 && parts[2].toLowerCase() === 'msg') {
      const msgId = decodeSegment(parts[3]);
      return msgId ? { kind: 'dm', peerPubB64, msgId } : null;
    }
    return null;
  }

  if (head === 'group' && parts.length >= 2) {
    const groupId = decodeSegment(parts[1]);
    if (!groupId) return null;
    if (parts.length === 2) return { kind: 'group', groupId };
    if (parts.length === 4 && parts[2].toLowerCase() === 'msg') {
      const msgId = decodeSegment(parts[3]);
      return msgId ? { kind: 'group', groupId, msgId } : null;
    }
    return null;
  }

  // `contact` — форма, которую понимал parseContactId с 4.32.31; `u` короче и
  // собирается сейчас. Обе ведут в одно место.
  if ((head === 'u' || head === 'contact') && parts.length === 2) {
    const peerPubB64 = decodePeerSegment(decodeSegment(parts[1]) ?? '');
    return peerPubB64 ? { kind: 'contact', peerPubB64 } : null;
  }

  if (head === 'post' && parts.length === 2) {
    const postId = decodeSegment(parts[1]);
    return postId ? { kind: 'post', postId } : null;
  }

  if (head === 'join-group' && parts.length === 2) {
    const payload = decodeSegment(parts[1]);
    return payload ? { kind: 'joinGroup', payload } : null;
  }

  if (head === 'tab' && parts.length === 2) {
    const tab = decodeSegment(parts[1]);
    return tab ? { kind: 'tab', tab } : null;
  }

  return null;
}

/**
 * Готовая ссылка приложения — под текущим https-адресом.
 *
 * Для тех сборщиков, что отдают форму `airchat://…` и живут своей жизнью
 * (приглашение в группу собирается вместе со своей полезной нагрузкой). Чужая
 * строка возвращается как есть: превращать её во что-то — не дело этой
 * функции.
 */
export function webForm(appUrl: string): string {
  const head = `${APP_SCHEME}://`;
  if (!appUrl.toLowerCase().startsWith(head)) return appUrl;
  return `${linkBase()}/${LINK_PATH_PREFIX}/${appUrl.slice(head.length)}`;
}

/**
 * true — строку стоит открывать внутри приложения, а не в браузере.
 *
 * Нужно там, где ссылка встретилась в тексте сообщения: свою собственную
 * ссылку неправильно отдавать наружу.
 */
export function isAppLink(raw: unknown): boolean {
  return parseAppLink(raw) !== null;
}
