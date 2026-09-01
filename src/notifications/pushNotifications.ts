import { AppState, PermissionsAndroid, Platform } from 'react-native';
import * as SecureStore from '../core/storage/secureStoreQueued';
import { loadConfig } from '../core/config';
import { log } from '../core/logger';
import { vibrationFor } from './vibrationPattern';
import { getMessagingService, subscribeInAppNotifications } from '../core/social/messaging';
import { setGroupMessageNotifyCallback } from '../core/social/groupMessaging';
import { kvGet } from '../core/storage/local';
import { isMuted } from '../core/notifications/muteStore';
import { sanitizeDisplayName } from '../core/social/sysLineGuard';
import { listContacts } from '../core/social/contacts';
import { parseDidKey } from '../core/identity/did';
import { isWithinDndWindow, parseDndHour } from './dndWindow';
import { dmBannerText } from './dmBannerText';
import { bannerIdForCid, bannerIdForGroup } from './bannerId';
import { createSerialRunner } from './lifecycleQueue';
import { NOTIFICATION_SMALL_ICON } from './notificationIcon';
import { shouldSuppressDmBanner, shouldSuppressGroupBanner } from './activeChatSuppress';
import { deliverOpenIntent, parseChatOpenIntent, parseOpenIntent } from './openIntent';
import { NOTIFY_DEDUP_MAX, createNotifyDedup } from './notifyDedup';
import type { PushKind } from './pushKind';

// v4.32.165: channel ID bumped to _v2 — Android кеширует importance per-channel,
// смена importance существующего канала игнорируется системой. Новый ID = свежий
// канал с нашим желаемым importance=HIGH (heads-up баннеры). Старый airchat_messages
// (MIN) останется у пользователей, кто устанавливал до v4.32.165 — он пустой, можно
// вручную скрыть в Settings → Notifications.
const CHANNEL_MESSAGES = 'airchat_messages_v2';
const CHANNEL_MENTIONS = 'airchat_mentions_v2';
const CHANNEL_CALLS = 'airchat_calls_v2';
const CHANNEL_FEED = 'airchat_feed_v2';

/**
 * v4.32.131 (AUDIT P2): dedupe push notifications by cid. Same message can
 * arrive via FCM twice (carrier retry) within seconds; without this set the
 * user sees a duplicate banner. Using chatMessageExists wasn't viable —
 * `handlePushOpen` above writes the row BEFORE we decide whether to notify,
 * so the DB would always report the row present on first arrival.
 *
 * Bounded to last NOTIFY_DEDUP_MAX cids with FIFO eviction; TTL is implicit
 * (process lifetime is short relative to notification retry windows).
 *
 * v4.32.571: отметка стала бронью. Раньше cid отмечался за четыре await до
 * показа и не снимался никогда, поэтому единственная осечка notifee означала,
 * что сообщение не покажется уже никогда — ни при повторе доставки, ни с
 * другого пути. Учёт вынесен в notifyDedup, где есть release.
 */
const notifyDedup = createNotifyDedup(NOTIFY_DEDUP_MAX);

/** DID собеседника, чью ветку смонтировал экран переписки. Ставит ChatScreen. */
let activeChatPeerDid: string | null = null;
export function setActiveChatDid(did: string | null): void { activeChatPeerDid = did; }

/**
 * Группа, чью ветку смонтировал экран групп. Ставит GroupsScreen.
 *
 * v4.32.560: у переписки такая отметка есть с v4.32.525, у групп её не было —
 * и уведомление о сообщении приходило в шторку даже тогда, когда человек это
 * сообщение прямо сейчас читает.
 */
let activeGroupId: string | null = null;
export function setActiveGroupId(groupId: string | null): void { activeGroupId = groupId; }

/** Снимок того, что открыто на экране, — для обеих проверок подавления. */
function openScreenState(): { peerDid: string | null; groupId: string | null; tab: string | null; appState: string | null } {
  return {
    peerDid: activeChatPeerDid,
    groupId: activeGroupId,
    tab: activeTabName,
    appState: AppState.currentState as string | null,
  };
}

/**
 * Активная вкладка нижней панели. Ставит MainTabs.
 *
 * v4.32.525: без неё «открытая переписка» означала «когда-то открытая».
 * Вкладки остаются смонтированными под display:none, чтобы переключение не
 * пересобирало тяжёлые экраны, поэтому размонтирование ветки — не признак
 * того, что человек ушёл из диалога. Отметку о вкладке нельзя было получить
 * из TabRefContext: тот отдаёт ref, который меняется без перерисовки, и
 * подписаться на него экран не может (см. его же пометку @stable).
 */
