/**
 * После импорта seed: локальный файл резервной копии диалогов (если был) + синхронизация с сетью.
 */
import { log } from '../logger';
import { tryRestoreDialogBackupFromFile } from '../storage/dialogBackup';
import { runSyncIfOnline } from '../storage/sync';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Два независимых источника переписки: файл на устройстве и релей.
 *
 * v4.32.351: раньше оба шага стояли под одним try. Любой сбой локального
 * восстановления — заблокированный keystore, занятая SQLite сразу после смены
 * ключа, недоступный файл — уводил выполнение в catch, и runSyncIfOnline даже
 * не вызывался. Пользователь импортировал seed и не получал НИЧЕГО: ни
 * локальную копию, ни то, что лежит на релее. Из двух источников терялись оба,
 * причём молча — в журнале оставалась одна строка про неудачу.
 *
 * Теперь у каждого шага свой обработчик: провал одного не отменяет второй.
 * Наружу по-прежнему не бросается ничего — вызывающий код в App.tsx стоит на
 * пути импорта кошелька, и падать там нельзя.
 */
export async function restoreChatsAfterWalletImport(): Promise<void> {
  log.info('chat_restore_after_import_start');

  let messages = 0;
  let localOk = true;
  try {
    messages = await tryRestoreDialogBackupFromFile();
    if (messages > 0) log.info('chat_restore_local_file', { messages });
  } catch (e) {
    localOk = false;
    log.warn('chat_restore_local_file_failed', { err: errText(e) });
  }

  let syncOk = true;
  try {
    await runSyncIfOnline();
  } catch (e) {
    syncOk = false;
    log.warn('chat_restore_sync_failed', { err: errText(e) });
  }

  log.info('chat_restore_after_import_done', { messages, localOk, syncOk });
}
