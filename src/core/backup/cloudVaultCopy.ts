/**
 * Подсказка «отсюда уже отправляли копию в облако».
 *
 * v4.32.869. Архив в облаке зашифрован ключом из секретных слов И пароля
 * приложения (`deriveCloudKey`) — нужны оба. Значит, смена пароля запирает
 * копию ровно так же, как конверт у Apple ID, и об этом надо сказать в тот же
 * день: восстановление проверяется один раз, на новом телефоне, и отказ
 * `«Неверный облачный пароль или повреждённая копия»` там уже необратим.
 *
 * Сказать, однако, было не о чем: отметки «копия отправлена» не существовало
 * вовсе. Настройки показывали только «настроен ли сервер», а была ли копия —
 * не помнили. Здесь эта отметка и заводится, в трёх состояниях, как у
 * привязки к Apple ID: см. `security/appleBindingHint`.
 *
 * Как и там, подсказка — не источник истины: копия живёт на сервере, спросить
 * его без пароля нельзя. Поэтому всё незнакомое читается как «копии нет» —
 * выдумать копию опаснее, чем не показать существующую.
 */
import { log } from '../logger';
import type { StaleMark } from '../security/staleMark';
import { scopedKvSetChecked, scopedKvTryGet } from '../storage/profileScopedKv';

/** Ключ подсказки. Namespace профиля: копия у каждого аккаунта своя. */
export const CLOUD_VAULT_COPY_KEY = 'cloud_vault_copy_v1';

/** Что известно про копию в облаке с этого устройства. */
export type CloudVaultCopyHint = 'uploaded' | 'stale' | 'none';

/** Значение подсказки в хранилище. */
export const CLOUD_VAULT_COPY_STORED: Record<CloudVaultCopyHint, string> = {
  uploaded: '1',
  stale: 'stale',
  none: '0',
};

/** Разобрать запись из `kv`. Всё незнакомое — «копии нет». */
export function parseCloudVaultCopyHint(raw: string | null | undefined): CloudVaultCopyHint {
  if (raw === CLOUD_VAULT_COPY_STORED.uploaded) return 'uploaded';
  if (raw === CLOUD_VAULT_COPY_STORED.stale) return 'stale';
  return 'none';
}

/**
 * Пароль сменился — что стало с подсказкой.
 *
 * `null` — писать нечего: копии не было или её уже пометили. Второй раз пугать
 * человека тем же незачем.
 */
export function cloudCopyAfterPasswordChange(current: CloudVaultCopyHint): CloudVaultCopyHint | null {
  return current === 'uploaded' ? 'stale' : null;
}

/** Записать подсказку и честно сказать, легла ли она. Бросок гасится: копия к
 * этому моменту уже отправлена или уже заперта, и ронять на отметке работу,
 * которая сделана, нельзя. */
export async function storeCloudVaultCopy(hint: CloudVaultCopyHint): Promise<boolean> {
  try {
    return await scopedKvSetChecked(CLOUD_VAULT_COPY_KEY, CLOUD_VAULT_COPY_STORED[hint]);
  } catch (e) {
    log.warn('cloud_vault_copy_write_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Прочитать подсказку. `null` — прочитать не вышло: врать за хранилище не
 * будем, экран в этом случае не обещает ничего. */
export async function readCloudVaultCopy(): Promise<CloudVaultCopyHint | null> {
  try {
    // v4.32.977: `null` обещан докблоком, но прежнее чтение его не возвращало.
    // `scopedKvGet` отвечает тем же `null` и на отказ базы, и на пустую
    // ячейку, а `parseCloudVaultCopyHint` всё незнакомое читает как «копии
    // нет». Экран из-за этого показывал «копии нет» вместо молчания, а
    // `markCloudVaultCopyStale` отвечал `'not_bound'` вместо `'unknown'` —
    // то есть при занятой базе человек не слышал, что копия в облаке больше
    // не откроется новым паролем.
    const cell = await scopedKvTryGet(CLOUD_VAULT_COPY_KEY);
    if (!cell) {
      log.warn('cloud_vault_copy_unreadable', { key: CLOUD_VAULT_COPY_KEY });
      return null;
    }
    return parseCloudVaultCopyHint(cell.value);
  } catch (e) {
    log.warn('cloud_vault_copy_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Пометить копию устаревшей после смены пароля приложения. */
export async function markCloudVaultCopyStale(): Promise<StaleMark> {
  const current = await readCloudVaultCopy();
  if (current === null) return 'unknown';
  const next = cloudCopyAfterPasswordChange(current);
  if (!next) return 'not_bound';
  return (await storeCloudVaultCopy(next)) ? 'marked' : 'unwritten';
}

/** Что сказать человеку про запертую копию. Текст один на оба экрана. */
export const CLOUD_VAULT_STALE_TEXT = {
  marked: 'Копия в облаке больше не откроется новым паролем — отправьте её заново.',
  unwritten:
    'Копия в облаке больше не откроется новым паролем, а пометить её не удалось: после перезапуска настройки снова покажут, что копия есть. Отправьте её заново сейчас.',
} as const;
