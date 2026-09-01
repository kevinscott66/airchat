/**
 * Опоздавшее входящее пишет присутствие в СВОЙ аккаунт, а не в тот, что на
 * экране (v4.32.485).
 *
 * С v4.32.482 записи присутствия лежат под номером профиля — но номер брался
 * у работающей службы, а не у владельца переписки. Служба одна на приложение,
 * и её номер меняется при переключении аккаунта; расшифрованное сообщение
 * принадлежит той паре ключей, которой оно расшифровано. Между этими двумя
 * величинами есть зазор — позднее входящее прежнего аккаунта, — и в него
 * попадали ровно те две записи, которые и составляют «был(а) в сети»:
 *
 *   - отметка времени доставалась новому аккаунту: он показывал «был 2 мин
 *     назад» про человека из чужой переписки, иногда вовсе не своего контакта;
 *   - просьба «не показывай моё время входа» применялась к новому аккаунту, а
 *     до адресата не доходила никогда — тот продолжал собирать отметки.
 *
 * Второе — не косметика: просьбу исполняют, не собирая данные, и единственный
 * аккаунт, который её получил, оставался единственным, кто её не исполнил.
 */

const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
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

import * as fs from 'fs';
import * as path from 'path';
import {
  loadPersistedPresence,
  presenceLastSeenKey,
  recordPeerActivityFor,
  setPeerLastSeenAllowedFor,
  getPresenceState,
  stopPresenceBroadcast,
} from '../presenceService';
import { parseHiddenPeers, withHiddenPeer, HIDDEN_PEERS_MAX } from '../hiddenPeers';

const PEER = 'общийКонтакт==';
const HIDDEN_KEY = 'presence:hidden_peers';
const ON_SCREEN = 1;
const LATE = 2;

