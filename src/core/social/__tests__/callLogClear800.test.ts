/**
 * «Очистить» в истории звонков больше не отчитывается за то, чего не сделала
 * (v4.32.800).
 *
 * Дефект. Очистка гасила список в памяти и на экране, а до хранилища шла через
 * `kvDelete` — тот гасит ошибку по замыслу («уборка мусора не должна валить
 * вызывающего») — да ещё под пустым `catch`, и наружу отдавала `void`. Занятая
 * база означала: на экране пусто, на диске всё цело.
 *
 * Цена. Журнал звонков — это метаданные переписки: кому звонил, когда и чем
 * кончилось. Человек нажал «Очистить», увидел пустой список и на этом строит
 * остальное — отдаёт телефон, показывает экран. Возвращается журнал при
 * следующем запуске, то есть узнаёт он об этом позже всех, кому мог показать
 * телефон. Отказ приходит чаще всего в первую секунду после запуска — ровно
 * тогда, когда экран истории и открывают.
 *
 * Правка. Удаление проверяемое (`kvDeleteChecked`), с тем же повтором, что у
 * записи журнала: причина отказа одна — занятая база. Если не вышло и после
 * повторов, журнал возвращается в память и на экран, а ответ уходит наверх,
 * чтобы экран сказал словами.
 */
import fs from 'fs';
import path from 'path';

import {
  clearCallLog,
  disposeCallService,
  getCallLog,
  initCallService,
} from '../callService';
import { makePeer } from './callTestPeers';

const OWNER_PID = 7;
const OWNER_KEY = `p${OWNER_PID}:call_log`;
const LEGACY_KEY = 'call_log';

/** Что лежит в хранилище: ключ → значение. Очистка обязана его опустошить. */
const mockStore = new Map<string, string>();
/** Ключи, на которых удаление отвечает отказом (занятая база). */
let mockDeleteFails = new Set<string>();

const mockKvGetSecret = jest.fn(async (key: string): Promise<string | null> => mockStore.get(key) ?? null);
const mockKvSetSecret = jest.fn(async (key: string, value: string): Promise<boolean> => {
  mockStore.set(key, value);
  return true;
});
/**
 * Все обращения к удалению, обеими дверями.
 *
 * Проверки «не пустая» ниже смотрят сюда, а не на конкретное имя: до правки
 * очистка ходила через `kvDelete`, после — через `kvDeleteChecked`, и вопрос
 * «какие ключи она вообще трогает» к выбору двери отношения не имеет.
 */
const mockDeleted: string[] = [];

/** Само удаление: единственное место, где решается судьба ключа. */
function wipe(key: string): void {
  mockDeleted.push(key);
  if (mockDeleteFails.has(key)) throw new Error('database is locked');
  mockStore.delete(key);
}

const mockKvDeleteChecked = jest.fn(async (key: string): Promise<void> => { wipe(key); });
/** Настоящий kvDelete гасит ошибку — мок обязан вести себя так же. */
const mockKvDelete = jest.fn(async (key: string): Promise<void> => {
  try { wipe(key); } catch { /* ignore, как в local.ts */ }
});

jest.mock('../../storage/local', () => ({
  kvGetSecret: (key: string) => mockKvGetSecret(key),
  kvSetSecret: (key: string, value: string) => mockKvSetSecret(key, value),
  kvDelete: (key: string) => mockKvDelete(key),
  kvDeleteChecked: (key: string) => mockKvDeleteChecked(key),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: OWNER_PID }) },
}));

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class { close = jest.fn(); },
  RTCSessionDescription: class { constructor(value: unknown) { void value; } },
  RTCIceCandidate: class { constructor(value: unknown) { void value; } },
  mediaDevices: { getUserMedia: jest.fn() },
}));

jest.mock('../../transport/webrtc/signaling', () => ({
  getIceServers: jest.fn(async () => []),
  WebRTCSignaling: class {
    connect = jest.fn(async () => undefined);
    register = jest.fn();
    disconnect = jest.fn();
    sendHangup = jest.fn();
    sendIceCandidate = jest.fn();
    sendAnswer = jest.fn();
    sendOffer = jest.fn();
    onOffer = jest.fn();
    onAnswer = jest.fn();
    onIceCandidate = jest.fn();
    onHangup = jest.fn();
    onPeerUnavailable = jest.fn();
    onMissedCalls = jest.fn();
  },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({
    webrtc: { signalingUrl: 'http://signal.test', stunServers: [], turnServers: [] },
  })),
}));

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => undefined,
    isBlocked: (): boolean => false,
  },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const me = makePeer();

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * Поднять службу с непустым журналом: очищать должно быть что.
 *
 * Журнал кладём в хранилище заранее — `initCallService` поднимает его сам, и
 * это ровно тот путь, каким он возвращается после перезапуска.
 */
async function serviceWithLog(): Promise<void> {
  mockStore.set(OWNER_KEY, JSON.stringify([
    {
      id: 'e1',
      peerPubB64: me.pub,
      peerName: 'Рита',
      isVideo: false,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: Date.now() - 60_000,
      durationMs: null,
    },
  ]));
  await initCallService(me.pair, OWNER_PID);
}