let activeTabName: string | null = null;
export function setActiveTabName(tab: string | null): void { activeTabName = tab; }

/** Returns true if Do Not Disturb is active right now. */
async function isDndActive(): Promise<boolean> {
  const enabled = (await kvGet('dnd_enabled')) === 'true';
  if (!enabled) return false;
  // v4.32.195 (Round-25 #10): guard against corrupt/malformed kv values.
  // A non-numeric string would make parseInt → NaN, and NaN comparisons are
  // always false → DnD silently disabled despite the toggle being on.
  // v4.32.248: само окно считает dndWindow — та же проверка нужна фоновому
  // обработчику push, а до неё он не доходил вовсе.
  const start = parseDndHour(await kvGet('dnd_start'), 22);
  const end = parseDndHour(await kvGet('dnd_end'), 8);
  return isWithinDndWindow(start, end, new Date().getHours());
}

const FCM_TOKEN_KEY = 'airchat_fcm_token_v1';

export type PushInitOptions = {
  peerId: string;
};

/**
 * Firebase Cloud Messaging + Notifee. Requires dev build + google-services files + prebuild.
 */
export class PushNotificationService {
  private initialized = false;
  private unsubOnMessage: (() => void) | null = null;
  private unsubTokenRefresh: (() => void) | null = null;
  // v4.32.195 (Round-25 #3): onForegroundEvent unsubscribe was previously
  // discarded — each init() stacked another listener, so after N profile
  // rotations a single tap fired handlePushOpen N times (some on disposed
  // messaging services).
  private unsubForeground: (() => void) | null = null;
  private unsubGroupNotify: (() => void) | null = null;
  // v4.32.477: системное уведомление о личном сообщении по ЛЮБОМУ транспорту,
  // а не только по push. См. showDmBanner.
  private unsubDmNotify: (() => void) | null = null;
  private currentPeerId: string | null = null;
  /**
   * v4.32.496: запуск и разбор идут строго друг за другом. Оба вызываются из
   * эффекта личности огонь-и-забыли, а разбор внутри ждёт сеть — без очереди
   * запуск начинался поверх незакончившегося разбора. См. lifecycleQueue.ts.
   */
  private readonly serial = createSerialRunner();

  async init(options: PushInitOptions): Promise<void> {
    return this.serial(() => this.initLocked(options));
  }

