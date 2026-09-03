/**
 * copyGuard — «Запрет на копирование» для отдельной переписки (v4.32.568).
 *
 * Что это НЕ такое, и почему это написано первой строкой. Это не защита от
 * снимка экрана и не DRM: ни iOS, ни Android не дают приложению запретить
 * скриншот собеседнику так, чтобы на это можно было положиться, а на снимке
 * видно ровно то же, что и глазами. Обещать здесь «сообщения нельзя вынести»
 * значило бы соврать; от снимка в AirChat работает водяной знак, а не этот
 * переключатель.
 *
 * Что это такое: выключенный путь «скопировать текст» внутри приложения —
 * пункт «Копировать» в меню сообщения (и на iOS, и в нижнем меню Android),
 * кнопка копирования в панели выделения и копирование перевода. Это
 * ограничение по договорённости и удобству: оно мешает случайно вынести
 * переписку в буфер обмена и не мешает тому, кто этого хочет намеренно.
 * «Скопировать ссылку на сообщение» остаётся: ссылка — это адрес, а не текст.
 *
 * Флаг локальный и односторонний: он живёт у того, кто его включил, и
 * собеседнику не уходит. Хранится в профильном kv, а не в столбце таблицы
 * `conversations`: у контакта, с которым переписки ещё не было, строки в этой
 * таблице нет, а запретить копирование в его карточке человек может.
 */

import { scopedKvDelete, scopedKvGet, scopedKvSet } from '../storage/profileScopedKv';
import { log } from '../logger';

const PREFIX = 'copy_guard:';

/** Ключ профильного kv. Публичный ключ — уже base64 и в ключе безопасен. */
export function copyGuardKey(peerPubB64: string): string {
  return `${PREFIX}${peerPubB64}`;
}

/**
 * Слушатели держат экран диалога в согласии с карточкой профиля: переключить
 * запрет можно из карточки, открытой поверх этого же диалога.
 */
const listeners = new Set<(peerPubB64: string, on: boolean) => void>();

export function subscribeCopyGuard(cb: (peerPubB64: string, on: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export async function isCopyGuarded(peerPubB64: string): Promise<boolean> {
  try {
    return (await scopedKvGet(copyGuardKey(peerPubB64))) === '1';
  } catch (e) {
    // Сбой чтения — это «не знаем», а не «разрешено». Но и запирать переписку
    // из-за сорванного запроса нельзя: человек решит, что запрет включился
    // сам. Отвечаем «выключено» и пишем в журнал, чтобы причина была видна.
    log.warn('copy_guard_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function setCopyGuard(peerPubB64: string, on: boolean): Promise<void> {
  // Выключение стирает ключ, а не пишет '0': ключей ровно столько, сколько
  // переписок с включённым запретом.
  if (on) await scopedKvSet(copyGuardKey(peerPubB64), '1');
  else await scopedKvDelete(copyGuardKey(peerPubB64));
  for (const cb of listeners) {
    try {
      cb(peerPubB64, on);
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}
