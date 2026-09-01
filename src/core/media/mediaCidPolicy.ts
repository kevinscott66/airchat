import { isPlainCid } from '../cid';
import { isNbCid, parseNbCid } from './blobRef';

/**
 * Разбор списка mediaCids, пришедшего от собеседника.
 *
 * Допустимы две формы: обычный IPFS-CID (по нему собирается адрес шлюза) и
 * `nb:`-дескриптор зашифрованного вложения. Всё остальное отбрасывается: в
 * слот CID можно положить `../` и увести загрузку картинки на чужой сервер —
 * то есть выдать IP-адрес получателя и время открытия чата.
 *
 * v4.32.244: раньше `nb:` здесь отбрасывался, поэтому фотография в группе не
 * доезжала ни до кого — единственный рабочий без IPFS путь не проходил
 * проверку на приёме.
 */

/** Разумный потолок: в живом сообщении их ≤ 10; остальное — попытка раздуть
 *  строку в SQLite и список в интерфейсе. */
export const MAX_MEDIA_CIDS = 32;

/**
 * Разбор колонки media_cids из базы.
 *
 * Формат исторически разъехался: входящие сообщения сохранялись как JSON-массив,
 * свои — строкой через запятую, а читатели брали то одно, то другое. Из-за этого
 * фотография в группе не показывалась у получателя даже с IPFS: строка
 * `["Qm…","Qm…"]`, разрезанная по запятой, давала куски со скобками и кавычками,
 * и ни один из них не был похож на CID.
 *
 * Понимаем оба формата. JSON пробуем первым: `nb:`-дескриптор сам содержит
 * запятые, и резать его нельзя.
 */
export function parseMediaCidsColumn(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((c): c is string => typeof c === 'string' && c.length > 0);
    } catch { /* испорченный JSON — ниже попробуем как список через запятую */ }
  }
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

/** Строковое представление для колонки media_cids — единое на запись. */
export function serializeMediaCids(cids: string[]): string {
  return JSON.stringify(cids);
}

/**
 * Годится ли одиночная строка на роль ссылки на медиа.
 *
 * Нужна там, где CID приходит не списком: аватар группы в управляющем конверте.
 * Проверка та же, что и для элемента списка, — «CID» вида `../../evil.example`
 * уводит загрузку картинки на чужой сервер (см. core/media/gatewayUrl).
 */
export function isSafeMediaCid(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return isNbCid(v) ? parseNbCid(v) !== null : isPlainCid(v);
}

export function sanitizeMediaCids(input: unknown, max: number = MAX_MEDIA_CIDS): string[] {
  if (!Array.isArray(input)) return [];
  // Обрезаем ДО фильтра: иначе на 10 000 валидных по форме элементов уйдёт
  // 10 000 разборов JSON.
  return input.slice(0, max).filter(isSafeMediaCid);
}
