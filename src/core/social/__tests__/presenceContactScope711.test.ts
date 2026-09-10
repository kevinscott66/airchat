/**
 * «Был(а) в сети» слушает СВОИХ собеседников, а не тех, что на экране
 * (v4.32.711).
 *
 * Служба присутствия поднимается под одной парой ключей и с v4.32.482 знает
 * свой номер аккаунта: под ним лежат отметки времени, просьбы «не отмечай
 * меня» и собственный статус в рассылке. Все решения модуля брали этот номер
 * (presencePid) — кроме двух, самых первых: список собеседников, на чьи топики
 * надо подписаться, спрашивали у профиля, открытого на экране.
 *
 * Между запуском службы и этими строками стоят ожидания сети (у первого
 * обхода — весь запуск приложения, у повторного — минутный таймер, живущий всё
 * время работы), так что «активный» и «свой» расходятся по-настоящему:
 *
 *   - первый обход подписывался на топики чужих собеседников; свои в
 *     subscribedByPeer не попадали вовсе;
 *   - повторный обход, для того и заведённый, чтобы подобрать пропущенных,
 *     подбирал их из того же чужого списка — свои так и оставались в
 *     failedPeers, и «в сети» у них не загоралось до перезапуска;
 *   - третья строка — в App.tsx: список собеседников для loadPersistedPresence
 *     брался у экрана, а номер профиля рядом уже считался из пары ключей, так
 *     что сохранённые отметки поднимались с диска под своим номером, но по
 *     чужим ключам.
 *
 * Правило то же, что у listContactsFor (v4.32.465): «активный» — это про
 * экран, а не про работу.
 *
 * Эта дорожка живёт на вебе: на телефонах pubsub выключен целиком
 * (isIpfsEnabled()===false, см. v4.32.227), и обход туда не доходит. Поэтому
 * здесь ключ включён явно.
 */

const mockKv = new Map<string, string>();

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGetFor: async (pid: number, k: string) => mockKv.get(`p${pid}:${k}`) ?? null,
  scopedKvSetFor: async (pid: number, k: string, v: string) => { mockKv.set(`p${pid}:${k}`, v); },
  scopedKvTryGetFor: async (pid: number, k: string) => ({ value: mockKv.get(`p${pid}:${k}`) ?? null }),
}));

const MY_PUB = 'мояПара==';
const MY_PEER = 'свойСобеседник==';
const OTHER_PEER = 'чужойСобеседник==';
const OWNER = 2;
/** Тот же префикс, что и у службы (PRESENCE_TOPIC_PREFIX). */
const TOPIC = '/airchat/v1/presence/';

jest.mock('../../identity/ownerPidLookup', () => ({
  ownerPidForPublicKeyB64: (b64: string) => (b64 === 'мояПара==' ? 2 : null),
}));

/** Номера профилей, у которых спрашивали свой статус. */
const mockStatusPids: number[] = [];
jest.mock('../../identity/ownProfile', () => ({
  ownFieldGetFor: async (pid: number) => { mockStatusPids.push(pid); return ''; },
}));

const mockSubscribed: string[] = [];
const mockUnsubbed: string[] = [];
const mockPublished: string[] = [];
jest.mock('../../transport/ipfs/pubsub', () => ({
  pubsubPublish: async (topic: string) => { mockPublished.push(topic); return true; },
  pubsubSubscribe: async (topic: string) => {
    mockSubscribed.push(topic);
    return () => { mockUnsubbed.push(topic); };
  },
}));

let mockIpfs = true;
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => mockIpfs }));

/** Номера профилей, у которых служба спрашивала контакты. */
const mockScopePids: number[] = [];
/** Сколько раз спросили «у активного» — должно остаться нулём. */
const mockBareCalls: number[] = [];
jest.mock('../contacts', () => ({
  listContactsFor: async (pid: number) => {
    mockScopePids.push(pid);
    return [{ peerPublicKey: 'свойСобеседник==' }];
  },
  listContacts: async () => {
    mockBareCalls.push(1);
    return [{ peerPublicKey: 'чужойСобеседник==' }];
  },
}));

jest.mock('../../settings/privacyPrefs', () => ({ privacyPrefTryGet: async () => ({ value: 'everybody' }) }));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' } }));

import * as fs from 'fs';
import * as path from 'path';
import {
  startPresenceBroadcast,
  stopPresenceBroadcast,
  presenceOwnerPid,
  recordPeerActivityFor,
  getPresenceState,
} from '../presenceService';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const PRESENCE = () => read('core', 'social', 'presenceService.ts');
const CONTACTS = () => read('core', 'social', 'contacts.ts');
const APP = () => read('App.tsx');

/** Только код: комментарий сам по себе не должен проходить проверку. */
const codeOnly = (src: string) => src.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}).join('\n');

