/**
 * ДЕФЕКТ (v4.32.1055). Не прочитанная при запуске отметка «был(а) в сети»
 * превращалась в «не в сети» на весь сеанс.
 *
 * `loadPersistedPresence` читала её двузначным `scopedKvGetFor`, а тот отдаёт
 * `null` и когда записи нет, и когда база не ответила. `catch { ignore }`
 * вокруг не срабатывал никогда — обёртка гасит ошибку внутри себя, — так что
 * отказ уходил вообще без следа.
 *
 * ЦЕНА. Читается это место ровно один раз за запуск (`App.tsx`), и другого
 * пути у отметки нет: `recordPeerActivity` оживляет только тех, от кого пришло
 * сообщение, а обход раз в минуту на телефоне не заводится вовсе — pubsub там
 * выключен, и `startPresenceBroadcast` выходит до таймеров. Один занятый такт
 * базы при старте — и человек показан «не в сети» до перезапуска приложения,
 * и его нет в счётчике «сейчас в сети» у групп. Рядом, в переносе имён
 * ключей, различающее чтение уже стоит и прямо названо этой же причиной.
 *
 * ПРАВКА. Чтение стало различающим (`scopedKvTryGetFor`), непрочитанные
 * складываются в `lastSeenUnread`, и повтор пробует их ещё трижды с растущей
 * паузой. Отказ заодно попадает в журнал.
 *
 * ГРАНИЦЫ. Прочитанное отсутствие записи — по-прежнему «не в сети»: это
 * правда. Повтор не затирает то, что успело приехать сообщением, не трогает
 * просивших себя не отмечать и уходит вместе со службой при переключении
 * профиля.
 */
const mockKv = new Map<string, string>();
/** Ключи, чтение которых база не выполняет («не ответила», а не «пусто»). */
const mockFailReads = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); return true; },
  kvTryListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
  kvSetSecret: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvGetSecretCellScoped: async (pid: number, k: string) => {
    const scoped = `p${pid}:${k}`;
    if (mockFailReads.has(scoped)) return { state: 'unreadable' };
    const raw = mockKv.get(scoped);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  },
}));

jest.mock('../../storage/localEncryption', () => ({
  getOrCreateDataEncryptionKey: async () => new Uint8Array(32).fill(7),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 2, name: 'П', did: 'did:key:z1' }),
    getAllProfiles: () => [{ id: 2, name: 'Личный', did: 'did:key:z1' }],
  },
}));

jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: async () => '' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => null, pubsubSubscribe: async () => null }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({ listContacts: async () => [], listContactsFor: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({ privacyPrefTryGet: async () => ({ value: 'everybody' }) }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import * as fs from 'fs';
import * as path from 'path';

import {
  getPresenceState,
  loadPersistedPresence,
  presenceLastSeenKey,
  recordPeerActivity,
  stopPresenceBroadcast,
} from '../presenceService';
import { scopedKvGetFor } from '../../storage/profileScopedKv';

const PEER = 'ключСобеседника==';
const PID = 2;
const WHEN = Date.now() - 60_000;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const SERVICE = () => read('core', 'social', 'presenceService.ts');

/** Имя ключа отметки так, как его видит база: с номером профиля впереди. */
async function scopedKeyFor(peer: string): Promise<string> {
  return `p${PID}:${await presenceLastSeenKey(peer)}`;
}

/** Дать волю тому, что вызывающий не ждёт. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(async () => {
  jest.useRealTimers();
  mockKv.clear();
  mockFailReads.clear();
  await stopPresenceBroadcast();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('непрочитанная отметка не выдаётся за «не в сети»', () => {
  it('повтор поднимает её, когда база отвечает', async () => {
    const key = await scopedKeyFor(PEER);
    mockKv.set(key, String(WHEN));
    mockFailReads.add(key);

    jest.useFakeTimers();
    await loadPersistedPresence([PEER], PID);
    // Пока не прочитали — ничего не выдумываем.
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);

    mockFailReads.clear();
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(getPresenceState(PEER).lastActiveAt).toBe(WHEN);
    expect(getPresenceState(PEER).bucket).not.toBe('never');
  });

  it('вторая попытка есть: одного такта базы мало', async () => {
    const key = await scopedKeyFor(PEER);
    mockKv.set(key, String(WHEN));
    mockFailReads.add(key);

    jest.useFakeTimers();
    await loadPersistedPresence([PEER], PID);
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);

    mockFailReads.clear();
    await jest.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(WHEN);
  });

  it('ГРАНИЦА: прочитанное отсутствие записи остаётся «не в сети»', async () => {
    jest.useFakeTimers();
    await loadPersistedPresence([PEER], PID);
    await jest.advanceTimersByTimeAsync(200_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
    expect(getPresenceState(PEER).bucket).toBe('never');
  });

  it('ГРАНИЦА: пришедшее сообщением свежее не затирается прочитанным с диска', async () => {
    const key = await scopedKeyFor(PEER);
    mockKv.set(key, String(WHEN));
    mockFailReads.add(key);

    jest.useFakeTimers();
    await loadPersistedPresence([PEER], PID);
    const fresh = Date.now();
    recordPeerActivity(PEER, fresh);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(fresh);

    mockFailReads.clear();
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    // Диск помнит старое время; оно младше и в память не идёт.
    expect(getPresenceState(PEER).lastActiveAt).toBe(fresh);
  });

  it('ЗАКРЕПКА: остановка службы снимает повтор вместе с остальными таймерами', async () => {
    const key = await scopedKeyFor(PEER);
    mockKv.set(key, String(WHEN));
    mockFailReads.add(key);

    jest.useFakeTimers();
    await loadPersistedPresence([PEER], PID);
    await stopPresenceBroadcast();
    mockFailReads.clear();
    await jest.advanceTimersByTimeAsync(200_000);
    await settle();
    // Служба остановлена — кэш пуст, и ожившее чтение его не наполняет.
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });
});

describe('служба читает различающим чтением', () => {
  it('двузначного scopedKvGetFor в присутствии не осталось', () => {
    const src = SERVICE();
    expect(src).not.toContain("  scopedKvGetFor,");
    expect(src).toContain('scopedKvTryGetFor');
  });

  it('чтение отметки различает отказ и пустоту', () => {
    const src = SERVICE();
    expect(src).toContain('async function readPersistedLastSeen');
    expect(src).toContain('if (read === null) return false;');
  });

  it('непрочитанные складываются отдельно от прочитанных', () => {
    expect(SERVICE()).toContain('lastSeenUnread.add(k)');
  });

  it('повтор ограничен, а не вечен', () => {
    expect(SERVICE()).toContain('LAST_SEEN_RETRY_DELAYS_MS');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('прочитанная отметка поднимается и без всяких повторов', async () => {
    mockKv.set(await scopedKeyFor(PEER), String(WHEN));
    await loadPersistedPresence([PEER], PID);
    expect(getPresenceState(PEER).lastActiveAt).toBe(WHEN);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: scopedKvGetFor по-прежнему отвечает null на отказ', async () => {
    const plain = 'presence:last_seen:проверка';
    mockFailReads.add(`p${PID}:${plain}`);
    // То же самое, что и «ничего не записано», — различить нечем.
    await expect(scopedKvGetFor(PID, plain)).resolves.toBeNull();
    mockFailReads.clear();
    await expect(scopedKvGetFor(PID, plain)).resolves.toBeNull();
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: обход раз в минуту на телефоне не заводится', () => {
    const src = SERVICE();
    expect(src).toContain('if (!isIpfsEnabled()) {');
    const at = src.indexOf('if (!isIpfsEnabled()) {');
    // Таймер повторной подписки заводится ПОСЛЕ этого выхода.
    expect(src.indexOf('retrySweepTimer = setInterval')).toBeGreaterThan(at);
  });
});
