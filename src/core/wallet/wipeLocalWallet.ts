/**
 * Полный сброс активного кошелька: seed, ключи, DEK, SQLite, профили.
 * Локальные копии удаляются вместе с базой; сеть/IPFS не трогаем — только
 * данные на этом устройстве.
 */
import * as SecureStore from '../storage/secureStoreQueued';
import {
  SEED_SECURE_KEYS,
  SESSION_SECURE_KEYS,
  wipeMnemonicAndSessionFlags,
} from '../backup/seedPhrase';
import { KEYPAIR_SECURE_KEYS, deleteKeyPairFromStore } from '../crypto/keyManager';
import { log } from '../logger';
import { profileManager } from '../identity/profileManager';
import { disposeMessagingService } from '../social/messaging';
import { disposeCallService } from '../social/callService';
import { stopFeedInboxListener } from '../social/feedService';
import { stopPresenceBroadcast } from '../social/presenceService';
import { disposePushNotificationService } from '../../notifications/pushNotifications';
import { rateLimiter } from '../security/rateLimiter';
import { closeLocalDatabase, wipeLocalDatabase } from '../storage/local';
import { deleteAllFeedDbs } from '../storage/feedStorage';
import { closeFeedStorage } from '../social/feedService';
import { PROFILE_STATE_KEY } from '../identity/profileStateKey';
import { purgeSensitiveCache } from '../media/cacheFiles';
import { clearSecretClipboardNow } from '../security/clipboardSecret';
import { sweepAvatarFiles } from '../media/avatarFiles';
import { clearDekMemory, DEK_KEY } from '../storage/localEncryption';
import { resetIpfsClient } from '../transport/ipfs/node';
import { AUTH_SECURE_KEYS, authGuard } from '../security/authGuard';
import { cancelScheduledDialogBackup, deleteAllDialogBackups } from '../storage/dialogBackup';
import { SYNC_DEVICE_SECURE_KEYS, clearSyncDeviceCredentials } from '../sync/syncApi';

const FCM_TOKEN_KEY = 'airchat_fcm_token_v1';

/**
 * Всё, что после сброса не имеет права остаться в SecureStore.
 *
 * Списки берутся у владельцев данных, а не переписываются здесь: иначе при
 * добавлении нового ключа проверка молча перестала бы его замечать — то есть
 * именно тогда, когда она нужнее всего.
 */
const SECRET_KEYS: readonly string[] = [
  ...SEED_SECURE_KEYS,
  ...SESSION_SECURE_KEYS,
  ...KEYPAIR_SECURE_KEYS,
  ...AUTH_SECURE_KEYS,
  ...SYNC_DEVICE_SECURE_KEYS,
  PROFILE_STATE_KEY,
  DEK_KEY,
  FCM_TOKEN_KEY,
];

