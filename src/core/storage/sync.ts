import * as Network from 'expo-network';
import { Platform } from 'react-native';
import { isPlainCid } from '../cid';
import { log } from '../logger';
import { getMessagingService, type MessagingService } from '../social/messaging';
import { parseDmRetryPayload } from '../social/dmRetryPayload';
import { parseCtlRetryPayload } from '../social/ctlRetryPayload';
import { profileManager } from '../identity/profileManager';
import {
  outboxDrain,
  outboxDeleteById,
  outboxIncrementAttempts,
  outboxPurgeDead,
  OUTBOX_DRAIN_LIMIT,
  type OutboxItem,
} from './local';
import { addToIpfs } from '../transport/ipfs/node';
import { pubsubPublish } from '../transport/ipfs/pubsub';
import { isIpfsEnabled } from '../transport/ipfs/heliaNode';

/** v4.32.20: dead-letter TTL. Item висит в outbox дольше 7 дней — удаляем. */
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * v4.32.500: сколько окон очереди разбирается за один вызов синхронизации.
 *
 * OUTBOX_DRAIN_LIMIT × OUTBOX_DRAIN_PASSES = 10 000 — это ровно потолок числа
 * строк в очереди, то есть за один заход она по-прежнему разбирается целиком,
 * просто по двести строк в памяти вместо всех сразу. Ограничение здесь на
 * случай, если сдвиг окна почему-то перестанет расти: цикл обязан кончиться.
 */
const OUTBOX_DRAIN_PASSES = 50;

export type SyncHandlers = {
  onMessageQueued?: (item: OutboxItem) => void;
  onSyncComplete?: (sent: number) => void;
};

let syncing = false;

/**
 * Что случилось с одной строкой очереди.
 *
 * `delivered` — ушло (или строка отравлена и держать её незачем): удаляем.
 * `failed`    — попытка БЫЛА и не удалась: attempts += 1, после
 *               OUTBOX_MAX_ATTEMPTS строка перестаёт выдаваться outboxDrain.
 * `deferred`  — попытки НЕ БЫЛО, отправлять сейчас нечем: attempts не трогаем.
 *
 * Различие не косметическое. До v4.32.445 две последние ветки были одним
 * `delivered = false`, и отсутствующий messaging-сервис — загрузка,
 * только что переключённый профиль, dispose перед пересозданием — считался
 * неудачной попыткой отправки. Двадцать таких тиков подряд, и сообщение,
 * которое никто ни разу не пытался отправить, навсегда выпадало из
 * outboxDrain, а через семь дней удалялось по TTL. В переписке оно при этом
 * оставалось выглядеть отправленным.
 *
 * Поэтому исход — размеченное объединение, а не булево: ветка «нечем
 * отправлять» обязана назвать причину и физически не может слиться с
 * «попробовали и не вышло».
 */
type ItemOutcome =
  | { kind: 'delivered' }
  | { kind: 'failed' }
  | { kind: 'deferred'; reason: string };

// v4.32.377: здесь была queueEncryptedMessage — единственное место, где в
// outbox попадали строки вида 'msg' (тема pubsub + CID). Её не вызывал никто,
// то есть таких строк уже давно не появляется. Разбор 'msg' ниже оставлен: в
// базе на устройстве могут лежать строки, записанные старыми версиями.

/**
 * Служба отправки для строки очереди — или отказ, если она сейчас чужая.
 *
 * v4.32.470. Владелец строки проверялся один раз, до цикла, по глобальному
 * «активному профилю»; сама отправка идёт дальше по циклу, через сеть, и на
 * каждой строке заново спрашивает getMessagingService(). Между этими двумя
 * моментами человек успевает переключить аккаунт — и служба уже другая.
 * Тогда личное сообщение, поставленное в очередь в личном профиле, уходило
 * подписанным ключом рабочего: собеседник видел письмо от другой личности,
 * а запись о нём ложилась в переписки рабочего профиля. Ровно ту связку двух
 * аккаунтов, ради запрета которой их и заводят.
 *
 * Поэтому владелец сверяется непосредственно перед отправкой и не с глобальным
 * состоянием, а с парой ключей самой службы. Не совпало — строка не тратит
 * попытку, а ждёт возвращения в свой профиль.
 */
async function serviceForItem(
  item: OutboxItem
): Promise<{ kind: 'ready'; svc: MessagingService } | { kind: 'deferred'; reason: string }> {
  const svc = getMessagingService();
  if (!svc) return { kind: 'deferred', reason: 'no_messaging_service' };
  // NULL — строка от версий до v4.32.49: владельца у неё не записано,
  // отправляем как раньше, под текущей службой.
  if (item.ownerProfileId === null) return { kind: 'ready', svc };
  const svcPid = await svc.ownerProfileId();
  if (svcPid !== item.ownerProfileId) {
    log.info('outbox_service_other_profile', {
      id: item.id,
      itemPid: item.ownerProfileId,
      svcPid,
    });
    return { kind: 'deferred', reason: 'service_other_profile' };
  }
  return { kind: 'ready', svc };
}

