/**
 * Граф связей перестал лежать в базе открытым текстом (v4.32.946).
 *
 * Дефект. Три записи профиля писались обычной парой `scopedKv*`, то есть
 * ложились в столбец `v` таблицы `kv` как есть:
 *   — `contact_reports` — журнал жалоб: did собеседника рядом с причиной;
 *   — `profile:sent` — кому какую версию своего профиля отправляли;
 *   — `presence:pref_sent` — кому сказано показывать время входа, а кому нет.
 * Рядом, в том же каталоге, `presence:hidden_peers` шифруется с v4.32.814
 * ровно потому, что перечень открытых ключей собеседников — это граф связей.
 * Эти три остались в стороне, хотя держат тот же перечень, а журнал жалоб —
 * ещё и оценку: «на этого я пожаловался за оскорбления».
 *
 * Цена. Унёсший файл базы получает готовый ответ на вопрос «с кем этот
 * человек связан» — без разбора переписки, одной строкой. У presence:pref_sent
 * сверх того лежит настройка приватности, разложенная по именам собеседников.
 *
 * Правка. Те же три ключа — через `scopedKvTryGetSecret*` /
 * `scopedKvSetSecretChecked*`. Переноса не требуется: прежняя строка открытым
 * текстом читается как есть и уходит в шифртекст при первой же записи —
 * признак несёт сама строка (см. scopedKvTryGetSecretFor).
 *
 * Границы. Шифрование здесь защищает файл базы в покое, а не устройство с
 * поднятым ключом: кто открыл приложение, тот прочитает и эти строки. Имена
 * ключей остаются открытыми — в них собеседников нет. Отметка времени и
 * дескриптор своей загрузки в profileSync о других людях не говорят и
 * намеренно оставлены открытыми.
 */
const mockKv = new Map<string, string>();
/** Ключи, запись которых база не выполняет. */
const mockFailWrites = new Set<string>();
/** Ключи, чтение которых база не выполняет. */
const mockFailReads = new Set<string>();

jest.mock('../../storage/local', () => {
  const PREFIX = 'enc2:';
  return {
    kvTryGet: async (k: string) => (mockFailReads.has(k) ? null : { value: mockKv.get(k) ?? null }),
    kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
    kvSetChecked: async (k: string, v: string) => {
      if (mockFailWrites.has(k)) return false;
      mockKv.set(k, v);
      return true;
    },
    kvDelete: async (k: string) => { mockKv.delete(k); },
    kvDeleteChecked: async (k: string) => { mockKv.delete(k); return true; },
    kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
    // Вместо шифра — base64: не защита, а замена, при которой видно, ушло ли
    // значение в столбец узнаваемым. То же решение и по той же причине, что в
    // hiddenPeersSecret814: оставить строку как есть значило бы проверять
    // подстановку, а не код.
    kvSetSecret: async (k: string, v: string) => {
      if (mockFailWrites.has(k)) return false;
      mockKv.set(k, `${PREFIX}${Buffer.from(v, 'utf8').toString('base64')}`);
      return true;
    },
    kvGetSecretCellScoped: async (pid: number, k: string) => {
      const scoped = `p${pid}:${k}`;
      if (mockFailReads.has(scoped)) return { state: 'unreadable' };
      const raw = mockKv.get(scoped);
      if (raw === undefined) return { state: 'absent' };
      if (!raw.startsWith(PREFIX)) return { state: 'plain', text: raw };
      return {
        state: 'plain',
        text: Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8'),
      };
    },
  };
});

const mockPid = 7;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockPid }) },
}));

/** Кому и что ушло последней отправкой. */
const mockSent: Array<{ peer: string; text: string }> = [];
jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => {
      mockSent.push({ peer, text });
      return 'cid-946';
    },
  }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));

let mockContacts: string[] = [];
jest.mock('../contacts', () => ({
  listContacts: async () => mockContacts.map((peerPublicKey) => ({ peerPublicKey })),
  listContactsFor: async () => mockContacts.map((peerPublicKey) => ({ peerPublicKey })),
  setPeerProfileFor: async () => true,
  setPeerProfileForChecked: async () => true,
}));

jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Рита',
  getOwnUsernameFor: async () => 'rita',
  ownFieldGetFor: async () => '',
}));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarNameFor: async () => null,
  ownAvatarUriFor: async () => null,
}));
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: async () => 'everybody',
}));
jest.mock('../../identity/ownBadge', () => ({ ownBadgeGrantFor: async () => null }));
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: async () => [] }));
jest.mock('../../identity/verification', () => ({ badgeFor: () => false }));
jest.mock('../../identity/did', () => ({ didFromPubB64: (p: string) => `did:key:${p}` }));
jest.mock('./../publicAvatar', () => ({ publishOwnAvatarToDirectory: async () => null }));

jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGetFor: async () => ({ value: 'nobody' }),
}));
jest.mock('../presenceService', () => ({
  setPeerLastSeenAllowedFor: () => {},
  setMyLastSeenVisibility: () => {},
  effectiveMyLastSeenVisibility: () => 'nobody',
  presenceOwnerPid: () => mockPid,
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { listContactReports, recordContactReport } from '../contactReport';
import { broadcastLastSeenPref } from '../presencePrefSync';
import { syncMyProfileTo } from '../profileSync';

/** Собеседник, чей ключ не должен всплыть в базе открытым. */
const PEER = 'ключСобеседника==';
const DID = 'did:key:z6MkПожалованный';

const JOURNAL = `p${mockPid}:contact_reports`;
const PROFILE_SENT = `p${mockPid}:profile:sent`;
const PREF_SENT = `p${mockPid}:presence:pref_sent`;

const SRC = (name: string): string => readFileSync(join(__dirname, '..', name), 'utf8');

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

beforeEach(() => {
  mockKv.clear();
  mockFailWrites.clear();
  mockFailReads.clear();
  mockSent.length = 0;
  mockContacts = [PEER];
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: все три записи по-прежнему пишутся и читаются', () => {
  it('жалоба записывается и читается обратно', async () => {
    await recordContactReport(DID, 'spam', true);
    const all = await listContactReports();
    expect(all.map((r) => r.did)).toEqual([DID]);
    expect(all[0].blocked).toBe(true);
  });

  it('профиль уходит собеседнику и отмечается в карте', async () => {
    await syncMyProfileTo(PEER);
    expect(mockSent.map((m) => m.peer)).toEqual([PEER]);
    expect(mockKv.has(PROFILE_SENT)).toBe(true);
  });

  it('решение о времени входа уходит и отмечается в карте', async () => {
    await broadcastLastSeenPref();
    expect(mockSent.map((m) => m.peer)).toEqual([PEER]);
    expect(mockKv.has(PREF_SENT)).toBe(true);
  });
});

describe('в столбец значений ничего из этого не ложится открытым', () => {
  it('журнал жалоб — шифртекстом', async () => {
    await recordContactReport(DID, 'abuse', false);
    const raw = mockKv.get(JOURNAL);
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(DID);
    expect(raw).not.toContain('abuse');
  });

  it('карта отправленных профилей — шифртекстом', async () => {
    await syncMyProfileTo(PEER);
    const raw = mockKv.get(PROFILE_SENT);
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(PEER);
  });

  it('карта разосланных решений о присутствии — шифртекстом', async () => {
    await broadcastLastSeenPref();
    const raw = mockKv.get(PREF_SENT);
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(PEER);
  });

  it('ни в одной записи базы нет открытого ключа собеседника', async () => {
    await recordContactReport(DID, 'fraud', true);
    await syncMyProfileTo(PEER);
    await broadcastLastSeenPref();
    for (const [k, v] of mockKv) {
      expect(k).not.toContain(PEER);
      expect(k).not.toContain(DID);
      expect(v).not.toContain(PEER);
      expect(v).not.toContain(DID);
    }
  });
});

describe('прежние записи открытым текстом', () => {
  it('журнал читается как есть — прежний след не теряется', async () => {
    mockKv.set(JOURNAL, JSON.stringify([{ did: DID, reason: 'spam', at: 1, blocked: false }]));
    expect((await listContactReports()).map((r) => r.did)).toEqual([DID]);
  });

  it('и уходит в шифртекст при первой же записи, не потеряв прежнего', async () => {
    mockKv.set(JOURNAL, JSON.stringify([{ did: DID, reason: 'spam', at: 1, blocked: false }]));
    await recordContactReport('did:key:z6MkВторой', 'other', false);
    expect(mockKv.get(JOURNAL)?.startsWith('enc2:')).toBe(true);
    expect((await listContactReports()).map((r) => r.did)).toEqual(['did:key:z6MkВторой', DID]);
  });

  it('карта отправленных профилей читается открытой и переписывается шифром', async () => {
    mockKv.set(PROFILE_SENT, JSON.stringify({ [PEER]: 1 }));
    await syncMyProfileTo(PEER);
    const raw = mockKv.get(PROFILE_SENT);
    expect(raw?.startsWith('enc2:')).toBe(true);
    expect(raw).not.toContain(PEER);
  });
});

describe('нечитаемая запись не подменяется пустой', () => {
  it('журнал: отказ базы отменяет запись, а не стирает след', async () => {
    await recordContactReport(DID, 'spam', false);
    const before = mockKv.get(JOURNAL);
    mockFailReads.add(JOURNAL);
    await expect(recordContactReport('did:key:z6MkТретий', 'abuse', false)).rejects.toThrow();
    expect(mockKv.get(JOURNAL)).toBe(before);
  });

  it('карта присутствия: не прочитали — не пишем', async () => {
    mockKv.set(PREF_SENT, `enc2:${Buffer.from(JSON.stringify({ [PEER]: true }), 'utf8').toString('base64')}`);
    const before = mockKv.get(PREF_SENT);
    mockFailReads.add(PREF_SENT);
    await broadcastLastSeenPref();
    expect(mockKv.get(PREF_SENT)).toBe(before);
  });
});

describe('форма исходников: открытая пара к этим ключам не возвращается', () => {
  it('журнал жалоб', () => {
    const s = codeOnly(SRC('contactReport.ts'));
    expect(s).toContain('const read = await scopedKvTryGetSecret(KEY);');
    expect(s).toContain('await scopedKvSetSecretChecked(KEY, JSON.stringify(next))');
    expect(s).not.toContain('scopedKvTryGet(');
    expect(s).not.toContain('scopedKvSetChecked(');
  });

  it('обе карты «кому отправлено»', () => {
    for (const name of ['profileSync.ts', 'presencePrefSync.ts']) {
      const s = codeOnly(SRC(name));
      expect(s).toContain('const read = await scopedKvTryGetSecretFor(pid, SENT_KEY);');
      expect(s).toContain('if (!await scopedKvSetSecretCheckedFor(pid, SENT_KEY, JSON.stringify(merged))) {');
      expect(s).not.toContain('scopedKvTryGetFor(pid, SENT_KEY)');
      expect(s).not.toContain('scopedKvSetFor(pid, SENT_KEY');
    }
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: обычная запись kv кладёт значение как есть', () => {
    const local = codeOnly(readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8'));
    const at = local.indexOf('export async function kvSetChecked(');
    expect(at).toBeGreaterThan(0);
    const body = local.slice(at, local.indexOf('\n}', at));
    expect(body).not.toContain('encryptAtRest');
  });
});