beforeEach(async () => {
  await disposeCallService();
  mockStore.clear();
  mockDeleteFails = new Set<string>();
  mockDeleted.length = 0;
  mockKvDeleteChecked.mockClear();
  mockKvDelete.mockClear();
});

afterEach(async () => {
  await disposeCallService();
});

describe('очистка отвечает за то, что сделала', () => {
  it('удачная очистка: журнал стёрт и на экране, и в хранилище', async () => {
    await serviceWithLog();
    expect(getCallLog().length).toBeGreaterThan(0);
    expect(mockStore.has(OWNER_KEY)).toBe(true);

    expect(await clearCallLog()).toBe(true);
    expect(getCallLog()).toEqual([]);
    expect(mockStore.has(OWNER_KEY)).toBe(false);
  });

  it('занятая база: очистка признаётся, и журнал возвращается на экран', async () => {
    await serviceWithLog();
    const before = getCallLog();
    mockDeleteFails.add(OWNER_KEY);

    expect(await clearCallLog()).toBe(false);
    // Пустой экран поверх уцелевшего журнала — та самая ложь, ради которой
    // правка и делалась.
    expect(getCallLog()).toEqual(before);
    expect(mockStore.has(OWNER_KEY)).toBe(true);
  });

  it('до отказа доходит не с первой попытки: повтор есть', async () => {
    await serviceWithLog();
    mockDeleteFails.add(OWNER_KEY);
    mockDeleted.length = 0;

    await clearCallLog();
    // Занятая база чаще всего отпускает через долю секунды — ради этого повтор
    // и стоит; одиночное «не смог» отказом считать рано.
    expect(mockDeleted.filter((k) => k === OWNER_KEY).length).toBeGreaterThan(1);
  });

  it('уцелевший legacy-ключ тоже отказ: иначе очистка отменится сама собой', async () => {
    await serviceWithLog();
    mockStore.set(LEGACY_KEY, '[]');
    mockDeleteFails.add(LEGACY_KEY);

    // Следующий loadCallLog поднял бы старый журнал как «миграцию».
    expect(await clearCallLog()).toBe(false);
    expect(getCallLog().length).toBeGreaterThan(0);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не задета', () => {
  it('стираются оба ключа — и владельца, и legacy', async () => {
    await serviceWithLog();
    mockDeleted.length = 0;

    await clearCallLog();
    expect(mockDeleted).toContain(OWNER_KEY);
    expect(mockDeleted).toContain(LEGACY_KEY);
  });

  it('без поднятой службы хранилище не трогается вовсе', async () => {
    await clearCallLog();
    expect(mockDeleted).toEqual([]);
  });

  it('удачная очистка повтора не делает', async () => {
    await serviceWithLog();
    mockDeleted.length = 0;

    await clearCallLog();
    expect(mockDeleted).toHaveLength(2); // ровно два ключа, по одному разу
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvDelete молчит об отказе — на нём очистке стоять нельзя', () => {
    const body = codeOnly(read('core/storage/local.ts'));
    const at = body.indexOf('export async function kvDelete(key: string): Promise<void> {');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at, at + 260);
    expect(tail).toContain('await kvDeleteChecked(key);');
    expect(tail).toContain("log.warn('kv_delete_failed'");
  });

  it('журнал поднимается с диска при каждом запуске — уцелевший вернётся', () => {
    const body = codeOnly(read('core/social/callService.ts'));
    expect(body).toContain('export async function loadCallLog(pid: number): Promise<void> {');
    expect(body).toContain('let raw = await kvGetSecret(callLogKey(pid));');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('очистка называет исход словом', () => {
    const body = codeOnly(read('core/social/callService.ts'));
    expect(body).toContain('export async function clearCallLog(): Promise<boolean> {');
    expect(body).not.toContain('export async function clearCallLog(): Promise<void> {');
  });

  it('удаление проверяемое и с повтором', () => {
    const body = codeOnly(read('core/social/callService.ts'));
    const at = body.indexOf('export async function clearCallLog(): Promise<boolean> {');
    const tail = body.slice(at, at + 1600);
    expect(tail).toContain("const { kvDeleteChecked } = await import('../storage/local');");
    expect(tail).toContain('for (let attempt = 0; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {');
    expect(tail).toContain("log.warn('call_log_clear_failed'");
    expect(tail).not.toContain('catch { /* ignore */ }');
  });

  it('экран ставит пустой список только на удачу', () => {
    const body = codeOnly(read('ui/screens/ProfileScreen.tsx'));
    const at = body.indexOf('void clearCallLog().then((ok) => {');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at, at + 320);
    expect(tail).toContain('if (ok) setCallLogEntries([]);');
    expect(tail).toContain('Alert.alert(');
    // Безусловного опустошения списка больше нет.
    expect(body).not.toContain('void clearCallLog().then(() => setCallLogEntries([]));');
  });
});
