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
import { sweepStoryAlbumFiles } from '../media/storyAlbumFiles';
import { clearDekMemory, DEK_CANARY_KEY, DEK_KEY } from '../storage/localEncryption';
import { resetIpfsClient } from '../transport/ipfs/node';
import { AUTH_SECURE_KEYS, authGuard } from '../security/authGuard';
import { BIOMETRIC_SECURE_KEYS } from '../security/biometricUnlock';
import { cancelScheduledDialogBackup, deleteAllDialogBackups } from '../storage/dialogBackup';
import { SYNC_DEVICE_SECURE_KEYS, clearSyncDeviceCredentials } from '../sync/syncApi';
import { AGENT_BRIDGE_SECURE_KEYS } from '../bridge/agentBridgeKeys';

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
  ...BIOMETRIC_SECURE_KEYS,
  ...SESSION_SECURE_KEYS,
  ...KEYPAIR_SECURE_KEYS,
  ...AUTH_SECURE_KEYS,
  ...SYNC_DEVICE_SECURE_KEYS,
  ...AGENT_BRIDGE_SECURE_KEYS,
  PROFILE_STATE_KEY,
  DEK_KEY,
  // Канарейка секретом не является — её содержимое известно заранее. Но
  // пережить сброс она не имеет права: это утверждение «на устройстве есть
  // данные, зашифрованные вот тем ключом», и оставшись без ключа, она
  // превращает следующий запуск в отказ `key_lost_data_present`. Проверять
  // её здесь — единственный способ узнать об этом до того, как приложение
  // перестанет открываться.
  DEK_CANARY_KEY,
  FCM_TOKEN_KEY,
];

