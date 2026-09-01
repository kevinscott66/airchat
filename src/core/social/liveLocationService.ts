/**
 * liveLocationService — управление сессиями живой геолокации.
 * Отправляет обновления координат каждые 30 секунд, пока не истечёт время.
 */
import { v4 as uuidv4 } from 'uuid';
import { log } from '../logger';
// v4.32.524: профиль и координаты берутся обычными импортами. Оба брались
// динамически, а динамический импорт здесь был обёрнут в catch: любая осечка
// загрузки молча выключала защиту от смены профиля (sessionPid оставался null)
// или превращала отправку в запись в журнале. Оба модуля и так лежат в графе
// экрана переписки, откуда сессию и запускают.
import { profileManager } from '../identity/profileManager';
import { readCurrentPosition } from './deviceLocation';

// Разбор конверта переехал в core/social/locationEnvelope.ts: подпись места
// бралась из сети без чистки, а проверить это отдельно было нельзя — здесь
// uuid, expo-location и профили. Реэкспорт — чтобы импорты экранов остались
// на месте.
export {
  LIVELOC_PREFIX,
  isLiveLocMessage,
  makeLiveLocText,
  parseLiveLoc,
  type LiveLocPayload,
} from './locationEnvelope';

import type { LiveLocPayload } from './locationEnvelope';
import { pickLiveLocSession } from './liveLocSelect';

export const LIVELOC_UPDATE_INTERVAL_MS = 30_000; // 30 секунд

export type LiveLocDuration = 15 | 60 | 480; // минуты

// ─── Active session tracking ──────────────────────────────────────────────────

type LiveLocSession = {
  liveId: string;
  peerPubB64: string; // DM peer — empty for group
  groupId: string | null;
  expireAt: number;
  /**
   * v4.32.524: null, пока идёт первая отправка. Сессия попадает в реестр до
   * неё, а таймер заводится после — иначе полминуты сессии не существовало
   * ни для кого: getActiveLiveLoc её не находил, второе нажатие заводило
   * вторую поверх первой, а stopLiveLocSession изнутри первой же отправки
   * (смена профиля) не находил, что останавливать, и таймер всё равно
   * заводился.
   */
  intervalId: ReturnType<typeof setInterval> | null;
  /**
   * Флаг остановки живёт на записи, а не в замыкании: остановить сессию
   * теперь можно снаружи и до того, как замыкание вернуло управление.
   */
  stopped: boolean;
};

const activeSessions: Map<string, LiveLocSession> = new Map(); // liveId → session

/**
 * Живая сессия для этой переписки или группы, если она есть.
 *
 * v4.32.524: сам выбор переехал в liveLocSelect — модуль без импортов, где
 * его можно проверить отдельно от uuid, expo-location и профилей. Разделение
 * веток «личная переписка / группа» (Round-21 #6) сохранено там же.
 */
export function getActiveLiveLoc(peerPubB64: string, groupId?: string): LiveLocSession | null {
  return pickLiveLocSession(activeSessions.values(), { peerPubB64, groupId }, Date.now());
}

/**
 * Start a live location session for a DM or group.
 * @param opts.durationMinutes 15 | 60 | 480
 * @param opts.onUpdate called with the latest LiveLocPayload each tick (and immediately)
 * @param opts.onExpire called when the session expires naturally
 * @returns the liveId (use as the message ID in the chat)
 */
export async function startLiveLocSession(opts: {
  peerPubB64: string;
  groupId?: string;
  durationMinutes: LiveLocDuration;
  onUpdate: (payload: LiveLocPayload) => Promise<void>;
  onExpire: () => void;
}): Promise<string> {
  const { peerPubB64, groupId, durationMinutes, onUpdate, onExpire } = opts;
  // Stop any existing session for this peer/group
  const existing = getActiveLiveLoc(peerPubB64, groupId);
  if (existing) stopLiveLocSession(existing.liveId);

  const liveId = uuidv4();
  const expireAt = Date.now() + durationMinutes * 60_000;

  // v4.32.187 (Round-17 #2): capture active profile at session start so a
  // later profile switch aborts this session instead of broadcasting the
  // prior user's coordinates under the new identity.
  const sessionPid: number | null = profileManager.getActiveProfile()?.id ?? null;

  // v4.32.188 (Round-18 #7): флаг остановки закрывает промежуток между
  // истечением (или явной остановкой) и уже начатым чтением координат — раньше
  // после этого уходила ещё одна посылка с координатами «после срока».
  // v4.32.524: флаг переехал на запись сессии, а сама запись — в реестр до
  // первой отправки.
  const session: LiveLocSession = {
    liveId,
    peerPubB64,
    groupId: groupId ?? null,
    expireAt,
    intervalId: null,
    stopped: false,
  };
  activeSessions.set(liveId, session);

  const sendUpdate = async () => {
    try {
      if (session.stopped) return;
      if (sessionPid !== null && profileManager.getActiveProfile()?.id !== sessionPid) {
        stopLiveLocSession(liveId);
        return;
      }
      const coords = await readCurrentPosition();
      const sentAt = Date.now();
      if (session.stopped || sentAt >= expireAt) return;
      // v4.32.563: время отправки едет вместе с координатами. Без него у
      // получателя не было никакого признака того, что рассылка оборвалась
      // (закрыли приложение, выгрузила система, сменили профиль): пузырь
      // держал зелёную плашку LIVE до самого expireAt над неподвижной точкой.
      const payload: LiveLocPayload = {
        lat: coords.lat,
        lon: coords.lon,
        expireAt,
        liveId,
        label: '',
        ts: sentAt,
      };
      await onUpdate(payload);
    } catch (e) {
      log.warn('liveloc_update_failed', { liveId, err: e instanceof Error ? e.message : String(e) });
    }
  };

  // Первая посылка — сразу. Номер сессии уже известен и лежит в payload.liveId,
  // так что вызывающему не нужно ждать возврата, чтобы её записать.
  await sendUpdate();

  // Остановили, пока шла первая отправка (смена профиля, явный stop): таймер
  // заводить незачем — раньше он заводился и висел до истечения впустую.
  if (session.stopped) return liveId;

  session.intervalId = setInterval(() => {
    if (Date.now() >= expireAt) {
      stopLiveLocSession(liveId);
      onExpire();
      return;
    }
    void sendUpdate();
  }, LIVELOC_UPDATE_INTERVAL_MS);

  return liveId;
}

export function stopLiveLocSession(liveId: string): void {
  const session = activeSessions.get(liveId);
  if (!session) return;
  // Пометка остаётся видна замыканию отправки и после удаления из реестра:
  // объект живёт, пока на него ссылается уже начатое чтение координат.
  session.stopped = true;
  if (session.intervalId !== null) clearInterval(session.intervalId);
  activeSessions.delete(liveId);
  log.info('liveloc_stopped', { liveId });
}

export function stopAllLiveLocSessions(): void {
  for (const liveId of activeSessions.keys()) stopLiveLocSession(liveId);
}
