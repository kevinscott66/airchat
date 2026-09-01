/**
 * storyEnvelope — чистый кодек конверта сторис.
 *
 * v4.32.246. До этой версии сторис рассылались через IPFS pubsub, а IPFS на
 * телефоне выключен с v4.32.19 (см. heliaNode.isIpfsEnabled): pubsubPublish
 * возвращал false, pubsubSubscribe — null. То есть опубликованная сторис не
 * уходила никуда и ни одна чужая не приходила — функция была декорацией.
 * Тем же путём, что лента (feedTransport) и управляющие конверты группы,
 * сторис теперь ездят как обычный зашифрованный DM с управляющим префиксом.
 *
 * Модуль без тяжёлых импортов: разбор недоверенного ввода нужно уметь
 * тестировать без SQLite и транспорта.
 *
 * '\x13' — первый свободный управляющий байт ('\x0f' занят реакциями,
 * '\x10' — закреплением в личке, '\x11' — таймером исчезновения,
 * '\x12' — настройками присутствия).
 */

import { readEnvelopeBody } from './envelopeBody';
import { isSafeMediaCid } from '../media/mediaCidPolicy';
import { sanitizeParagraphText } from './sysLineGuard';

export const STORY_PREFIX = '\x13story:';

/** Сторис живёт сутки. Дублируется в storage/local как STORY_TTL_MS. */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;

/** Запас на расхождение часов между устройствами. */
const CLOCK_SKEW_MS = 5 * 60_000;

export type StoryEnvelope = {
  id: string;
  authorPubB64: string;
  authorDid: string;
  mediaCid: string | null;
  mediaType: 'image' | 'video';
  text: string | null;
  expiresAt: number;
  createdAt: number;
};

export function encodeStoryEnvelope(env: StoryEnvelope): string {
  return STORY_PREFIX + JSON.stringify(env);
}

/**
 * Разбирает и валидирует конверт сторис. null — не наш конверт либо мусор.
 *
 * `now` параметром, а не Date.now() внутри: время участвует в проверке срока
 * жизни, и тест должен уметь его задать.
 */
export function decodeStoryEnvelope(text: string, now: number): StoryEnvelope | null {
  // Медиа ездит отдельно (CID или nb:-дескриптор), поэтому сам конверт — пара
  // килобайт. 64 КБ — потолок DM-транспорта, дальше разбирать нечего.
  const env = readEnvelopeBody<StoryEnvelope>(text, STORY_PREFIX, 64 * 1024);
  if (!env) return null;
  if (typeof env.id !== 'string' || !env.id || env.id.length > 128) return null;
  // base64 Ed25519-ключ — 43–48 символов в зависимости от паддинга.
  if (typeof env.authorPubB64 !== 'string' || env.authorPubB64.length < 43 || env.authorPubB64.length > 48) return null;
  if (typeof env.authorDid !== 'string' || !env.authorDid || env.authorDid.length > 256) return null;
  if (typeof env.expiresAt !== 'number' || !Number.isFinite(env.expiresAt)) return null;
  // Просроченную сторис не сохраняем, «вечную» — тоже: expiresAt в далёком
  // будущем закрепил бы её в ленте навсегда.
  if (env.expiresAt <= now || env.expiresAt > now + STORY_TTL_MS + CLOCK_SKEW_MS) return null;
  if (typeof env.createdAt !== 'number' || !Number.isFinite(env.createdAt)) return null;
  // Время создания задаёт порядок в ленте: 9e15 держал бы сторис первой всегда,
  // большое отрицательное — прятало бы её в конце.
  env.createdAt = Math.min(Math.max(env.createdAt, now - STORY_TTL_MS), now + CLOCK_SKEW_MS);
  if (env.text != null) {
    if (typeof env.text !== 'string') return null;
    // v4.32.373: раньше здесь стояла одна обрезка по длине. Текст сторис
    // рисуется обычным <Text> — и в полный экран, и подписью поверх картинки,
    // — то есть мимо FormattedText, который чистит тело сообщения. U+202E
    // разворачивал в нём текст, управляющие символы доезжали как есть, а
    // четыре тысячи переводов строки растягивали подпись на весь экран.
    env.text = sanitizeParagraphText(env.text, 4096);
  } else {
    env.text = null;
  }
  if (env.mediaCid != null) {
    // Медиа сторис грузится САМО при открытии — «CID» с подставленным адресом
    // выдал бы IP получателя (тот же класс маяка, что и предпросмотр ссылок).
    if (!isSafeMediaCid(env.mediaCid)) return null;
  } else {
    env.mediaCid = null;
  }
  env.mediaType = env.mediaType === 'video' ? 'video' : 'image';
  // Показывать нечего: ни картинки, ни текста. До v4.32.373 такая сторис
  // сохранялась и занимала место в ленте пустым чёрным экраном — открыть её
  // можно, закрыть можно, а что это было, непонятно.
  if (env.text == null && env.mediaCid == null) return null;
  return env;
}
