// @stable v4.32.70 — НЕ ИЗМЕНЯТЬ без явного запроса.
// Причина: старт/стоп интернет-транспорта в одной секции с LAN; при ошибке
// получателя на другом WiFi/мобильном интернете перестанут приходить frame'ы.

import type { KeyPairBytes } from '../../crypto/keyManager';
import type { AppConfig } from '../../config';
import { loadConfig } from '../../config';
import { publicKeyToDidKey } from '../../identity/did';
import { log } from '../../logger';
import { getMessagingService } from '../../social/messaging';
import { getGroupMessagingService } from '../../social/groupMessaging';
import { isFeedFrame } from '../../social/feedTransport';
import { receiveFeedEnvelope } from '../../social/feedService';
import type { EnvelopeIntake } from '../envelopeIntake';
import { getInternetTransportSingleton } from './internetTransport';
import {
  WATERMARK_FLUSH_MS,
  loadBacklogWatermark,
  saveBacklogWatermark,
  sinceParam,
} from './relayBacklog';

let started = false;

/**
 * Последняя отметка, ещё не записанная в базу.
 *
 * Живёт на уровне модуля, а не в замыкании старта, чтобы `stop` мог дописать
 * её: приложение уходит в фон вместе с транспортом, и без этого последние до
 * десяти секунд принятого пришлось бы разбирать заново при следующем запуске.
 */
let pendingWatermark: { myDid: string; atMs: number } | null = null;

/**
 * Определяет тип envelope по первым байтам JSON (копия из lanCoordinator; держим
 * локально, чтобы не создавать циклическую зависимость LAN ↔ internet).
 */
function isGroupEnvelope(payload: Uint8Array): boolean {
  try {
    const preview = new TextDecoder().decode(payload.slice(0, 200));
    return /"type"\s*:\s*"group/.test(preview);
  } catch {
    return false;
  }
}

/**
 * Запуск InternetTransport (WebSocket sub + HTTP pub через ntfy.sh или
 * сконфигурированный relay). Работает в любой сети с интернетом — WiFi или
 * мобильные данные. Parallel с LAN: на одной WiFi оба транспорта активны,
 * MultiTransportRouter сам выберет приоритетный по success-rate.
 */
