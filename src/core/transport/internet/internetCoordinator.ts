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
   * Кадры, разбор которых идёт прямо сейчас (v4.32.831).
   *
   * Держать надо не только упавшее. Пока кадр разбирается, он не лежит ни в
   * `failedOnce`, ни в `held` — для отметки его как будто нет вовсе, хотя
   * решение по нему ещё не принято. Считаем, а не помечаем: у двух кадров
   * одной пачки бывает одна и та же миллисекунда, и пометка снималась бы за
   * оба сразу.
   */
  const inFlight = new Map<number, number>();
  const hold = (atMs: number): void => {
    inFlight.set(atMs, (inFlight.get(atMs) ?? 0) + 1);
  };
  const release = (atMs: number): void => {
    const n = inFlight.get(atMs);
    if (n === undefined) return;
    if (n > 1) inFlight.set(atMs, n - 1);
    else inFlight.delete(atMs);
  };

  /**
   * Запомнить первый провал кадра и удержать на нём отметку.
   *
   * v4.32.831: потолок остался только у памяти о провалах. Раньше вместе с ней
   * сбрасывались и удержания — то есть пятьсот с лишним отложенных кадров разом
   * переставали держать отметку, и следующий же удачный кадр перешагивал их
   * все. Это потеря накопленного пачкой ровно в том случае, ради которого
   * удержание и заведено: долгий офлайн, служба ещё не поднялась, первые сотни
   * кадров отложены. Удержание снимает теперь только исход самого кадра —
   * «разобрано» или второй отказ подряд. Расти без предела `held` не может:
   * отметка стоит перед самым ранним из удержанных, значит relay эти кадры
   * приносит снова, а второй отказ их отпускает.
   */
  const rememberFailure = (atMs: number): void => {
    if (failedOnce.size > 512) failedOnce.clear();
    failedOnce.add(atMs);
    held.add(atMs);
  };

  /** Продвинуть отметку «докуда прочитано» — только вперёд и только по разобранному. */
  const advance = (atMs: number): void => {
    let target = atMs;
    for (const h of held) if (h <= target) target = h - 1;
    for (const h of inFlight.keys()) if (h <= target) target = h - 1;
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

  /**
   * Докуда мы закончили с кадрами — самое позднее такое время (v4.32.831).
   *
   * Кадры пачки заканчиваются не в том порядке, в каком пришли: дешёвый отброс
   * отвечает раньше, чем личное сообщение перед ним. Пока разбор раннего идёт,
   * отметка стоит перед ним — и без этой памяти, закончив ранний, она встала бы
   * на нём же, а разобранный поздний пришлось бы качать заново.
   */
  let doneUpTo = 0;
  const markDone = (atMs: number): void => {
    if (atMs > doneUpTo) doneUpTo = atMs;
    advance(doneUpTo);
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
      //
      // v4.32.831: кадр держит отметку с первой же строки разбора, а не с
      // момента, когда разбор упал. Раньше между приёмом и провалом он был для
      // отметки невидим — а между ними лежит вся работа: ECDH, поиск контакта,
      // несколько походов в SQLite. Соседний дешёвый кадр той же пачки успевал
      // ответить «разобрано» и унести отметку за ещё разбираемый; когда тот
      // отвечал «отложено», возвращать отметку было уже некуда — назад она не
      // ходит. Ночная пачка после офлайна — ровно этот случай: личное
      // сообщение разбирается долго, отброс рядом — мгновенно.
      void (async () => {
        hold(frameAtMs);
        let intake: EnvelopeIntake | null = null;
        let failure: unknown;
        try {
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
        } catch (e) {
          // `?? new Error` — от `throw undefined`: иначе провал неотличим от
          // его отсутствия.
          failure = e ?? new Error('unknown');
        }
        // Своё удержание снимаем ДО решения: иначе кадр не пустил бы отметку
        // дальше самого себя.
        release(frameAtMs);
        /** Второй провал того же кадра — отпускаем: он не транзиентный. */
        const giveUp = (why: string, err?: unknown): void => {
          held.delete(frameAtMs);
          log.warn(why, err === undefined ? {} : { err: err instanceof Error ? err.message : String(err) });
          markDone(frameAtMs);
        };
        if (failure !== undefined) {
          if (failedOnce.has(frameAtMs)) {
            // Отпускаем, иначе отметка встанет навсегда и накопленное будет
            // качаться по кругу.
            giveUp('internet_frame_handle_failed_again', failure);
            return;
          }
          rememberFailure(frameAtMs);
          log.warn('internet_frame_handle_failed', {
            err: failure instanceof Error ? failure.message : String(failure),
          });
          return;
        }
        if (intake === 'consumed') {
          held.delete(frameAtMs);
          failedOnce.delete(frameAtMs);
          markDone(frameAtMs);
          return;
        }
        if (failedOnce.has(frameAtMs)) {
          giveUp('internet_frame_deferred_again');
          return;
        }
        rememberFailure(frameAtMs);
        log.warn('internet_frame_deferred');
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
