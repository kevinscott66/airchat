/**
 * searchableText — текст сообщения, каким его реально видит человек.
 *
 * Поиск (и в чате, и глобальный) до v4.32.239 сравнивал запрос с сырым
 * содержимым колонки `text`, а туда попадает вся служебная нагрузка:
 *
 *   '\x01voice:<blobRef JSON>'      — запрос «voice» подсвечивал каждое
 *                                     голосовое, хотя слова там не видно;
 *   '\x06doc:{"name":…,"cid":…}'    — «cid», «size», «name» находили любой файл;
 *   '\x07loc:{"lat":…}'             — «lat» находил каждую геометку;
 *   '\x0agif:https://…'             — «http» находил все GIF;
 *   '\x0bsys:текст'                 — «sys» находил каждую системную строку.
 *
 * То есть частые технические подстроки давали десятки ложных попаданий, а
 * пользователь прыгал к сообщению, в котором запроса не видно нигде. Здесь
 * из каждого конверта достаётся ровно то, что нарисовано на экране: вопрос и
 * варианты опроса, имя контакта, имя файла, подпись геометки, текст системной
 * строки. Из чего ничего не видно — из того и искать нечего.
 *
 * Модуль намеренно не тянет транспорт: его дёргает и `local.ts` (хранилище), и
 * экраны, а `messaging.ts` тянет за собой весь ESM-стек helia и ломает jest.
 * Префиксы продублированы по той же причине — они часть протокола и не
 * меняются (полная карта — в messagePreview.ts). Исключение — системный
 * префикс: он приходит из sysLineGuard, такого же модуля без импортов
 * (v4.32.263).
 */

import { SYS_LINE_PREFIX } from './sysLineGuard';

const VOICE = '\x01voice:';
const POLL = '\x04poll:';
const CONTACT = '\x05contact:';
const DOC = '\x06doc:';
const LOC = '\x07loc:';
const FWD = '\x08fwd:';
const VIEW_ONCE = '\x09vo:';
const GIF = '\x0agif:';
const SYS = SYS_LINE_PREFIX;
const LIVELOC = '\x0cliveloc:';

/**
 * Конверты, у которых на экране нет ни одного слова из полезной нагрузки.
 *
 * v4.32.250: дописаны '\x13' (сторис), '\x14' (профиль) и '\x15' (голос в
 * опросе). Приём этих конвертов строку в переписке не создаёт, так что в
 * индекс им попадать неоткуда, — но список должен покрывать все служебные
 * байты, иначе строка, осевшая до появления защиты, ищется по сырому JSON.
 */
const OPAQUE = [VOICE, GIF, LIVELOC, '\x02', '\x03', '\x0e', '\x0f', '\x10', '\x11', '\x12', '\x13', '\x14', '\x15'];

/** Достаёт строковое поле JSON-нагрузки, не падая на мусоре от чужого клиента. */
function jsonFields(payload: string, keys: string[]): string {
  try {
    const p: unknown = JSON.parse(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return '';
    const o = p as Record<string, unknown>;
    const out: string[] = [];
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    }
    return out.join(' ');
  } catch {
    return '';
  }
}

/**
 * Возвращает видимый текст сообщения для поиска. Пустая строка означает
 * «искать здесь нечего» — такое сообщение в результаты не попадает никогда.
 */
export function searchableText(text: string): string {
  if (!text) return '';

  // Одноразовое сообщение сознательно исключено целиком: его подпись
  // показывается один раз и стирается, и находить её поиском через месяц —
  // ровно то, от чего режим защищает.
  if (text.startsWith(VIEW_ONCE)) return '';

  if (text.startsWith(SYS)) return text.slice(SYS.length);

  if (text.startsWith(FWD)) {
    // Имя исходного отправителя видно в шапке пересылки, поэтому ищется тоже.
    const rest = text.slice(FWD.length);
    const nl = rest.indexOf('\n');
    if (nl < 0) return rest;
    return `${rest.slice(0, nl)} ${searchableText(rest.slice(nl + 1))}`.trim();
  }

  if (text.startsWith(POLL)) return jsonFields(text.slice(POLL.length), ['question', 'options']);
  if (text.startsWith(CONTACT)) return jsonFields(text.slice(CONTACT.length), ['name']);
  if (text.startsWith(DOC)) return jsonFields(text.slice(DOC.length), ['name']);
  if (text.startsWith(LOC)) return jsonFields(text.slice(LOC.length), ['label']);

  if (OPAQUE.some((p) => text.startsWith(p))) return '';

  return text;
}

/** Совпадает ли сообщение с уже приведённым к нижнему регистру запросом. */
export function matchesSearch(text: string, needleLower: string): boolean {
  if (!needleLower) return false;
  const hay = searchableText(text);
  return hay.length > 0 && hay.toLowerCase().includes(needleLower);
}
