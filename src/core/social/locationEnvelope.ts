/**
 * locationEnvelope — конверты места '\x07loc:' и живой геолокации '\x0cliveloc:'.
 *
 * v4.32.241. Оба конверта уже проверяли координаты и время: чужой клиент не
 * мог прислать нечисловую широту (подстановка в адрес карты) или expireAt на
 * сто лет вперёд (пузырь навсегда остаётся «живым»). А подпись места — label —
 * проверялась только по длине.
 *
 * Подпись рисуется заголовком пузыря вместо слова «Геолокация», одной
 * строкой и жирным. Управляющие символы и невидимые метки направления письма
 * из неё не вычищались, поэтому чужая подпись показывалась как угодно — тем
 * же приёмом, каким подделывали системные строки и расширения файлов
 * (см. sysLineGuard и docEnvelope). Теперь подпись проходит общую чистку.
 *
 * Разбор вынесен из liveLocationService: тот тянет uuid, expo-location и
 * профили, и проверить недоверенный ввод отдельно от них было нельзя.
 */

import { readEnvelopeBody } from './envelopeBody';
import { sanitizeDisplayName } from './sysLineGuard';

export const LOCATION_PREFIX = '\x07loc:';
export const LIVELOC_PREFIX = '\x0cliveloc:';

/** Подпись места: столько символов хватает на полный адрес. */
export const MAX_LOCATION_LABEL = 128;

/**
 * Потолок всей строки до JSON.parse (v4.32.380). Оба конверта — две-три пары
 * координат, время, идентификатор до 128 символов и подпись до 128: настоящий
 * не дотягивает и до килобайта.
 */
export const MAX_LOCATION_ENVELOPE = 2048;

/** Живая геолокация живёт максимум 8 часов; минута назад — допуск на расхождение часов. */
export const LIVELOC_MAX_AHEAD_MS = 8 * 60 * 60_000;
export const LIVELOC_MAX_SKEW_MS = 60_000;

export type LiveLocPayload = {
  lat: number;
  lon: number;
  expireAt: number;
  liveId: string;
  label?: string;
  /**
   * v4.32.563: время отправки этой посылки. По нему получатель видит, что
   * рассылка замерла (liveLocFreshness). Поле необязательное: старый
   * отправитель его не кладёт, и придумывать за него возраст точки нельзя.
   */
  ts?: number;
};

/** Чистит подпись места. Пустая строка — пузырь покажет слово «Геолокация». */
export function sanitizeLocationLabel(v: unknown): string {
  return (sanitizeDisplayName(v, MAX_LOCATION_LABEL) ?? '').replace(/\s+/g, ' ').trim();
}

function isLatitude(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90;
}

function isLongitude(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180;
}

export function isLocationMessage(text: string): boolean {
  return text.startsWith(LOCATION_PREFIX);
}

export function makeLocationText(lat: number, lon: number, label?: string): string {
  return `${LOCATION_PREFIX}${JSON.stringify({ lat, lon, label: label ?? '' })}`;
}

export function parseLocationMeta(text: string): { lat: number; lon: number; label: string } | null {
  // v4.32.190 (Round-20 #1): строгая форма — иначе meta.lat.toFixed роняет
  // пузырь, а значащие для адреса символы уезжают в ссылку OpenStreetMap
  // через Linking.openURL.
  const o = readEnvelopeBody(text, LOCATION_PREFIX, MAX_LOCATION_ENVELOPE);
  if (!o) return null;
  if (!isLatitude(o.lat) || !isLongitude(o.lon)) return null;
  return { lat: o.lat, lon: o.lon, label: sanitizeLocationLabel(o.label) };
}

export function isLiveLocMessage(text: string): boolean {
  return text.startsWith(LIVELOC_PREFIX);
}

export function makeLiveLocText(payload: Omit<LiveLocPayload, 'liveId'> & { liveId: string }): string {
  return `${LIVELOC_PREFIX}${JSON.stringify(payload)}`;
}

export function parseLiveLoc(text: string, now: number = Date.now()): LiveLocPayload | null {
  // v4.32.184 (Round-14 #9): строгая форма — нечисловые координаты уезжали в
  // ссылку карты, нечисловой expireAt оставлял Math.max в NaN и пузырь
  // навсегда «живым».
  const o = readEnvelopeBody(text, LIVELOC_PREFIX, MAX_LOCATION_ENVELOPE);
  if (!o) return null;
  if (!isLatitude(o.lat) || !isLongitude(o.lon)) return null;
  if (typeof o.expireAt !== 'number' || !isFinite(o.expireAt)) return null;
  // v4.32.197 (Round-27 #4): ограничение срока — иначе expireAt=9e15
  // закрепляет метку «LIVE» навсегда.
  //
  // v4.32.563: граница осталась только верхней. Нижняя отвергала посылку,
  // чей срок прошёл больше минуты назад, то есть ровно ЗАКОНЧИВШУЮСЯ сессию —
  // ту самую, для которой в пузыре написана ветка «Геолокация завершена».
  // Ветка была недостижима: в переписке пузырь схлопывался в пустоту, а в
  // группе на экран выпадал сырой конверт с JSON. Прошедший срок — не
  // подделка, а обычный конец сессии, и показывать его надо концом.
  if (o.expireAt > now + LIVELOC_MAX_AHEAD_MS) return null;
  if (typeof o.liveId !== 'string' || o.liveId.length === 0 || o.liveId.length > 128) return null;
  const out: LiveLocPayload = { lat: o.lat, lon: o.lon, expireAt: o.expireAt, liveId: o.liveId };
  // Время отправки принимается только не из будущего: посылка с ts на год
  // вперёд означала бы вечно «свежую» точку — тот же приём, что и expireAt
  // на сто лет. Слишком старое время не отбрасывается: оно честно означает,
  // что рассылка замерла.
  if (typeof o.ts === 'number' && isFinite(o.ts) && o.ts <= now + LIVELOC_MAX_SKEW_MS) out.ts = o.ts;
  const label = sanitizeLocationLabel(o.label);
  if (label) out.label = label;
  return out;
}
