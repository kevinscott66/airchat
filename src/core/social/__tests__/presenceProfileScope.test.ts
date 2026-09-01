/**
 * «Был(а) в сети» и просьбы «не отмечай меня» не пересекают границу аккаунтов
 * (v4.32.482).
 *
 * Память служба чистила при переключении профиля ещё с v4.32.188, а kv — нет:
 * ключи `presence:last_seen:<pub>` и `presence:hidden_peers` лежали без номера
 * профиля. Половинчатая уборка выглядит как исправленная: следующий профиль
 * поднимал те же записи с диска — для контакта, который есть у обоих
 * аккаунтов, он показывал время из чужой переписки. Мимо уборки удалённого
 * профиля (сметает `p<id>:%`) общие имена проходили целиком.
 *
 * Здесь два профиля работают по очереди с одним и тем же собеседником.
 */

const mockKv = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
}));

let mockActivePid = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActivePid, name: 'П', did: `did:key:z${mockActivePid}` }),
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
  recordPeerActivity,
  setPeerLastSeenAllowed,
  getPresenceState,
  stopPresenceBroadcast,
} from '../presenceService';

const PEER = 'общийКонтакт==';

function src(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

/** Дать волю void-записям в kv: они не ожидаются вызывающим. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  mockKv.clear();
  mockActivePid = 1;
  await stopPresenceBroadcast();
});

describe('время последнего входа', () => {
  it('пишется в namespace своего профиля', async () => {
    await loadPersistedPresence([], 2);
    recordPeerActivity(PEER, 1_700_000_000_000);
    await settle();
    expect(mockKv.get(`p2:${presenceLastSeenKey(PEER)}`)).toBe('1700000000000');
    expect(mockKv.has(presenceLastSeenKey(PEER))).toBe(false);
  });

  it('чужая запись не поднимается вторым профилем', async () => {
    await loadPersistedPresence([], 1);
    recordPeerActivity(PEER, 1_700_000_000_000);
    await settle();
    // Переключение аккаунта: память чистится, диск остаётся.
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], 2);
    expect(getPresenceState(PEER).lastActiveAt).toBe(0);
  });

  it('своя запись после переключения туда-обратно возвращается', async () => {
    await loadPersistedPresence([], 1);
    recordPeerActivity(PEER, 1_700_000_000_000);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], 2);
    await stopPresenceBroadcast();
    await loadPersistedPresence([PEER], 1);
    expect(getPresenceState(PEER).lastActiveAt).toBe(1_700_000_000_000);
  });
});

describe('просьба не отмечать', () => {
  it('список скрытых — свой у каждого профиля', async () => {
    await loadPersistedPresence([], 2);
    setPeerLastSeenAllowed(PEER, false);
    await settle();
    expect(mockKv.has('p2:presence:hidden_peers')).toBe(true);
    expect(mockKv.has('presence:hidden_peers')).toBe(false);
  });

  it('не переносится в соседний аккаунт', async () => {
    await loadPersistedPresence([], 2);
    setPeerLastSeenAllowed(PEER, false);
    await settle();
    await stopPresenceBroadcast();
    await loadPersistedPresence([], 1);
    // Просьбу присылает сам собеседник конвертом; в другом аккаунте он её ещё
    // не присылал, поэтому запись активности проходит.
    recordPeerActivity(PEER, 1_700_000_000_000);
    await settle();
    expect(mockKv.get(`p1:${presenceLastSeenKey(PEER)}`)).toBe('1700000000000');
  });
});

describe('форма исходников', () => {
  it('presence не пишет в kv мимо профиля', () => {
    const s = src('presenceService.ts');
    expect(s).not.toContain("import { kvGet, kvSet } from '../storage/local';");
    expect(s).toContain('let presencePid = 1;');
    expect(s).toContain('scopedKvSetFor(presencePid, presenceLastSeenKey(peerPubB64)');
    expect(s).toContain('scopedKvGetFor(presencePid, HIDDEN_PEERS_KEY)');
    // Номер берётся у ключа, которым служба представляется сети, и разбор
    // ключа идёт через pubKeyFormat, а не своими руками.
    expect(s).not.toContain("Buffer.from(myPubB64, 'base64')");
    expect(s).toContain('const keyPid = ownerPidForPublicKeyB64(myPubB64);');
  });

  it('свой статус берётся у своего профиля', () => {
    expect(src('presenceService.ts')).toContain(
      "await ownFieldGetFor(presencePid, 'user_custom_status')"
    );
  });

  it('удаление контакта снимает запись из своего профиля', () => {
    expect(src('contacts.ts')).toContain(
      'await kvDeleteScoped(pid, presenceLastSeenKey(peerPublicKeyB64));'
    );
  });

  it('проводка «профиль по ключу» одна на всех', () => {
    const lookup = fs.readFileSync(
      path.join(__dirname, '..', '..', 'identity', 'ownerPidLookup.ts'),
      'utf8'
    );
    expect(lookup).toContain('export function ownerPidForDid(did: string): number {');
    expect(lookup).toContain('export function ownerPidForPublicKey(publicKey: Uint8Array): number {');
    expect(lookup).toContain(
      'export function ownerPidForPublicKeyB64(value: string): number | null {'
    );
    expect(lookup).toContain("import { publicKeyFromB64 } from '../crypto/pubKeyFormat';");
  });

  it('проверка не пустая', () => {
    expect(src('presenceService.ts')).toContain('presenceLastSeenKey');
  });
});