function src(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

/** Дать волю void-записям в kv: они не ожидаются вызывающим. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  mockKv.clear();
  await stopPresenceBroadcast();
});

describe('опоздавшее входящее чужого аккаунта', () => {
  it('время последнего входа пишется владельцу переписки', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    expect(mockKv.get(`p${LATE}:${presenceLastSeenKey(PEER)}`)).toBe('1700000000000');
    expect(mockKv.has(`p${ON_SCREEN}:${presenceLastSeenKey(PEER)}`)).toBe(false);
  });

  it('не показывается в аккаунте на экране', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });

  it('и находится этим аккаунтом при его старте', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], LATE);
    expect(getPresenceState(PEER).lastActiveAt).toBe(1_700_000_000_000);
  });

  it('просьба «не отмечай меня» запоминается адресатом', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    expect(parseHiddenPeers(mockKv.get(`p${LATE}:${HIDDEN_KEY}`))).toEqual([PEER]);
    expect(mockKv.has(`p${ON_SCREEN}:${HIDDEN_KEY}`)).toBe(false);
  });

  it('и действует, когда адресат выходит на экран', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([], LATE);
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    // '0' записала сама просьба; главное — что новое время сюда не легло.
    expect(mockKv.get(`p${LATE}:${presenceLastSeenKey(PEER)}`)).toBe('0');
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });

  it('просьба чужого аккаунта соблюдается и до его старта', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    expect(mockKv.get(`p${LATE}:${presenceLastSeenKey(PEER)}`)).toBe('0');
  });

  it('просьба стирает уже накопленное время у адресата', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(LATE, PEER, 1_700_000_000_000);
    await settle();
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    expect(mockKv.get(`p${LATE}:${presenceLastSeenKey(PEER)}`)).toBe('0');
  });

  it('снятие просьбы у чужого аккаунта убирает его из списка', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    setPeerLastSeenAllowedFor(LATE, PEER, true);
    await settle();
    expect(parseHiddenPeers(mockKv.get(`p${LATE}:${HIDDEN_KEY}`))).toEqual([]);
  });

  it('список запретов чужого аккаунта не затирается целиком', async () => {
    mockKv.set(`p${LATE}:${HIDDEN_KEY}`, JSON.stringify(['первый==', 'второй==']));
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(LATE, PEER, false);
    await settle();
    expect(parseHiddenPeers(mockKv.get(`p${LATE}:${HIDDEN_KEY}`))).toEqual(['первый==', 'второй==', PEER]);
  });
});

describe('аккаунт на экране работает как прежде', () => {
  it('время пишется через память и видно сразу', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    recordPeerActivityFor(ON_SCREEN, PEER, 1_700_000_000_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(1_700_000_000_000);
    expect(mockKv.get(`p${ON_SCREEN}:${presenceLastSeenKey(PEER)}`)).toBe('1700000000000');
  });

  it('просьба действует немедленно, без похода в базу', async () => {
    await loadPersistedPresence([], ON_SCREEN);
    setPeerLastSeenAllowedFor(ON_SCREEN, PEER, false);
    recordPeerActivityFor(ON_SCREEN, PEER, 1_700_000_000_000);
    await settle();
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });
});

describe('разбор списка запретов', () => {
  it('мусор читается как пустой список', () => {
    expect(parseHiddenPeers('не json')).toEqual([]);
    expect(parseHiddenPeers('{"a":1}')).toEqual([]);
    expect(parseHiddenPeers(null)).toEqual([]);
    expect(parseHiddenPeers(JSON.stringify([1, '', null, 'ключ==']))).toEqual(['ключ==']);
  });

  it('повторы схлопываются', () => {
    expect(parseHiddenPeers(JSON.stringify(['a', 'a', 'b']))).toEqual(['a', 'b']);
  });

  it('длина списка ограничена', () => {
    const many = Array.from({ length: HIDDEN_PEERS_MAX + 50 }, (_, i) => `k${i}`);
    expect(parseHiddenPeers(JSON.stringify(many))).toHaveLength(HIDDEN_PEERS_MAX);
  });

  it('без изменений возвращается null — писать нечего', () => {
    expect(withHiddenPeer(['a'], 'a', true)).toBeNull();
    expect(withHiddenPeer(['a'], 'b', false)).toBeNull();
    expect(withHiddenPeer([], '', true)).toBeNull();
  });

  it('переполнение не притворяется запомненным запретом', () => {
    const full = Array.from({ length: HIDDEN_PEERS_MAX }, (_, i) => `k${i}`);
    expect(withHiddenPeer(full, 'ещё', true)).toBeNull();
  });
});

describe('форма исходников', () => {
  it('номер аккаунта приходит от вызывающего, а не от службы', () => {
    const s = src('presenceService.ts');
    expect(s).toContain('export function recordPeerActivityFor(');
    expect(s).toContain('export function setPeerLastSeenAllowedFor(');
    // Простые имена остались — но только как обёртки над номером службы.
    expect(s).toContain('recordPeerActivityFor(presencePid, peerPubB64, ts);');
    expect(s).toContain('setPeerLastSeenAllowedFor(presencePid, peerPubB64, allow);');
  });

  it('приём сообщения знает владельца переписки', () => {
    const s = src('messaging.ts');
    expect(s).toContain("import { recordPeerActivityFor } from './presenceService';");
    expect(s).not.toMatch(/[^A-Za-z]recordPeerActivity\(/);
    expect((s.match(/recordPeerActivityFor\(ownerPid, peerPubKeyB64\)/g) ?? []).length).toBe(2);
    expect(s).toContain('handleIncomingLastSeenPref(textPayload.text, peerPubKeyB64, ownerPid)');
  });

  it('приём просьбы требует номер аккаунта — забыть его нельзя', () => {
    const s = src('presencePrefSync.ts');
    expect(s).toContain('ownerProfileId: number');
    expect(s).toContain('setPeerLastSeenAllowedFor(ownerProfileId, senderPubB64, env.show);');
  });

  it('граница списка написана один раз', () => {
    expect(src('hiddenPeers.ts')).toContain('export const HIDDEN_PEERS_MAX = 1000;');
    const s = src('presenceService.ts');
    expect(s).toContain("import { parseHiddenPeers, withHiddenPeer } from './hiddenPeers';");
    expect(s).not.toContain('const HIDDEN_PEERS_MAX');
  });

  it('чистый модуль ничего не тянет за собой', () => {
    expect(src('hiddenPeers.ts')).not.toMatch(/^import /m);
  });
});