export async function startInternetTransportIfEnabled(
  pair: KeyPairBytes,
  cfg?: AppConfig,
): Promise<void> {
  const c = cfg ?? (await loadConfig());
  if (c.internet?.enabled === false) {
    log.info('internet_coordinator_disabled_by_config');
    return;
  }
  if (started) return;
  const myDid = publicKeyToDidKey(pair.publicKey);
  const transport = getInternetTransportSingleton();
  // v4.32.545: отметка «докуда мы уже прочитали relay». Читается один раз при
  // старте, дальше живёт в памяти и изредка уходит в базу — см. relayBacklog.
  // Именно она превращает переподключение в «догрузить всё пропущенное»:
  // раньше подписка всегда просила последние десять минут и накопленное за
  // ночь оставалось лежать на relay до истечения срока хранения.
  let watermark = await loadBacklogWatermark(myDid);
  let flushedAt = 0;
  // Кадры, разбор которых упал. Ключ — время кадра; хранится до перезапуска
  // транспорта. Первый провал держит отметку (кадр перезапросим), второй
  // провал того же кадра отпускает её: кадр, падающий стабильно, иначе
  // заставлял бы перекачивать весь накопленный месяц при каждом подключении.
  const failedOnce = new Set<number>();
  // v4.32.730: кадры, которые мы намерены перезапросить. Отметка не пойдёт
  // дальше самого раннего из них: пачка разбирается параллельно (транспорт
  // зовёт onFrame на каждое сообщение WS, не дожидаясь предыдущего), и
  // соседний удачный кадр иначе унёс бы отметку за тот, который мы удерживаем.
  // Именно так удержание при провале и не работало ни в одной пачке длиннее
  // одного кадра — то есть ровно там, где оно и нужно.
  const held = new Set<number>();

  /**
   * Запомнить первый провал кадра и удержать на нём отметку.
   *
   * Оба множества растут только на провалах, и потолок у них общий: длинная
   * сессия с плохой сетью иначе копила бы их без предела, а удержанная навсегда
   * отметка заставляла бы перекачивать весь накопленный месяц при каждом
   * подключении.
   */
  const rememberFailure = (atMs: number): void => {
    if (failedOnce.size > 512) {
      failedOnce.clear();
      held.clear();
    }
    failedOnce.add(atMs);
    held.add(atMs);
  };

  /** Продвинуть отметку «докуда прочитано» — только вперёд и только по разобранному. */
  const advance = (atMs: number): void => {
    let target = atMs;
    for (const h of held) if (h <= target) target = h - 1;
    // Кадры внутри пачки приходят не строго по возрастанию времени, и откат
    // отметки назад означал бы повторный разбор уже разобранного.
    if (target <= (watermark ?? 0)) return;
    watermark = target;
    pendingWatermark = { myDid, atMs: target };
    const now = Date.now();
    if (now - flushedAt < WATERMARK_FLUSH_MS) return;
    flushedAt = now;
    pendingWatermark = null;
    void saveBacklogWatermark(myDid, target);
  };

  transport.start({
    myDid,
    relayBase: c.internet?.relayBase,
    wsBase: c.internet?.wsBase,
    since: () => sinceParam(watermark, Date.now()),
    onFrame: (senderDid, payload, frameAtMs) => {
      // Симметрично lanCoordinator.onFrame: feed → group → DM.
      // v4.32.208: accept 0xF0 + 0xF1 (relay wrapper) — unwrap inside receiveFeedEnvelope.
      //
      // v4.32.614: отметка двигается ПОСЛЕ разбора, а не до него. Раньше время
      // кадра записывалось сразу по приёме, и кадр, на котором разбор упал
      // (база ещё не открыта, профиль не загружен, ключ занят), больше не
      // запрашивался никогда — relay его хранит, а мы его уже «прочитали».
      //
      // v4.32.730: разобран кадр или нет — приёмник теперь отвечает словом.
      // Раньше о транзиентной беде (справочник контактов не прочитался, служба
      // переписки ещё не поднята, состав группы недоступен, профиль
      // переключился посреди разбора) он сообщал одним `return`, снаружи
      // неотличимым от удачи, — и отметка перешагивала кадр, который relay
      // хранит ещё тридцать суток. Ловушка ниже срабатывала только на брошенное.
      void (async () => {
        /** Второй провал того же кадра — отпускаем: он не транзиентный. */
        const giveUp = (why: string, err?: unknown): void => {
          held.delete(frameAtMs);
          log.warn(why, err === undefined ? {} : { err: err instanceof Error ? err.message : String(err) });
          advance(frameAtMs);
        };
        try {
          let intake: EnvelopeIntake;
          if (isFeedFrame(payload)) {
            intake = await receiveFeedEnvelope(payload, senderDid);
          } else if (isGroupEnvelope(payload)) {
            // Службы может не быть вовсе — до её появления кадр не разобран.
            intake =
              (await getGroupMessagingService()?.receiveGroupEnvelope(payload, senderDid)) ??
              'deferred';
          } else {
            intake =
              (await getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid)) ??
              'deferred';
          }
          if (intake === 'consumed') {
            held.delete(frameAtMs);
            failedOnce.delete(frameAtMs);
            advance(frameAtMs);
            return;
          }
          if (failedOnce.has(frameAtMs)) {
            giveUp('internet_frame_deferred_again');
            return;
          }
          rememberFailure(frameAtMs);
          log.warn('internet_frame_deferred');
        } catch (e) {
          if (failedOnce.has(frameAtMs)) {
            // Отпускаем, иначе отметка встанет навсегда и накопленное будет
            // качаться по кругу.
            giveUp('internet_frame_handle_failed_again', e);
            return;
          }
          rememberFailure(frameAtMs);
          log.warn('internet_frame_handle_failed', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    },
  });
  started = true;
  log.info('internet_coordinator_started');
}

export function stopInternetTransportStack(): void {
  if (!started) return;
  if (pendingWatermark) {
    void saveBacklogWatermark(pendingWatermark.myDid, pendingWatermark.atMs);
    pendingWatermark = null;
  }
  try {
    getInternetTransportSingleton().stop();
  } catch {
    /* ignore */
  }
  started = false;
}
