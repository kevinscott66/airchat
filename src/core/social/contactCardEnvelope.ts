/**
 * contactCardEnvelope — чистый кодек карточки контакта ('\x05contact:').
 *
 * v4.32.239. Разбор жил прямо в ChatScreen.tsx и состоял из одного
 * JSON.parse без единой проверки формы:
 *
 *   return JSON.parse(text.slice(PREFIX.length)) as { name: string; pub: string };
 *
 * Приведение типа здесь ничего не гарантирует — данные пришли от чужого
 * клиента. Достаточно было прислать '\x05contact:123', чтобы parse вернул
 * число: обе карточки (в личном чате и в группе) тут же делают
 * `card.pub.slice(0, 12)`, а это TypeError прямо в render. Падал не один
 * пузырь, а весь экран переписки — и чинить было нечем, потому что удалить
 * сообщение можно только открыв тот самый чат, который падает при открытии.
 *
 * Плюс сама карточка — это предложение сохранить ЧУЖОЙ ключ себе в контакты.
 * Значит, ключ обязан быть настоящим ключом (32 байта в base64), а не
 * произвольной строкой, и имя обязано пройти ту же вычистку, что и все
 * остальные имена из сети: сохранённое имя контакта потом подставляется в
 * заголовки, пересылки и системные строки (см. sysLineGuard).
 *
 * Модуль без импортов, кроме таких же чистых sysLineGuard и envelopeBody:
 * разбор недоверенного ввода тестируется без React, SQLite и транспорта.
 */

import { readEnvelopeBody } from './envelopeBody';
import { sanitizeDisplayName } from './sysLineGuard';

export const CONTACT_CARD_PREFIX = '\x05contact:';

export type ContactCard = { name: string; pub: string };

/**
 * base64 ровно 32 байт Ed25519-ключа: 43 символа без паддинга либо 44 с ним.
 * Проверка по алфавиту нужна, чтобы мусор не доехал до Buffer.from, который
 * молча съедает недопустимые символы и возвращает ключ неправильной длины.
 */
const PUB_B64 = /^[A-Za-z0-9+/]{43}=?$/;

export function isContactCard(text: string): boolean {
  return text.startsWith(CONTACT_CARD_PREFIX);
}

export function makeContactCardText(name: string, pub: string): string {
  return `${CONTACT_CARD_PREFIX}${JSON.stringify({ name, pub })}`;
}

/**
 * Разбирает карточку контакта. null — не карточка либо мусор от чужого
 * клиента; вызывающий в этом случае показывает сообщение как обычный текст.
 */
export function parseContactCard(text: string): ContactCard | null {
  // Карточка — это имя и ключ; килобайта хватает с большим запасом.
  const raw = readEnvelopeBody(text, CONTACT_CARD_PREFIX, 1024);
  if (!raw) return null;
  const { name, pub } = raw;
  if (typeof pub !== 'string' || !PUB_B64.test(pub)) return null;
  // Имя пустым быть может — экран сам подставит «Контакт».
  const safeName = sanitizeDisplayName(name) ?? '';
  return { name: safeName, pub };
}