  private async initLocked(options: PushInitOptions): Promise<void> {
    // v4.32.143 (AUDIT P1 T3/T4): if already initialized for SAME peerId — no-op.
    // If initialized for a DIFFERENT peerId (identity rotation), dispose stale
    // listeners first so we don't (a) stack duplicate onMessage banners and
    // (b) leave an onTokenRefresh that still closes over the old peerId.
    if (this.initialized) {
      if (this.currentPeerId === options.peerId) return;
      // v4.32.496: именно disposeLocked — мы уже держим дорожку, и вызов
      // публичного dispose() встал бы в очередь за самим собой.
      await this.disposeLocked();
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const messaging = require('@react-native-firebase/messaging').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const notifee = require('@notifee/react-native').default;
      const notifeeMod = require('@notifee/react-native');
      const AndroidImportance = notifeeMod.AndroidImportance;
      const EventType = notifeeMod.EventType;

      // v4.32.168: POST_NOTIFICATIONS permission ДО createChannel. На некоторых
      // OEM (MIUI/ColorOS) каналы, создаваемые без pre-granted permission,
      // попадают в «Blocked group» и не показывают heads-up даже после выдачи.
      await ensureAndroidNotificationPermission();

      // v4.32.165: split channels с правильным importance. MIN у старого
      // airchat_messages означал «только запись в шторке без heads-up» — юзеры
      // жаловались «нотификаций нет». Теперь все релевантные каналы — HIGH
      // (heads-up), feed — DEFAULT (тише, без heads-up-баннера, но видно).
      await notifee.createChannel({
        id: CHANNEL_MESSAGES,
        name: 'Сообщения',
        description: 'Личные и групповые сообщения',
        importance: AndroidImportance.HIGH,
      });
      await notifee.createChannel({
        id: CHANNEL_MENTIONS,
        name: 'Упоминания',
        description: '@упоминания в группах',
        importance: AndroidImportance.HIGH,
        vibration: true,
      });
      await notifee.createChannel({
        id: CHANNEL_CALLS,
        name: 'Звонки',
        description: 'Входящие голосовые и видеозвонки',
        importance: AndroidImportance.HIGH,
        vibration: true,
      });
      await notifee.createChannel({
        id: CHANNEL_FEED,
        name: 'Новости',
        description: 'Новые публикации и комментарии',
        importance: AndroidImportance.DEFAULT,
      });

      // v4.32.558: нажатие, которым приложение и запустили. Когда процесс
      // убит, оно не приходит событием вовсе: notifee отдаёт его один раз при
      // старте и только через getInitialNotification. Мы не читали — и
      // уведомление, ради которого человек открыл приложение, пропадало.
      try {
        const initial = await notifee.getInitialNotification();
        const intent = parseOpenIntent(initial?.notification?.data);
        if (intent) {
          log.info('push_press_cold_start', { outcome: deliverOpenIntent(intent, 'cold-start') });
        }
      } catch (e) {
        log.debug('push_initial_notification_failed', { err: e instanceof Error ? e.message : String(e) });
      }

      // Register group message local notification handler
      this.unsubGroupNotify = setGroupMessageNotifyCallback(async (groupName, senderName, text, groupId, kind, mention, msgId) => {
        try {
          // v4.32.560: не будить телефон сообщением из группы, которую человек
          // читает прямо сейчас. У переписки такая проверка есть с v4.32.525.
          if (shouldSuppressGroupBanner(openScreenState(), groupId)) return;
          if (await isDndActive()) return;
          // v4.32.255: флаг приходит готовым из groupMessaging (там же, где он
          // пишется в mention_count). Здесь он выводился заново — но из `text`,
          // а это не сообщение, а превью, обрезанное до 80 символов, да ещё и
          // сравнение было регистрозависимым. То есть ровно в том случае, ради
          // которого флаг существует — упоминание в замьюченной группе, — он
          // мог не сработать, а бейдж в списке групп при этом горел.
          // v4.32.168: в каналах нет реальных @mentions (только broadcast от
          // админа) — теперь это учтено на стороне groupMessaging.
          const isMention = mention === true;
          const notifyGroups = (await kvGet('notify_groups')) !== 'false';
          if (!notifyGroups) {
            // Still notify if it's a @mention
            const notifyMentions = (await kvGet('notify_mentions')) !== 'false';
            if (!notifyMentions || !isMention) return;
          }
          // v4.32.166: per-entity mute. @упоминания проходят через mute (Telegram
          // default behaviour) — иначе замьюченная группа делает упоминания невидимыми.
          // User сможет отключить через notify_mentions=false глобально, если не хочет.
          // v4.32.168: для channel — кинд всегда 'channel', проверяем только его;
          // для group — проверяем 'group' (fallback 'channel' на случай миграций).
          if (groupId && !isMention) {
            const effKind = kind === 'channel' ? 'channel' : 'group';
            if (await isMuted(effKind, groupId)) return;
            // Backward compat: если раньше было записано под другим kind — тоже глушим.
            if (effKind === 'group' && (await isMuted('channel', groupId))) return;
          }
          const preview = (await kvGet('notify_preview')) !== 'false';
          const vibrate = (await kvGet('notify_vibrate')) !== 'false';
          // v4.32.169: notify_sound toggle was dead — wire it to notifee sound option.
          const sound = (await kvGet('notify_sound')) !== 'false';
          await notifee.displayNotification({
            // v4.32.560: одно имя на группу — новый баннер заменяет прежний,
            // а не встаёт двадцатой строкой в шторке.
            ...(groupId ? { id: bannerIdForGroup(groupId) } : {}),
            title: preview ? (isMention ? `@упоминание · ${groupName}` : `${groupName}: ${senderName}`) : 'AirChat',
            body: preview ? text : 'Новое сообщение',
            // v4.32.560: без полезной нагрузки нажатие на групповой баннер не
            // вело никуда — разбирать было нечего (см. notifications/openIntent).
            ...(groupId ? { data: { groupId, groupKind: kind ?? 'group', msgId: msgId ?? '' } } : {}),
            android: {
              // v4.32.165: @упоминания в свой канал (HIGH + vibrate) чтобы они
              // выделялись на фоне обычных group messages.
              channelId: isMention ? CHANNEL_MENTIONS : CHANNEL_MESSAGES,
              smallIcon: NOTIFICATION_SMALL_ICON,
              pressAction: { id: 'default' },
              vibrationPattern: vibrationFor(vibrate, 'message'),
              sound: sound ? 'default' : undefined,
            },
          });
        } catch (e) {
          // v4.32.567: не debug. Именно этот уровень четыреста версий скрывал,
          // что notifee отвергал рисунок вибрации и баннеров не было вовсе.
          log.warn('group_local_notify_failed', { err: e instanceof Error ? e.message : String(e) });
        }
      });

      // v4.32.477: личное сообщение будит телефон, даже если push не дошёл.
      // Уведомление о нём показывалось ровно в одном месте — в обработчике
      // входящего FCM ниже. Сообщение, приехавшее по локальной сети, через
      // ретранслятор или через IPFS, не показывало ничего: экран не загорался,
      // в шторке не появлялось строки, и узнать о нём можно было, только
      // открыв приложение. У групп такая ветка есть с самого начала
      // (setGroupMessageNotifyCallback выше) — у переписки её не было.
      this.unsubDmNotify = subscribeInAppNotifications((n) => {
        void this.showDmBanner({
          cid: n.cid,
          contactDid: n.senderDid || undefined,
          peerPubB64: n.peerPubB64,
          preview: n.preview,
        });
      });

      await messaging().requestPermission();
      const token = await messaging().getToken();
      await SecureStore.setItemAsync(FCM_TOKEN_KEY, token);
      log.info('push_fcm_token', { len: token?.length ?? 0 });
      this.currentPeerId = options.peerId;
      await this.registerTokenWithSignaling(options.peerId, token);

      this.unsubOnMessage = messaging().onMessage(async (remoteMessage: { data?: Record<string, string> }) => {
        // v4.32.220 (Paranoid HIGH-4): ignore server-supplied senderName and
        // body entirely. The FCM relay only needs cid+contactDid to dispatch
        // an encrypted message; any display text it supplies is untrusted
        // and could be injected to mislead the user ("Alice: send money").
        // We resolve the contact name LOCALLY from the contacts DB keyed on
        // contactDid (см. showDmBanner), and always use a generic body.
        // v4.32.558: сама проверка формы (hex 16-128 для cid, did:метод:… до
        // 256 знаков) переехала в openIntent — она была скопирована слово в
        // слово в трёх местах, и расходиться им нельзя: это единственный
        // барьер между полезной нагрузкой из сети и запросом к базе.
        const intent = parseChatOpenIntent(remoteMessage.data);
        if (!intent) {
          log.debug('push_bad_cid', { t: typeof remoteMessage.data?.cid });
          return;
        }
        const { cid, contactDid } = intent;
        await getMessagingService()?.handlePushOpen(cid, contactDid);
        // v4.32.477: сам показ переехал в showDmBanner — тот же баннер нужен и
        // сообщению, приехавшему мимо push. Тела у push-ветки нет: расшифровка
        // происходит уже после доставки, а текст, присланный сервером, недостоверен.
        await this.showDmBanner({ cid, contactDid });
      });

      this.unsubForeground = notifee.onForegroundEvent(({ type, detail }: { type: number; detail: { notification?: { data?: Record<string, string> } } }) => {
        if (type === EventType.PRESS) {
          // v4.32.558: раньше здесь звали options.onOpenChat, которого никто
          // никогда не передавал, — нажатие при открытом приложении не делало
          // ничего. Теперь оба пути (и этот, и фоновый) сводятся к одному
          // намерению, а открывает переписку экран вкладок.
          const intent = parseOpenIntent(detail.notification?.data);
          if (intent) {
            log.info('push_press_foreground', { outcome: deliverOpenIntent(intent, 'foreground-press') });
          }
        }
      });

      this.unsubTokenRefresh = messaging().onTokenRefresh(async (t: string) => {
        await SecureStore.setItemAsync(FCM_TOKEN_KEY, t);
        // v4.32.143 (AUDIT P1 T4): read peerId fresh from `this`, not from the
        // closure — identity rotation mutates currentPeerId via dispose()+init().
        const peerId = this.currentPeerId;
        if (!peerId) return;
        await this.registerTokenWithSignaling(peerId, t);
      });

      this.initialized = true;
    } catch (e) {
      log.info('push_fcm_unavailable', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * v4.32.143 (AUDIT P1 T3): tear down onMessage + onTokenRefresh subscriptions.
   * Called on logout/identity rotation so we don't stack listeners (which caused
   * 2× banners + 2× handlePushOpen) or leak an onTokenRefresh bound to the
   * old peerId (which mis-routed pushes after FCM token rotation).
   */
  async dispose(): Promise<void> {
    return this.serial(() => this.disposeLocked());
  }

  private async disposeLocked(): Promise<void> {
    try { this.unsubOnMessage?.(); } catch { /* best effort */ }
    try { this.unsubTokenRefresh?.(); } catch { /* best effort */ }
    try { this.unsubForeground?.(); } catch { /* best effort */ }
    try { this.unsubGroupNotify?.(); } catch { /* best effort */ }
    try { this.unsubDmNotify?.(); } catch { /* best effort */ }
    // v4.32.177: удаляем FCM токен на устройстве — иначе следующий пользователь
    // этого же устройства продолжал получать push'и, адресованные старой DID.
    // `messaging().deleteToken()` переключает Firebase на новый токен, старый
    // инвалидируется и не роутится обратно.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const messaging = require('@react-native-firebase/messaging').default;
      await messaging().deleteToken();
    } catch (e) {
      log.warn('push_delete_token_failed', { err: e instanceof Error ? e.message : String(e) });
    }
    try { await SecureStore.deleteItemAsync(FCM_TOKEN_KEY); } catch { /* ignore */ }
    this.unsubOnMessage = null;
    this.unsubTokenRefresh = null;
    this.unsubForeground = null;
    this.unsubGroupNotify = null;
    this.unsubDmNotify = null;
    this.currentPeerId = null;
    this.initialized = false;
  }

  /**
   * Системное уведомление о личном сообщении.
   *
   * v4.32.477: раньше эти тридцать строк лежали внутри обработчика входящего
   * FCM, и другого места, где личное сообщение попадало бы в шторку, не было.
   * Сообщение, доехавшее по локальной сети, через ретранслятор или через IPFS,
   * не показывало ничего — телефон молчал, пока человек сам не откроет
   * приложение. У групп ветка «показать уведомление на приёме» есть с самого
   * начала, у переписки не было. Теперь показ общий, а зовут его оба пути.
   *
   * Все прежние проверки сохранены: открытый чат, «не беспокоить», заглушённый
   * собеседник, общий выключатель личных сообщений и защита от повтора по cid.
   * Имя собеседника берётся ТОЛЬКО из своей базы контактов: имя из сети
   * недостоверно и могло бы подделать отправителя прямо на экране блокировки.
   */
  private async showDmBanner(opts: {
    cid: string;
    contactDid?: string;
    peerPubB64?: string;
    /** Расшифрованное превью, если оно уже известно (путь приёма по сети). */
    preview?: string;
  }): Promise<void> {
    const { cid, contactDid, peerPubB64 } = opts;
    if (!cid) return;
    // v4.32.525: одной отметки о собеседнике мало — см. activeChatSuppress.
    if (shouldSuppressDmBanner(openScreenState(), contactDid)) return;
    if (await isDndActive()) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const notifee = require('@notifee/react-native').default;
      // v4.32.166: per-entity DM mute. Глушит баннер, но приём уже отработал →
      // запись в БД/unread counter не теряется.
      if (contactDid && (await isMuted('chat', contactDid))) {
        log.debug('push_notify_muted', { cid: cid.slice(0, 16) });
        return;
      }
      // v4.32.169: global DM toggle (Ещё → Уведомления → «Личные сообщения»).
      if ((await kvGet('notify_dm')) === 'false') {
        log.debug('push_notify_dm_disabled', { cid: cid.slice(0, 16) });
        return;
      }
      // v4.32.131 (AUDIT P2): skip banner if we already showed one for this cid
      // within the current process. Carrier-level FCM retry was firing two
      // banners for a single delivery.
      // v4.32.477: этот же ключ разводит два источника показа. Push несёт тот
      // самый cid, по которому приём кладёт сообщение, поэтому сообщение,
      // подтянутое ПО push'у, отмечает cid на приёме — и push-ветка следом
      // видит отметку и молчит вместо второго баннера.
      // v4.32.571: бронь берётся здесь, до чтения настроек и показа, — две
      // одновременные доставки не должны нарисовать два баннера. Если показать
      // не выйдет, бронь снимается в catch, и повтор доставки покажет баннер.
      if (!notifyDedup.reserve(cid)) {
        log.debug('push_notify_dedup', { cid: cid.slice(0, 16) });
        return;
      }
      const preview = (await kvGet('notify_preview')) !== 'false';
      const vibrate = (await kvGet('notify_vibrate')) !== 'false';
      const sound = (await kvGet('notify_sound')) !== 'false';
      // v4.32.220 (HIGH-4): resolve sender name locally from contacts store.
      // v4.32.369: та же чистка, что у всех имён из сети. Своя копия знала
      // только C0: имя с U+202E переворачивало текст в шторке уведомлений,
      // имя с U+2028 дописывало к баннеру вторую строку.
      let senderName = 'AirChat';
      try {
        let pubB64: string | null = peerPubB64 ?? null;
        if (!pubB64 && contactDid) {
          const pubBytes = parseDidKey(contactDid);
          if (pubBytes) pubB64 = Buffer.from(pubBytes).toString('base64');
        }
        if (pubB64) {
          const contacts = await listContacts();
          const match = contacts.find((c) => c.peerPublicKey === pubB64);
          if (match?.displayName) senderName = sanitizeDisplayName(match.displayName, 80) ?? '';
        }
      } catch (e) {
        log.debug('push_resolve_sender_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      // Текст показываем, только если он у нас уже расшифрован (путь приёма) и
      // человек не выключил превью. У push-ветки его нет и быть не может.
      const { title, body } = dmBannerText({
        senderName,
        preview: opts.preview,
        showPreview: preview,
      });
      await notifee.displayNotification({
        // v4.32.502: то же имя, что у баннера из фонового обработчика — этот
        // показ заменяет безличный «Новое сообщение», а не дублирует его.
        id: bannerIdForCid(cid),
        title,
        body,
        android: {
          channelId: CHANNEL_MESSAGES,
          smallIcon: NOTIFICATION_SMALL_ICON,
          pressAction: { id: 'default' },
          vibrationPattern: vibrationFor(vibrate, 'message'),
          sound: sound ? 'default' : undefined,
        },
        data: { cid, contactDid: contactDid ?? '' },
      });
    } catch (e) {
      // v4.32.567: см. group_local_notify_failed — отказ показа виден в release.
      // v4.32.571: показать не вышло — значит, сообщение не показано никому.
      // Возвращаем бронь, иначе повтор доставки промолчит вслед за нами.
      notifyDedup.release(cid);
      log.warn('push_local_notify_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  async registerTokenWithSignaling(peerId: string, token: string): Promise<void> {
    const cfg = await loadConfig();
    // v4.32.381: без хвостового слэша и заведомо http(s) — приведено в
    // core/config. Прежний replace() снимал слэш, но пропускал 'wss://…',
    // из-за чего fetch на `${base}/register-token` не мог уйти в принципе:
    // звонки работали, а пуши молча не регистрировались.
    const base = cfg.webrtc?.signalingUrl;
    if (!base) {
      log.warn('push_no_signaling_url');
      return;
    }
    // v4.32.179 (Round-9): bounded timeout — signaling may be unreachable; without this
    // fetch can hang indefinitely, blocking init promise chain on cold start.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${base}/register-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId, token }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log.warn('push_register_failed', { status: res.status });
      }
    } catch (e) {
      log.warn('push_register_error', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * Ask signaling to FCM-notify the recipient (their device registers with `peerId` = did:key).
   * @param recipientDid — contact's did:key (receiver)
   * @param messageCid — IPFS CID of the encrypted message
   * @param senderDid — your did:key (receiver matches contact)
   */
  async sendPushToContact(
    recipientDid: string,
    messageCid: string,
    senderDid: string,
    // v4.32.572: чем было сообщение. Прежний четвёртый параметр звался
    // _senderName, никем не передавался и никуда не шёл — имена в push мы не
    // отправляем принципиально (см. HIGH-4).
    kind: PushKind = 'dm'
  ): Promise<void> {
    await this.sendPushNotification(recipientDid, messageCid, senderDid, kind);
  }

  private async sendPushNotification(
    targetPeerId: string,
    cid: string,
    senderDid: string,
    kind: PushKind
  ): Promise<void> {
    const cfg = await loadConfig();
    const base = cfg.webrtc?.signalingUrl;
    if (!base) return;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    try {
      // Передаём только идентификаторы — без имён и контента сообщений.
      // Контент уведомления формируется локально на устройстве получателя.
      await fetch(`${base}/send-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // v4.32.572: `kind` — один бит, личное это сообщение или групповое.
        // Идентификатора группы здесь нет и быть не должно: он рассказал бы
        // чужому серверу, кто в какой группе состоит (см. notifications/pushKind).
        body: JSON.stringify({ targetPeerId, cid, senderDid, kind }),
        signal: ctrl.signal,
      });
    } catch (e) {
      log.warn('push_send_failed', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(to);
    }
  }
}

export const pushNotificationService = new PushNotificationService();

/**
 * v4.32.165: runtime-запрос POST_NOTIFICATIONS (Android 13+, API 33).
 * На младших Android разрешение даётся автоматически из manifest (noop).
 * На iOS — noop (iOS использует свой APNs flow через messaging().requestPermission()).
 *
 * Идемпотентно: если уже granted, system-dialog не появится.
 * Отказ логируется и не бросает — caller продолжает работу (FCM init безопасен
 * без notifee-показа; при denial banners просто молча не показываются).
 */
export async function ensureAndroidNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  // Android API level < 33 → разрешение даётся автоматически через manifest.
  if (typeof Platform.Version === 'number' && Platform.Version < 33) return true;
  try {
    const perm = 'android.permission.POST_NOTIFICATIONS' as Parameters<typeof PermissionsAndroid.request>[0];
    const already = await PermissionsAndroid.check(perm);
    if (already) return true;
    const res = await PermissionsAndroid.request(perm, {
      title: 'Уведомления AirChat',
      message: 'Разрешите показывать уведомления о новых сообщениях, комментариях и звонках.',
      buttonPositive: 'Разрешить',
      buttonNegative: 'Отмена',
    });
    const granted = res === PermissionsAndroid.RESULTS.GRANTED;
    log.info('push_post_notifications_perm', { granted, res: String(res) });
    return granted;
  } catch (e) {
    log.warn('push_post_notifications_perm_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * v4.32.165: system-level notification для событий ленты (новый пост / комментарий).
 * Используется из App.tsx setFeedNotifyCallback — раньше там был только
 * in-app banner, который виден только если приложение открыто; если юзер
 * в фоне или screen-off — событие терялось. Канал CHANNEL_FEED имеет DEFAULT
 * importance: уведомление видно в шторке, но без heads-up popup'а
 * (чтобы не конкурировать с сообщениями/звонками по приоритету).
 *
 * Сознательно НЕ вызываем FCM — событие локальное, пришло через lanCoordinator /
 * pubsub, никакого внешнего push'а не было.
 */
export async function notifyFeedEvent(opts: {
  title: string;
  body: string;
  postId?: string;
  kind: 'post' | 'comment';
}): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require('@notifee/react-native').default;
    // v4.32.169: respect notify_feed global toggle (Ещё → Уведомления → «Лента»).
    if ((await kvGet('notify_feed')) === 'false') return;
    const vibrate = (await kvGet('notify_vibrate')) !== 'false';
    const sound = (await kvGet('notify_sound')) !== 'false';
    // v4.32.239: «Показывать содержимое» глушило текст только у сообщений, а
    // публикации и комментарии всё равно уезжали на экран блокировки целиком,
    // вместе с именем автора. Настройка одна на все уведомления.
    const preview = (await kvGet('notify_preview')) !== 'false';
    await notifee.displayNotification({
      title: preview ? opts.title : 'AirChat',
      body: preview
        ? opts.body || (opts.kind === 'post' ? '(медиа)' : '')
        : opts.kind === 'post' ? 'Новая публикация' : 'Новый комментарий',
      android: {
        channelId: CHANNEL_FEED,
        smallIcon: NOTIFICATION_SMALL_ICON,
        pressAction: { id: 'default' },
        vibrationPattern: vibrationFor(vibrate, 'feed'),
        sound: sound ? 'default' : undefined,
      },
      data: opts.postId ? { feedPostId: opts.postId, feedKind: opts.kind } : undefined,
    });
  } catch (e) {
    // v4.32.567: см. group_local_notify_failed — отказ показа виден в release.
    log.warn('feed_notify_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * v4.32.143 (AUDIT P1 T3): call from App.tsx identity-change teardown so push
 * listeners get detached before the next init() runs for the new identity.
 */
export async function disposePushNotificationService(): Promise<void> {
  await pushNotificationService.dispose();
}