export type WalletWipeResult = {
  /** Ни один секрет не пережил сброс. Единственный признак, по которому можно говорить «данные удалены». */
  ok: boolean;
  /** Шаги, упавшие по дороге. Сброс продолжается несмотря на них. */
  failedSteps: string[];
  /** Ключи SecureStore, оставшиеся на устройстве после двух попыток удаления. */
  survivors: string[];
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Шаг сброса, который не имеет права отменить остальные.
 *
 * v4.32.353: до этого раунда половина шагов стояла без try — в том числе
 * удаление seed, ключей и базы. Падение любого из них прерывало функцию, и
 * дальше не выполнялось НИЧЕГО: пользователь нажал «удалить данные на
 * устройстве», получил сообщение об ошибке — и остался с нетронутой
 * сид-фразой, ключом и всей перепиской на диске.
 */
async function step(name: string, fn: () => unknown, failed: string[]): Promise<void> {
  try {
    await fn();
  } catch (e) {
    failed.push(name);
    log.warn('wallet_wipe_step_failed', { step: name, err: errText(e) });
  }
}

/**
 * Какие секреты пережили удаление.
 *
 * Нужна потому, что «вызвали удаление» и «удалено» — разные утверждения:
 * deleteKeyPairFromStore, wipeMnemonicAndSessionFlags и clearAllAuthData
 * глотают ошибки SecureStore каждый у себя, по одному ключу за раз. Это
 * оправдано (сбой на одном ключе не должен ронять остальные), но означает, что
 * без чтения назад успех сброса ничем не подтверждён.
 *
 * Ключ, который не удалось ПРОЧИТАТЬ, считается выжившим. Ошибка чтения почти
 * наверняка значит, что и удаление не прошло, а из двух неверных ответов
 * «возможно, осталось» безопаснее, чем «точно удалено».
 */
async function survivingSecrets(): Promise<string[]> {
  const left: string[] = [];
  for (const key of SECRET_KEYS) {
    try {
      if ((await SecureStore.getItemAsync(key)) !== null) left.push(key);
    } catch (e) {
      log.warn('wallet_wipe_verify_read_failed', { key, err: errText(e) });
      left.push(key);
    }
  }
  return left;
}

/**
 * Что при сбросе НЕ удаляем намеренно:
 *  - `airchat-config.json` — настройки устройства (адрес релея), к личности
 *    отношения не имеют и переживают смену владельца осмысленно.
 *
 * Наружу не бросает: прерванный на середине сброс — худший из исходов, а
 * вызывающему нужен не стектрейс, а ответ на вопрос «данные точно удалены?».
 * Он в возвращаемом WalletWipeResult.
 */
export async function performLocalWalletWipe(): Promise<WalletWipeResult> {
  log.info('wallet_wipe_start');
  const failed: string[] = [];
  await step('cancel_dialog_backup', () => cancelScheduledDialogBackup(), failed);
  await step('auth_data', () => authGuard.clearAllAuthData(), failed);
  await step('feed_inbox_listener', () => stopFeedInboxListener(), failed);
  // v4.32.174: presence heartbeat держал интервал-таймер + pubsub подписку, после
  // wipe они продолжали палить ключом следующего владельца устройства.
  await step('presence_broadcast', () => stopPresenceBroadcast(), failed);
  // v4.32.176: диспозим push-сервис (onMessage/onTokenRefresh listeners
  // оставались привязаны к старой identity) + сбрасываем in-memory блок-лист
  // чтобы следующий владелец устройства не унаследовал blocked контакты.
  await step('push_service', () => disposePushNotificationService(), failed);
  await step('rate_limiter', () => rateLimiter.resetForProfileSwitch(), failed);
  await step('live_account_sync', async () => {
    const { cancelLiveAccountSync } = await import('../sync/liveAccountSync');
    cancelLiveAccountSync();
  }, failed);
  // v4.32.192 (Round-22 #8): dispose story inbox sub, live-location intervals
  // and scheduler poll — these keep firing with the old identity's KeyPair
  // between wipe() and app restart. Mirrors stopFeedInboxListener pattern.
  await step('story_inbox_listener', async () => {
    const { stopStoryInboxListener } = await import('../social/storyService');
    stopStoryInboxListener();
  }, failed);
  await step('live_location', async () => {
    const { stopAllLiveLocSessions } = await import('../social/liveLocationService');
    stopAllLiveLocSessions();
  }, failed);
  await step('scheduler', async () => {
    const { stopScheduler } = await import('../social/scheduledMessages');
    stopScheduler();
  }, failed);
  await step('ipfs_client', () => resetIpfsClient(), failed);
  await step('messaging_service', () => disposeMessagingService(), failed);
  await step('call_service', () => disposeCallService(), failed);
  await step('close_databases', async () => {
    await closeFeedStorage();
    await closeLocalDatabase();
  }, failed);
  await step('dialog_backups', () => deleteAllDialogBackups(), failed);
  await step('account_vault', async () => {
    const { getStoredMnemonic } = await import('../backup/seedPhrase');
    const { deleteAccountVault } = await import('../storage/accountVault');
    const mnemonic = await getStoredMnemonic();
    if (mnemonic) await deleteAccountVault(mnemonic);
  }, failed);
  await step('sync_device_credentials', () => clearSyncDeviceCredentials(), failed);
  await step('dek_memory', () => clearDekMemory(), failed);
  // v4.32.308: номера профилей забираем ДО clearForWalletWipe — после него
  // список пуст, а базы лент названы по номеру. Номера растут монотонно
  // (nextProfileId), поэтому перебор «от 1 до MAX_PROFILES» не годится.
  let profileIds: number[] = [];
  await step('collect_profile_ids', () => {
    profileIds = profileManager.getProfileIds();
  }, failed);
  await step('profiles', () => profileManager.clearForWalletWipe(), failed);
  await step('mnemonic', () => wipeMnemonicAndSessionFlags(), failed);
  await step('keypair', () => deleteKeyPairFromStore(), failed);
  await step('dek_key', () => SecureStore.deleteItemAsync(DEK_KEY), failed);
  await step('fcm_token', () => SecureStore.deleteItemAsync(FCM_TOKEN_KEY), failed);
  await step('local_db', () => wipeLocalDatabase(), failed);
  // v4.32.308: «удалить данные на устройстве» удаляло главную базу и ключ, а всё
  // остальное оставляло. Каждый пункт — в своём try: сбой одного не вправе
  // прервать сброс и оставить нетронутыми следующие.
  await step('feed_dbs', () => deleteAllFeedDbs(profileIds), failed);
  // В кэше лежат РАСШИФРОВАННЫЕ снимки, голосовые, документы и выгруженные
  // .txt с перепиской. Своя чистка у вложений суточная и только при следующем
  // запуске — то есть до неё «удалённые» данные жили на устройстве ещё сутки,
  // в открытом виде; за выгруженной перепиской до v4.32.310 не убирал никто.
  await step('media_cache', () => purgeSensitiveCache(), failed);
  // Пустой список «оставить»: живых профилей после сброса не осталось ни
  // одного, значит ни один файл аватара больше никому не принадлежит.
  await step('avatars', () => sweepAvatarFiles([]), failed);
  // v4.32.314: если seed-фразу копировали только что, она ещё в буфере обмена
  // — а из неё восстанавливается ровно та личность, которую мы сейчас стёрли.
  await step('clipboard', () => clearSecretClipboardNow(), failed);

  // Проверка и одна повторная попытка. Разовый сбой SecureStore (устройство
  // заблокировано, keystore занят) со второго раза проходит; если не прошёл —
  // молчать об этом нельзя.
  let survivors = await survivingSecrets();
  if (survivors.length > 0) {
    log.warn('wallet_wipe_secrets_survived', { keys: survivors });
    for (const key of survivors) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        /* второй шанс, не более того — итог всё равно перечитываем ниже */
      }
    }
    survivors = await survivingSecrets();
  }
  const result: WalletWipeResult = { ok: survivors.length === 0, failedSteps: failed, survivors };
  log.info('wallet_wipe_done', result);
  return result;
}
