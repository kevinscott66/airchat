/**
 * v4.32.642: «список запретов не прочитался» — не «никто не просил».
 *
 * Просьбу «не показывай, когда я был в сети» исполняет получатель, и исполнить
 * её можно единственным способом — не собирая отметки. Список тех, кто её
 * прислал, лежит в той же базе, что и переписка, а читался он через
 * scopedKvGetFor: тот отвечает одним `null` и на «никто не просил», и на «не
 * прочиталось». Разница между этими двумя ответами — ровно сама просьба.
 *
 * Что получалось до этой версии:
 *   - заминка при старте оставляла список пустым, и время входа собиралось и
 *     показывалось именно про тех, кто просил себя не отмечать;
 *   - чужому аккаунту (не на экране) отметка писалась по тому же пустому
 *     списку;
 *   - а запись просьбы собирала список заново из одного собеседника и клала
 *     его поверх накопленного — один сбой чтения стирал все запреты разом,
 *     хотя шапка persistHiddenPeerFor обещала обратное.
 *
 * Отменить записанное время нельзя, не записать — можно: пока ответа нет,
 * действует осторожное «возможно, просил».
 */

const mockKv = new Map<string, string>();
/** Ключи, чтение которых «не удалось»: kvTryGet отвечает на них null. */
let mockFailHidden = false;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => {
    if (mockFailHidden && k.includes('presence:hidden_peers')) return null;
    return { value: mockKv.get(k) ?? null };
  },
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }),
    getAllProfiles: () => [
      { id: 1, name: 'Личный', did: 'did:key:z1' },
      { id: 2, name: 'Рабочий', did: 'did:key:z2' },
    ],
  },
}));

jest.mock('../../identity/ownProfile', () => ({ ownFieldGetFor: async () => '' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => null, pubsubSubscribe: async () => null }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => false }));
jest.mock('../contacts', () => ({ listContacts: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({ privacyPrefTryGet: async () => ({ value: 'everybody' }) }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import {
  loadPersistedPresence,
  presenceLastSeenKey,
  recordPeerActivity,
  recordPeerActivityFor,
  setPeerLastSeenAllowed,
  setPeerLastSeenAllowedFor,
  getPresenceState,
  stopPresenceBroadcast,
} from '../presenceService';
import { scopedKvGetFor, scopedKvTryGetFor } from '../../storage/profileScopedKv';
import { parseHiddenPeers } from '../hiddenPeers';

const PEER = 'скрытныйСобеседник==';
const OTHER = 'обычныйСобеседник==';
const HIDDEN_KEY = 'presence:hidden_peers';
const ON_SCREEN = 1;
const LATE = 2;
const TS = 1_700_000_000_000;

/** Дать волю void-записям в kv: они не ожидаются вызывающим. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  mockFailHidden = false;
  mockKv.clear();
  await stopPresenceBroadcast();
});

describe('повод для правки жив', () => {
  it('scopedKvGetFor отвечает одинаково на «нет записи» и на «не прочиталось»', async () => {
    expect(await scopedKvGetFor(ON_SCREEN, HIDDEN_KEY)).toBeNull();
    mockFailHidden = true;
    expect(await scopedKvGetFor(ON_SCREEN, HIDDEN_KEY)).toBeNull();
    // Отличить их можно только вторым чтением — его и завели в v4.32.474.
    expect(await scopedKvTryGetFor(ON_SCREEN, HIDDEN_KEY)).toBeNull();
    mockFailHidden = false;
    expect(await scopedKvTryGetFor(ON_SCREEN, HIDDEN_KEY)).toEqual({ value: null });
  });

  it('и просьба «не отмечай меня» действительно останавливает запись', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowed(PEER, false);
    await settle();
    recordPeerActivity(PEER, TS);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });
});

describe('проверка не пустая: с читаемым списком всё работает как прежде', () => {
  it('время записывается и показывается', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivity(OTHER, TS);
    await settle();
    expect(mockKv.get(`p${ON_SCREEN}:${presenceLastSeenKey(OTHER)}`)).toBe(String(TS));
    expect(getPresenceState(OTHER).lastActiveAt).toBe(TS);
  });

  it('чужому аккаунту тоже', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(LATE, OTHER, TS);
    await settle();
    expect(mockKv.get(`p${LATE}:${presenceLastSeenKey(OTHER)}`)).toBe(String(TS));
  });

  it('а просьба ложится в список, не трогая соседние', async () => {
    mockKv.set(`p${LATE}:${HIDDEN_KEY}`, JSON.stringify(['первый==', 'второй==']));
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    expect(parseHiddenPeers(mockKv.get(`p${LATE}:${HIDDEN_KEY}`)))
      .toEqual(['первый==', 'второй==', PEER]);
  });
});

describe('список не прочитался', () => {
  it('время последнего входа не записывается', async () => {
    mockFailHidden = true;
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivity(OTHER, TS);
    await settle();
    expect(mockKv.has(`p${ON_SCREEN}:${presenceLastSeenKey(OTHER)}`)).toBe(false);
    expect(getPresenceState(OTHER).lastActiveAt).toBe(0);
  });

  it('и не показывается то, что уже лежит на диске', async () => {
    mockKv.set(`p${ON_SCREEN}:${presenceLastSeenKey(OTHER)}`, String(TS));
    mockFailHidden = true;
    await loadPersistedPresence([OTHER], ON_SCREEN);
    expect(getPresenceState(OTHER).lastActiveAt).toBe(0);
  });

  it('но первое удачное чтение возвращает обычный ход', async () => {
    mockFailHidden = true;
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivity(OTHER, TS);
    await settle();
    expect(mockKv.has(`p${ON_SCREEN}:${presenceLastSeenKey(OTHER)}`)).toBe(false);
    // База ответила — следующая же активность записывается, без перезапуска.
    mockFailHidden = false;
    recordPeerActivity(OTHER, TS);
    await settle();
    expect(mockKv.get(`p${ON_SCREEN}:${presenceLastSeenKey(OTHER)}`)).toBe(String(TS));
    expect(getPresenceState(OTHER).lastActiveAt).toBe(TS);
  });

  it('и просьба, дошедшая до памяти, при перечитывании не теряется', async () => {
    mockFailHidden = true;
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowed(PEER, false);
    await settle();
    mockFailHidden = false;
    // Перечитывание идёт объединением, а не заменой: записи на диске может ещё
    // не быть, но в памяти просьба уже принята. Само поле не пустое — просьба
    // затирает прежнее время нулём, — поэтому проверяем именно значение.
    expect(mockKv.get(`p${ON_SCREEN}:${presenceLastSeenKey(PEER)}`)).toBe('0');
    recordPeerActivity(PEER, TS);
    await settle();
    expect(mockKv.get(`p${ON_SCREEN}:${presenceLastSeenKey(PEER)}`)).toBe('0');
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });

  it('чужому аккаунту время тоже не записывается', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    mockFailHidden = true;
    recordPeerActivityFor(LATE, OTHER, TS);
    await settle();
    expect(mockKv.has(`p${LATE}:${presenceLastSeenKey(OTHER)}`)).toBe(false);
  });

  it('и его список запретов не затирается новой просьбой', async () => {
    mockKv.set(`p${LATE}:${HIDDEN_KEY}`, JSON.stringify(['первый==', 'второй==']));
    await loadPersistedPresence([], ON_SCREEN);
    mockFailHidden = true;
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    expect(parseHiddenPeers(mockKv.get(`p${LATE}:${HIDDEN_KEY}`)))
      .toEqual(['первый==', 'второй==']);
  });
});
