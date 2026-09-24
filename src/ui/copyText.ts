/**
 * Копирование в буфер обмена — одно место (v4.32.883).
 *
 * До этого копировали двумя разными способами. Тринадцать мест — меню
 * сообщения, ссылка на сообщение, результаты опроса, адрес группы, QR
 * приглашения, выделение целиком — звали `Clipboard.setString` из
 * react-native: устаревший API, который в 0.83 ещё жив, но уже ругается в
 * журнал и обещает исчезнуть. Работает он синхронно и ничего не возвращает,
 * так что «Скопировано» показывалось строкой ниже — всегда, независимо от
 * того, легло в буфер хоть что-то или нет.
 *
 * Цена этой лжи выше обычной: человек закрывает экран, идёт вставлять — а
 * там прежнее содержимое буфера. Причём вставляет он обычно не туда, откуда
 * копировал, и вернуться за текстом уже сложнее, чем скопировать заново.
 *
 * Теперь один помощник на expo-clipboard, которым приложение и так уже
 * пользуется в профиле и в ленте: ждёт запись, показывает «Скопировано»
 * только после неё, а отказ называет отказом и пишет в журнал.
 */
import * as Clipboard from 'expo-clipboard';
import { log } from '../core/logger';
import { COPY_FAILED } from './clipboardText';
import { rawErrorText } from './components/userErrorText';
import { showError, showSuccess } from './components/userFeedback';

/**
 * Положить текст в буфер и сказать об этом правду.
 *
 * @param text что копируем
 * @param okText подтверждение для удавшегося копирования (см. clipboardText)
 * @returns легло ли в буфер — вызывающему это нужно редко, но снимать
 *   выделение по итогу отказа не стоит.
 */
export async function copyText(text: string, okText: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    showSuccess(okText);
    return true;
  } catch (e) {
    log.warn('clipboard_copy_failed', { err: rawErrorText(e) });
    showError(COPY_FAILED);
    return false;
  }
}
