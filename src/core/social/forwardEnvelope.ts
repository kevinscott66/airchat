/**
 * forwardEnvelope — чистый кодек пересылки ('\x08fwd:Имя\nТекст').
 *
 * v4.32.240. Кодек жил в ChatScreen.tsx четырьмя строчками без единой
 * проверки, и из-за этого пересылка ломалась тремя разными способами.
 *
 * 1. Пересылка мультимедиа отправляла сырой конверт. makeForwardText брала
 *    m.text как есть, а текст голосового — это
 *    '\x01voice:{"uri":"file:///data/user/0/com.anonymous.airchat/cache/…"}'.
 *    Разбор на стороне получателя дробит строку по первому \n и отдаёт
 *    остаток в обычный текстовый пузырь — то есть собеседник видел JSON с
 *    локальным путём на устройстве отправителя. Ни проиграть, ни скачать
 *    такое нельзя (mediaCids при пересылке не копируются), зато путь к
 *    файловой песочнице уезжает наружу.
 *
 * 2. Пересылка нескольких сообщений склеивала конверты через '\n\n'.
 *    parseForwardedMessage режет по ПЕРВОМУ переводу строки, поэтому весь
 *    хвост — включая байты '\x08fwd:' следующих сообщений — попадал в
 *    originalText одной пересылки и рисовался как текст.
 *
 * 3. Имя отправителя не ограничивалось и не вычищалось. Перевод строки в
 *    имени сдвигает точку разреза: '\x08fwd:Аня\nПривет' + текст «X» даёт
 *    ровно ту же строку, что и пересылка от «Аня» с текстом «Привет\nX».
 *    То есть чужое имя дописывало пересылке содержимое (та же дверь, что
 *    закрыли в sysLineGuard для системных строк).
 *
 * Модуль без импортов, кроме таких же чистых messagePreview и sysLineGuard:
 * разбор недоверенного ввода проверяется тестами без React и транспорта.
 */

import { previewLabelForText } from './messagePreview';
import { sanitizeDisplayName } from './sysLineGuard';

/** Формат: FORWARD_PREFIX + имя отправителя + '\n' + исходный текст. */
export const FORWARD_PREFIX = '\x08fwd:';

/** Заголовок пересылки — одна строка в пузыре, длинное имя там не нужно. */
export const MAX_FORWARD_NAME = 64;

/**
 * Конверты, тело которых — машинные данные: локальные пути, CID, ключи,
 * координаты, служебный JSON. Пересылать их «как есть» бессмысленно
 * (получатель всё равно не сможет открыть чужой file:// и не получит
 * mediaCids) и вредно, поэтому в пересылку едет подпись вида
 * «🎤 Голосовое сообщение».
 *
 * '\x09vo:' (одноразовое) сюда НЕ входит: его тело — обычный текст, и
 * экран сам снимает префикс при отрисовке.
 */
const MACHINE_PREFIXES = [
  '\x01voice:',
  '\x02', // сообщение группы
  '\x03', // отметка о прочтении
  '\x04poll:',
  '\x05contact:',
  '\x06doc:',
  '\x07loc:',
  // Байт 0x0a — это сам перевод строки, поэтому здесь только полные
  // префиксы: голое '\x0a' совпало бы с обычным текстом, начатым с новой
  // строки.
  '\x0agif:',
  '\x0agjr:',
  '\x0bsys:', // системная строка — в пересылку едет её человеческий текст
  '\x0cliveloc:',
  '\x0e', // ctl
  '\x0f', // реакция
  '\x10', // закрепление
  '\x11', // таймер исчезновения
  '\x12', // presence
  // v4.32.250: строки от этих конвертов в переписке не появляются, но список
  // служебных байтов должен быть полным — иначе пересылка старой строки,
  // осевшей до появления защиты, ушла бы собеседнику сырым JSON.
  '\x13', // сторис
  '\x14', // профиль
  '\x15', // голос в опросе
];

export function isForwardedMessage(text: string): boolean {
  return text.startsWith(FORWARD_PREFIX);
}

/**
 * Тело сообщения в том виде, в каком его можно переслать текстом.
 * Обычный текст — как есть, конверт — подписью.
 */
function forwardableBody(text: string): string {
  return MACHINE_PREFIXES.some((p) => text.startsWith(p)) ? previewLabelForText(text) : text;
}

/**
 * Собирает пересылку одного сообщения.
 *
 * Пересылка пересылки разворачивается: получателя интересует первоначальный
 * автор, а не цепочка посредников (и вложенный '\x08fwd:' в теле всё равно
 * не разобрался бы — разбор смотрит только на начало строки).
 */
export function makeForwardText(senderName: string, originalText: string): string {
  const inner = parseForwardedMessage(originalText);
  if (inner) return `${FORWARD_PREFIX}${inner.senderName}\n${inner.originalText}`;
  const name = sanitizeDisplayName(senderName, MAX_FORWARD_NAME) ?? '';
  return `${FORWARD_PREFIX}${name}\n${forwardableBody(originalText)}`;
}

/**
 * Собирает пересылку нескольких сообщений в ОДИН конверт: заголовок без
 * имени («Переслано») и по строке «Имя: текст» на сообщение. Склеивать
 * несколько конвертов нельзя — разбор видит только первый.
 */
export function makeForwardBundleText(items: Array<{ senderName: string; text: string }>): string {
  if (items.length === 0) return '';
  if (items.length === 1) return makeForwardText(items[0].senderName, items[0].text);
  const body = items
    .map((it) => {
      const inner = parseForwardedMessage(it.text);
      const name = sanitizeDisplayName(inner ? inner.senderName : it.senderName, MAX_FORWARD_NAME) ?? '';
      const text = inner ? inner.originalText : forwardableBody(it.text);
      return name ? `${name}: ${text}` : text;
    })
    .join('\n');
  return `${FORWARD_PREFIX}\n${body}`;
}

/**
 * Разбирает пересылку. null — это не пересылка.
 *
 * Вычистка имени и подмена машинного тела повторяются здесь, а не только в
 * makeForwardText: строку собирает клиент собеседника, и он может быть
 * старой версией — или недоброжелателем, который собрал её вручную.
 */
export function parseForwardedMessage(text: string): { senderName: string; originalText: string } | null {
  if (!text.startsWith(FORWARD_PREFIX)) return null;
  const rest = text.slice(FORWARD_PREFIX.length);
  const nl = rest.indexOf('\n');
  if (nl < 0) return { senderName: '', originalText: forwardableBody(rest) };
  return {
    senderName: sanitizeDisplayName(rest.slice(0, nl), MAX_FORWARD_NAME) ?? '',
    originalText: forwardableBody(rest.slice(nl + 1)),
  };
}
