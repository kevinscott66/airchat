/**
 * Жизненный цикл сессии живой геолокации (v4.32.524).
 *
 * Сессия попадала в реестр последней строкой startLiveLocSession — уже после
 * первой отправки координат и после setInterval. Полминуты (столько занимает
 * запрос позиции у операционной системы в худшем случае) сессии не
 * существовало ни для кого:
 *  - getActiveLiveLoc её не находил, и второе нажатие «поделиться» заводило
 *    вторую сессию поверх первой — обе слали координаты, а остановить можно
 *    было только последнюю;
 *  - stopLiveLocSession, вызванный изнутри самой первой отправки (проверка на
 *    смену профиля), не находил, что останавливать, — и таймер всё равно
 *    заводился и висел до истечения срока;
 *  - вызывающий получал номер сессии только по возврату, а первая посылка
 *    приходила к нему раньше — с номером null.
 */
let mockUuidN = 0;
jest.mock('uuid', () => ({ v4: () => `live-${++mockUuidN}` }));

let mockPid: number | null = 7;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => (mockPid === null ? null : { id: mockPid }) },
}));

const mockPositions: jest.Mock = jest.fn(async () => ({ lat: 55.75, lon: 37.61 }));
jest.mock('../deviceLocation', () => ({ readCurrentPosition: () => mockPositions() }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getActiveLiveLoc,
  startLiveLocSession,
  stopLiveLocSession,
  stopAllLiveLocSessions,
  LIVELOC_UPDATE_INTERVAL_MS,
} from '../liveLocationService';
import type { LiveLocPayload } from '../locationEnvelope';

const PEER = 'peer-A';

beforeEach(() => {
  jest.useFakeTimers();
  mockUuidN = 0;
  mockPid = 7;
  mockPositions.mockClear();
});

afterEach(() => {
  stopAllLiveLocSessions();
  jest.useRealTimers();
});

/** Дать очереди микрозадач провернуться под фальшивыми часами. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('проверка не пустая', () => {
  it('координаты берутся у системы и доходят до обработчика', async () => {
    const seen: LiveLocPayload[] = [];
    await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async (p) => { seen.push(p); },
      onExpire: () => { /* noop */ },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].lat).toBe(55.75);
    expect(seen[0].lon).toBe(37.61);
  });
});

describe('первая посылка', () => {
  it('несёт номер сессии — тот же, что вернётся вызывающему', async () => {
    let firstId: string | null = null;
    const liveId = await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async (p) => { firstId ??= p.liveId; },
      onExpire: () => { /* noop */ },
    });
    expect(firstId).toBe(liveId);
    expect(firstId).toBe('live-1');
  });

  it('сессия уже в реестре, пока идёт первая отправка', async () => {
    let foundDuringFirst: string | null = null;
    await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => { foundDuringFirst = getActiveLiveLoc(PEER)?.liveId ?? null; },
      onExpire: () => { /* noop */ },
    });
    expect(foundDuringFirst).toBe('live-1');
  });

  it('второе нажатие во время первой отправки не плодит вторую трансляцию', async () => {
    // Прежде реестр был пуст, getActiveLiveLoc возвращал null, и первая
    // сессия оставалась висеть без владельца.
    let second: string | null = null;
    await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => {
        if (second) return;
        second = getActiveLiveLoc(PEER)?.liveId ?? null;
      },
      onExpire: () => { /* noop */ },
    });
    expect(second).toBe('live-1');
  });
});

describe('остановка', () => {
  it('явная остановка гасит таймер: новых посылок нет', async () => {
    const liveId = await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => { /* noop */ },
      onExpire: () => { /* noop */ },
    });
    expect(mockPositions).toHaveBeenCalledTimes(1);
    stopLiveLocSession(liveId);
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS * 3);
    await settle();
    expect(mockPositions).toHaveBeenCalledTimes(1);
    expect(getActiveLiveLoc(PEER)).toBeNull();
  });

  it('остановка прямо во время первой отправки не оставляет таймера', async () => {
    await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async (p) => { stopLiveLocSession(p.liveId); },
      onExpire: () => { /* noop */ },
    });
    expect(getActiveLiveLoc(PEER)).toBeNull();
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS * 3);
    await settle();
    expect(mockPositions).toHaveBeenCalledTimes(1);
  });

  it('смена профиля на первом же такте останавливает сессию', async () => {
    await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => { /* noop */ },
      onExpire: () => { /* noop */ },
      // профиль сменится до чтения координат
    });
    // Первая отправка уже прошла при профиле 7. Теперь профиль другой.
    mockPid = 9;
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS);
    await settle();
    expect(getActiveLiveLoc(PEER)).toBeNull();
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS * 3);
    await settle();
    expect(mockPositions).toHaveBeenCalledTimes(1);
  });

  it('повторный запуск на того же собеседника гасит предыдущую сессию', async () => {
    const first = await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => { /* noop */ },
      onExpire: () => { /* noop */ },
    });
    const second = await startLiveLocSession({
      peerPubB64: PEER,
      durationMinutes: 15,
      onUpdate: async () => { /* noop */ },
      onExpire: () => { /* noop */ },
    });
    expect(second).not.toBe(first);
    expect(getActiveLiveLoc(PEER)?.liveId).toBe(second);
    const before = mockPositions.mock.calls.length;
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS);
    await settle();
    // Ровно одна новая посылка: старый таймер снят.
    expect(mockPositions).toHaveBeenCalledTimes(before + 1);
  });

  it('stopAllLiveLocSessions чистит реестр целиком', async () => {
    await startLiveLocSession({
      peerPubB64: PEER, durationMinutes: 15,
      onUpdate: async () => { /* noop */ }, onExpire: () => { /* noop */ },
    });
    await startLiveLocSession({
      peerPubB64: '', groupId: 'g1', durationMinutes: 15,
      onUpdate: async () => { /* noop */ }, onExpire: () => { /* noop */ },
    });
    stopAllLiveLocSessions();
    expect(getActiveLiveLoc(PEER)).toBeNull();
    expect(getActiveLiveLoc('', 'g1')).toBeNull();
  });
});

describe('ход и истечение', () => {
  it('каждые полминуты уходит новая посылка', async () => {
    await startLiveLocSession({
      peerPubB64: PEER, durationMinutes: 15,
      onUpdate: async () => { /* noop */ }, onExpire: () => { /* noop */ },
    });
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS);
    await settle();
    jest.advanceTimersByTime(LIVELOC_UPDATE_INTERVAL_MS);
    await settle();
    expect(mockPositions).toHaveBeenCalledTimes(3);
  });

  it('по истечении срока сессия снимается и об этом сообщают', async () => {
    let expired = 0;
    await startLiveLocSession({
      peerPubB64: PEER, durationMinutes: 15,
      onUpdate: async () => { /* noop */ }, onExpire: () => { expired += 1; },
    });
    jest.advanceTimersByTime(16 * 60_000);
    await settle();
    expect(expired).toBe(1);
    expect(getActiveLiveLoc(PEER)).toBeNull();
  });

  it('отказ системы в координатах не роняет сессию', async () => {
    mockPositions.mockRejectedValueOnce(new Error('нет разрешения'));
    const liveId = await startLiveLocSession({
      peerPubB64: PEER, durationMinutes: 15,
      onUpdate: async () => { /* noop */ }, onExpire: () => { /* noop */ },
    });
    expect(getActiveLiveLoc(PEER)?.liveId).toBe(liveId);
  });
});