/** Дать волю несожидаемым записям и подпискам. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((r) => setImmediate(r));
}

beforeEach(async () => {
  await stopPresenceBroadcast();
  mockKv.clear();
  mockScopePids.length = 0;
  mockBareCalls.length = 0;
  mockSubscribed.length = 0;
  mockUnsubbed.length = 0;
  mockPublished.length = 0;
  mockStatusPids.length = 0;
  mockIpfs = true;
});

afterEach(async () => {
  await stopPresenceBroadcast();
  jest.useRealTimers();
});

describe('подписка идёт по контактам своего аккаунта', () => {
  it('первый обход спрашивает контакты владельца пары ключей', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    expect(mockScopePids).toContain(OWNER);
    expect(mockScopePids.every((p) => p === OWNER)).toBe(true);
    expect(mockBareCalls).toHaveLength(0);
  });

  it('и подписывается на топик своего собеседника', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    expect(mockSubscribed).toContain(`${TOPIC}${MY_PEER}`);
    expect(mockSubscribed).not.toContain(`${TOPIC}${OTHER_PEER}`);
  });

  it('повторный обход раз в минуту спрашивает тот же номер', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await startPresenceBroadcast(MY_PUB);
    await settle();
    const afterFirst = mockScopePids.length;
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockScopePids.length).toBeGreaterThan(afterFirst);
    expect(mockScopePids.every((p) => p === OWNER)).toBe(true);
    expect(mockBareCalls).toHaveLength(0);
  });

  it('номер службы — от пары ключей, а не от экрана', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    expect(presenceOwnerPid()).toBe(OWNER);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('на телефоне рассылка по-прежнему не поднимается', async () => {
    mockIpfs = false;
    await startPresenceBroadcast(MY_PUB);
    await settle();
    expect(mockSubscribed).toHaveLength(0);
    expect(mockPublished).toHaveLength(0);
    expect(mockScopePids).toHaveLength(0);
  });

  it('свой статус рассылается в собственный топик и под своим номером', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    expect(mockPublished).toContain(`${TOPIC}${MY_PUB}`);
    expect(mockStatusPids.every((p) => p === OWNER)).toBe(true);
  });

  it('остановка снимает заведённые подписки', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    await stopPresenceBroadcast();
    expect(mockUnsubbed).toContain(`${TOPIC}${MY_PEER}`);
  });

  it('время последнего входа по-прежнему пишется названному аккаунту', async () => {
    await startPresenceBroadcast(MY_PUB);
    await settle();
    recordPeerActivityFor(OWNER, MY_PEER, 1_700_000_000_000);
    await settle();
    expect(mockKv.get(`p${OWNER}:presence:last_seen:${MY_PEER}`)).toBe('1700000000000');
    expect(getPresenceState(MY_PEER).lastActiveAt).toBe(1_700_000_000_000);
  });

  it('обход по-прежнему бережёт заведённые подписки от дублей', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    await startPresenceBroadcast(MY_PUB);
    await settle();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockSubscribed.filter((t) => t === `${TOPIC}${MY_PEER}`)).toHaveLength(1);
  });
});

describe('форма исходников', () => {
  it('служба присутствия спрашивает только по номеру', () => {
    const code = codeOnly(PRESENCE());
    expect(code).not.toMatch(/\blistContacts\(/);
    expect(code).toContain("import { listContactsFor } from './contacts';");
    expect((code.match(/await listContactsFor\(presencePid\)/g) ?? []).length).toBe(2);
  });

  it('запуск в App.tsx считает номер один раз и им же берёт список', () => {
    const code = codeOnly(APP());
    expect(code).toContain('const presencePid = ownerPidForPublicKey(pair.publicKey);');
    expect(code).toContain('const contacts = await listContactsFor(presencePid);');
    expect(code).toContain('await loadPersistedPresence(peerKeys, presencePid);');
    // Номер считается ровно один раз — второй вызов означал бы, что список и
    // хранилище снова разъехались.
    expect((code.match(/ownerPidForPublicKey\(pair\.publicKey\)/g) ?? []).length).toBe(1);
  });

  it('баннер на экране остаётся у активного профиля — это его работа', () => {
    const code = codeOnly(APP());
    expect(code).toContain('void listContacts().then((ctacts) => {');
    expect(code).toContain("import { listContacts, listContactsFor } from './core/social/contacts';");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('простое имя по-прежнему означает «у активного профиля»', () => {
    const s = CONTACTS();
    expect(s).toContain('return listContactsFor(activeProfileId());');
    expect(s).toContain('export async function listContactsFor(ownerProfileId: number)');
    expect(s).toContain('«Активный» — это про экран, а не про работу');
  });

  it('у службы есть свой номер, отличный от активного', () => {
    const s = PRESENCE();
    expect(s).toContain('let presencePid = 1;');
    expect(s).toContain('export function presenceOwnerPid(): number {');
    expect(s).toContain('const keyPid = ownerPidForPublicKeyB64(myPubB64);');
    expect(s).toContain('if (keyPid !== null) presencePid = keyPid;');
  });

  it('минутный обход и его повод на месте', () => {
    const s = PRESENCE();
    expect(s).toContain('const RETRY_SWEEP_INTERVAL_MS = 60_000;');
    expect(s).toContain('void resubscribeFailed(myPubB64);');
    expect(s).toContain('presence_sweep_list_failed');
    expect(s).toContain('presence_initial_list_failed');
    expect(s).toContain("log.info('presence_skipped_no_ipfs');");
  });
});