export async function runSyncIfOnline(handlers?: SyncHandlers): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const state = await Network.getNetworkStateAsync();
    if (!state.isConnected) {
      log.info('sync_skipped_offline');
      return;
    }
    // v4.32.226: sweep dead-lettered (attempts >= MAX) and expired (age > TTL)
    // rows up front. These are never returned by outboxDrain, so without this
    // explicit purge they would linger forever — inflating the queue banner and
    // never honoring the 7-day dead-letter TTL the design intended.
    await outboxPurgeDead(OUTBOX_TTL_MS);
    const isMobile = Platform.OS === 'android' || Platform.OS === 'ios';

    // v4.32.49: определяем активный профиль — items с другим owner_profile_id пропускаем
    // (они будут обработаны, когда пользователь вернётся в тот профиль). NULL = legacy
    // items от версий до v4.32.49 обрабатываются как раньше — под активным профилем.
    const activeProfile = profileManager.getActiveProfile();
    const activePid = activeProfile?.id ?? null;

    const seenDmIds = new Set<string>();
    let sent = 0;

    // v4.32.500: очередь разбирается окном, а не одним куском. Раньше
    // outboxDrain поднимал в память и расшифровывал ВСЮ очередь — до десяти
    // тысяч строк по четверти мегабайта, — и неделя офлайна кончалась падением
    // по памяти в первую же секунду после возвращения сети. Причём падением
    // повторяющимся: ни одна строка не успевала уйти, очередь не убывала.
    //
    // Окно сдвигается на число строк, оставшихся лежать на своих местах
    // (чужой профиль, отложенная отправка, неудачная попытка). Удалённые
    // строки исчезают из выборки сами, поэтому их в сдвиг включать нельзя —
    // иначе следующее окно перепрыгнуло бы через ещё не разобранные конверты.
    let offset = 0;
    for (let pass = 0; pass < OUTBOX_DRAIN_PASSES; pass++) {
      const rawBatch = await outboxDrain(OUTBOX_DRAIN_LIMIT, offset, activePid);
      if (rawBatch.length === 0) break;
      const now = Date.now();
      let kept = 0;

      // v4.32.20: (1) dead-letter по TTL, (2) dedup по messageId (прошлый баг мог
      // насоздавать дубликатов), (3) удаление IPFS-only kinds на mobile, где IPFS выключен.
      // v4.32.49: (4) скип items с чужим owner_profile_id.
      const batch: OutboxItem[] = [];
      for (const item of rawBatch) {
        // Dead-letter: слишком старый
        if (now - item.createdAt > OUTBOX_TTL_MS) {
          await outboxDeleteById(item.id);
          log.info('outbox_dead_letter_ttl', { id: item.id, kind: item.kind, ageMs: now - item.createdAt });
          continue;
        }
        // IPFS-only items на mobile (kill switch) — удаляем сразу, никогда не доставим
        if (isMobile && !isIpfsEnabled() && (item.kind === 'msg' || item.kind === 'blob')) {
          await outboxDeleteById(item.id);
          log.info('outbox_ipfs_disabled_dropped', { id: item.id, kind: item.kind });
          continue;
        }
        // v4.32.49: item принадлежит другому профилю — пропускаем, не удаляем
        // (при следующем switchProfile на владельца мы его доставим).
        // v4.32.522: до сюда такие строки больше не доходят — их отсеивает сам
        // запрос. Проверка остаётся вторым рубежом: без неё будущий вызов
        // outboxDrain без профиля молча отправлял бы чужие конверты нашим
        // ключом, а такую ошибку не видно ни в логе, ни в интерфейсе.
        if (
          item.ownerProfileId !== null &&
          activePid !== null &&
          item.ownerProfileId !== activePid
        ) {
          log.info('outbox_skip_other_profile', {
            id: item.id,
            itemPid: item.ownerProfileId,
            activePid,
          });
          kept += 1;
          continue;
        }
        // Dedup для 'dm' по messageId — оставляем только первый экземпляр
        if (item.kind === 'dm') {
          try {
            const p = JSON.parse(item.payload) as { messageId?: string };
            if (p.messageId) {
              if (seenDmIds.has(p.messageId)) {
                await outboxDeleteById(item.id);
                log.info('outbox_dedup_removed', { id: item.id, messageId: p.messageId });
                continue;
              }
              seenDmIds.add(p.messageId);
            }
          } catch {
            /* malformed payload — обработаем в общем цикле */
          }
        }
        batch.push(item);
      }

      for (const item of batch) {
        // null — ни одна ветка не высказалась; разбирается ниже как неизвестный kind.
        let outcome: ItemOutcome | null = null;
        try {
          if (item.kind === 'msg') {
            const { topic, cidHint } = JSON.parse(item.payload) as {
              topic: unknown;
              cidHint: unknown;
            };
            // v4.32.202 (Round-32 #3): validate msg-kind outbox payload shape.
            if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256 ||
                !isPlainCid(cidHint)) {
              log.warn('outbox_msg_bad_shape', { id: item.id });
              outcome = { kind: 'delivered' }; // drop poisoned row
            } else {
              const ok = await pubsubPublish(topic, new TextEncoder().encode(cidHint));
              outcome = ok ? { kind: 'delivered' } : { kind: 'failed' };
            }
          } else if (item.kind === 'blob') {
            const { dataB64 } = JSON.parse(item.payload) as { dataB64: unknown };
            // v4.32.202 (Round-32 #3): validate blob-kind outbox payload shape.
            // Cap at ~14M base64 chars (≈ 10MB decoded).
            if (typeof dataB64 !== 'string' || dataB64.length === 0 || dataB64.length > 14_000_000) {
              log.warn('outbox_blob_bad_shape', { id: item.id });
              outcome = { kind: 'delivered' }; // drop poisoned row
            } else {
              const data = Buffer.from(dataB64, 'base64');
              const cid = await addToIpfs(new Uint8Array(data));
              outcome = cid ? { kind: 'delivered' } : { kind: 'failed' };
            }
          } else if (item.kind === 'dm') {
            // v4.32.198 (Round-28 #4): validate payload shape before retry.
            // A corrupt/migrated outbox row would otherwise spread unvalidated
            // fields into retrySendDm (non-string mediaCids, huge text).
            // v4.32.357: разбор переехал в social/dmRetryPayload — туда же, где
            // нагрузка собирается, иначе стороны расходятся молча (так и потерялась
            // ссылка на цитируемое сообщение).
            const p = parseDmRetryPayload(item.payload);
            if (!p) {
              log.warn('outbox_dm_bad_shape', { id: item.id });
              outcome = { kind: 'delivered' }; // drop so we don't retry forever
            } else {
              const service = await serviceForItem(item);
              if (service.kind === 'deferred') {
                outcome = service;
              } else {
                outcome = (await service.svc.retrySendDm(p)) ? { kind: 'delivered' } : { kind: 'failed' };
              }
            }
          } else if (item.kind === 'ctl') {
            // v4.32.431: «удалить у всех» и «изменить у всех». Дедупликации по
            // targetMessageId здесь намеренно нет: две правки одного сообщения —
            // это две разные строки, и оставить надо последнюю, а порядок выдачи
            // outboxDrain этого не гарантирует. Повтор служебного конверта
            // безвреден — приём удаляет по id и переписывает текст по id.
            const p = parseCtlRetryPayload(item.payload);
            if (!p) {
              log.warn('outbox_ctl_bad_shape', { id: item.id });
              outcome = { kind: 'delivered' }; // drop so we don't retry forever
            } else {
              const service = await serviceForItem(item);
              if (service.kind === 'deferred') {
                outcome = service;
              } else {
                outcome = (await service.svc.retrySendCtl(p)) ? { kind: 'delivered' } : { kind: 'failed' };
              }
            }
          }

          if (outcome === null) {
            // Строка неизвестного вида: доставить её нечем и никогда не будет
            // чем, поэтому она честно тратит попытки и уходит в dead-letter.
            log.warn('outbox_unknown_kind', { id: item.id, kind: item.kind });
            outcome = { kind: 'failed' };
          }
          if (outcome.kind === 'delivered') {
            // Удаляем ИЗ БД только после успешной доставки (раньше всё удалялось до обработки).
            await outboxDeleteById(item.id);
            sent += 1;
          } else if (outcome.kind === 'deferred') {
            // Отправлять было нечем — попытку не тратим. Строка дождётся тика,
            // на котором сервис уже поднят; от вечного ожидания её страхуют
            // TTL в 7 дней и FIFO-ограничение размера очереди.
            log.info('outbox_deferred', { id: item.id, kind: item.kind, reason: outcome.reason });
            kept += 1;
          } else {
            // v4.32.124 (AUDIT P1 Block 7): инкрементируем attempts — после
            // OUTBOX_MAX_ATTEMPTS item будет пропускаться outboxDrain (TTL в 7
            // дней его в итоге удалит). Без этого «сломанные» items крутились
            // бесконечно при каждом sync-цикле.
            //
            // v4.32.581: строка, которую эта попытка добила до предела, из
            // следующей выборки уже исключена запросом — в сдвиг окна она не
            // идёт, иначе один живой конверт был бы перепрыгнут.
            if (await outboxIncrementAttempts(item.id)) kept += 1;
          }
          handlers?.onMessageQueued?.(item);
        } catch (e) {
          log.warn('sync_item_failed', { err: e instanceof Error ? e.message : String(e) });
          // Элемент остаётся в outbox — при следующем sync попробуем снова.
          // Если попыток больше не осталось, в сдвиг окна он не идёт (см. выше).
          if (await outboxIncrementAttempts(item.id)) kept += 1;
        }
      }

      // Окно вернулось неполным — дальше в очереди ничего нет.
      if (rawBatch.length < OUTBOX_DRAIN_LIMIT) break;
      offset += kept;
    }
    handlers?.onSyncComplete?.(sent);
  } finally {
    syncing = false;
  }
}