export type WalletWipeResult = {
  /** Ни один секрет не пережил сброс. Отвечает только за SecureStore — см. `leftBehind`. */
  ok: boolean;
  /** Шаги, упавшие по дороге. Сброс продолжается несмотря на них. */
  failedSteps: string[];
  /**
   * Из упавших — те, после которых от прежнего владельца что-то осталось
   * (v4.32.1017).
   *
   * `ok` отвечает на вопрос «пуст ли SecureStore», а человек, нажавший
   * «выйти и удалить данные», спрашивает другое: «можно ли отдавать
   * телефон». Вопросы расходятся ровно там, где шаг стирания честно сказал,
   * что не справился. Самый ясный случай — `local_db`: он бросает после
   * того, как ДВАЖДЫ перечитал каталог и увидел файл базы на месте, — и до
   * v4.32.1017 этот бросок не доходил никуда, потому что вызывающий смотрел
   * только на `ok`.
   *
   * Остановка служб сюда не попадает: погасший слушатель или неснятый
   * таймер не переживут перезапуск, который идёт сразу за сбросом.
   */
  leftBehind: string[];
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
async function step(
  name: string,
  fn: () => unknown,
  failed: string[],
  leftBehind?: string[]
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    failed.push(name);
    if (leftBehind) leftBehind.push(name);
    log.warn('wallet_wipe_step_failed', { step: name, kind: leftBehind ? 'erase' : 'stop', err: errText(e) });
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
  const leftBehind: string[] = [];
  /**
   * Шаг-остановка: снять слушателя, погасить таймер, закрыть соединение.
   * Провал ничего за собой не оставляет — перезапуск идёт сразу за сбросом.
   */
  const stop = (name: string, fn: () => unknown): Promise<void> => step(name, fn, failed);
  /**
   * Шаг-стирание: после его провала от прежнего владельца остаётся файл,
   * секрет или поставленное уведомление. Вид проставлен на каждом месте
   * вызова, а не списком в стороне: список рядом с тридцатью четырьмя
   * шагами разошёлся бы с ними на первом же добавленном.
   */
  const erase = (name: string, fn: () => unknown): Promise<void> => step(name, fn, failed, leftBehind);
  await stop('cancel_dialog_backup', () => cancelScheduledDialogBackup());
  await erase('auth_data', () => authGuard.clearAllAuthData());
  await stop('feed_inbox_listener', () => stopFeedInboxListener());
  // v4.32.174: presence heartbeat держал интервал-таймер + pubsub подписку, после
  // wipe они продолжали палить ключом следующего владельца устройства.
  await stop('presence_broadcast', () => stopPresenceBroadcast());
  // v4.32.176: диспозим push-сервис (onMessage/onTokenRefresh listeners
  // оставались привязаны к старой identity) + сбрасываем in-memory блок-лист
  // чтобы следующий владелец устройства не унаследовал blocked контакты.
  await stop('push_service', () => disposePushNotificationService());
  await stop('rate_limiter', () => rateLimiter.resetForProfileSwitch());
  // v4.32.923: ключ агента — это право включить туннель и переписать
  // настройки приложения, и сброс не трогал его вовсе. «Удалить данные на
  // устройстве» отвечало `ok: true`, а прежний владелец сохранял управление
  // телефоном: секрет лежит в SecureStore, переустановку он переживает, а
  // новому хозяину об этом сказать нечем — мост себя ни значком, ни
  // уведомлением не показывает.
  //
  // Мост гасим здесь же, и порядок не косметика: живая подписка держит
  // выведенные из секрета темы в памяти и принимает команды до самого
  // перезапуска — сколько бы ключей мы ни стёрли с диска после неё.
  await erase('agent_bridge', async () => {
    const { stopAgentBridge } = await import('../bridge/agentBridge');
    stopAgentBridge();
    const { clearBridgeSecrets } = await import('../bridge/agentBridgeKeys');
    await clearBridgeSecrets();
  });
  await stop('live_account_sync', async () => {
    const { cancelLiveAccountSync } = await import('../sync/liveAccountSync');
    cancelLiveAccountSync();
  });
  // v4.32.192 (Round-22 #8): live-location intervals и опрос планировщика
  // продолжают срабатывать со старой парой ключей между wipe() и перезапуском.
  //
  // v4.32.615: подписки на сторис в этом списке больше нет — вместе с самим
  // pubsub-путём (см. storyService). Сторис приходят личными сообщениями, а их
  // слушатель снимается вместе с messaging.
  await stop('live_location', async () => {
    const { stopAllLiveLocSessions } = await import('../social/liveLocationService');
    stopAllLiveLocSessions();
  });
  await stop('scheduler', async () => {
    const { stopScheduler } = await import('../social/scheduledMessages');
    stopScheduler();
  });
  await stop('ipfs_client', () => resetIpfsClient());
  await stop('messaging_service', () => disposeMessagingService());
  await stop('call_service', () => disposeCallService());
  // v4.32.857: отложенные напоминания о сообщениях. Снимать их не умел никто —
  // во всём проекте не было ни одного вызова отмены, — и поставленное «через
  // неделю» срабатывало уже после сброса: на телефоне, где от этой личности не
  // осталось ничего, всплывала строка с текстом её сообщения. Тем же заходом
  // гасится и то, что уже висит в шторке.
  await erase('reminders', async () => {
    const { cancelAllReminders } = await import('../../notifications/reminderNotifications');
    await cancelAllReminders();
  });
  // v4.32.314: если seed-фразу копировали только что, она ещё в буфере обмена
  // — а из неё восстанавливается ровно та личность, которую мы сейчас стираем.
  // v4.32.834: шаг переехал сюда с самого конца. Расписка об отложенной уборке
  // лежит в kv, и читать её надо, пока местная база открыта: после
  // `wipeLocalDatabase` читать было бы нечего, а сам вызов поднял бы стёртую
  // базу заново. В памяти расписка обычно тоже есть — но ровно её отсутствие
  // после перезапуска и есть тот случай, ради которого всё это писалось.
  await erase('clipboard', () => clearSecretClipboardNow());
  await stop('close_databases', async () => {
    await closeFeedStorage();
    await closeLocalDatabase();
  });
  await erase('dialog_backups', () => deleteAllDialogBackups());
  // v4.32.970: вторая отмена — не суеверие. Между первым шагом и этим местом
  // проходит два десятка шагов, и любая запись в чат за это время заводит
  // новую отсрочку. Отменённая здесь, она уже не переживёт удаление файлов.
  await erase('cancel_dialog_backup_late', () => cancelScheduledDialogBackup());
  await erase('account_vault', async () => {
    const { getStoredMnemonic } = await import('../backup/seedPhrase');
    const { deleteAccountVault } = await import('../storage/accountVault');
    const mnemonic = await getStoredMnemonic();
    if (mnemonic) await deleteAccountVault(mnemonic);
  });
  await erase('sync_device_credentials', () => clearSyncDeviceCredentials());
  await stop('dek_memory', () => clearDekMemory());
  // v4.32.308: номера профилей забираем ДО clearForWalletWipe — после него
  // список пуст, а базы лент названы по номеру. Номера растут монотонно
  // (nextProfileId), поэтому перебор «от 1 до MAX_PROFILES» не годится.
  let profileIds: number[] = [];
  await erase('collect_profile_ids', () => {
    profileIds = profileManager.getProfileIds();
  });
  await erase('profiles', () => profileManager.clearForWalletWipe());
  await erase('mnemonic', () => wipeMnemonicAndSessionFlags());
  await erase('keypair', () => deleteKeyPairFromStore());
  // v4.32.603: канарейка уходит ПЕРЕД ключом, и порядок здесь не косметика.
  // Удаление ключа её не трогало вовсе, и после «выйти и удалить данные»
  // на устройстве оставалась запись «данные зашифрованы ключом, которого
  // нет» — при следующем запуске политика видела ровно её и честно
  // отказывалась открывать приложение: `key_lost_data_present`. Починить это
  // изнутри было нечем, приложение просто не стартовало.
  //
  // Порядок выбран из двух возможных исходов частичного сбоя: ключ без
  // канарейки принимается на следующем запуске как есть (`stored_adopted`),
  // а канарейка без ключа делает запуск невозможным.
  await erase('dek_canary', () => SecureStore.deleteItemAsync(DEK_CANARY_KEY));
  await erase('dek_key', () => SecureStore.deleteItemAsync(DEK_KEY));
  await erase('fcm_token', () => SecureStore.deleteItemAsync(FCM_TOKEN_KEY));
  await erase('local_db', () => wipeLocalDatabase());
  // v4.32.308: «удалить данные на устройстве» удаляло главную базу и ключ, а всё
  // остальное оставляло. Каждый пункт — в своём try: сбой одного не вправе
  // прервать сброс и оставить нетронутыми следующие.
  await erase('feed_dbs', () => deleteAllFeedDbs(profileIds));
  // В кэше лежат РАСШИФРОВАННЫЕ снимки, голосовые, документы и выгруженные
  // .txt с перепиской. Своя чистка у вложений суточная и только при следующем
  // запуске — то есть до неё «удалённые» данные жили на устройстве ещё сутки,
  // в открытом виде; за выгруженной перепиской до v4.32.310 не убирал никто.
  await erase('media_cache', () => purgeSensitiveCache());
  // Пустой список «оставить»: живых профилей после сброса не осталось ни
  // одного, значит ни один файл аватара больше никому не принадлежит.
  await erase('avatars', () => sweepAvatarFiles([]));
  // v4.32.924: альбомы историй сброс не трогал. Уборка кэша сюда не достаёт по
  // устройству: альбом — это СВОЯ копия в documentDirectory, и сделана она
  // именно затем, чтобы пережить любую чистку кэша. Пустой список «оставить»
  // здесь честен ровно потому же, почему у аватаров: живых профилей после
  // сброса нет ни одного, и ни одна сохранённая история больше ничья.
  await erase('story_albums', () => sweepStoryAlbumFiles([]));
  // Журнал приложения — опись переписки, а не её содержание: DID собеседников,
  // номера сообщений, состояние молчания, времена сетевых путей. Файл лежит
  // рядом с базой и переживал сброс целиком, причём молча: включается он
  // скрытым режимом разработчика, и человек, включивший его однажды, о файле
  // уже не помнит.
  await erase('app_log', async () => {
    const { deleteAppLogFile } = await import('../fileLogSink');
    await deleteAppLogFile();
  });

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
  const result: WalletWipeResult = { ok: survivors.length === 0, failedSteps: failed, leftBehind, survivors };
  log.info('wallet_wipe_done', result);
  return result;
}
