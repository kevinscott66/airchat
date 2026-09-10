/**
 * Отказ отправки служебного конверта больше не записывается как доставка
 * (v4.32.715).
 *
 * Половина того, что уходит с телефона, — служебные конверты: карточка
 * профиля, просьба прислать чужую, просьба не отмечать время последнего
 * входа. Каждый из них помнит у себя «этому уже сообщено» и на эту память
 * полагается: сказанное второй раз не повторяют.
 *
 * В v4.32.320 под это завели проверку `canReachPeer` ДО отправки — и на том
 * успокоились. Но проверка знает лишь два повода отказа из шести: блокировку
 * и выбранный часовой лимит. Ещё четыре — нет общего ключа с собеседником,
 * негодный peerDid, исчерпанный лимит служебных конвертов и «нет маршрута в
 * сеть» — видны только по тому, что вернул сам `sendMessage`, а возвращённое
 * значение выбрасывалось. Служебный конверт при этом не оставляет и строки в
 * переписке: не ушло — и следа нет.
 *
 * Цена: у собеседника навсегда остаётся старое имя и старая фотография (до
 * следующей правки профиля), а просьба «не показывай моё время последнего
 * входа» считается доставленной, хотя её никто не отправлял.
 *
 * Проверки здесь поведенческие: оба модуля поднимаются в jest целиком.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGetFor: jest.fn(async (pid: number, key: string) => mockKv.get(`${pid}:${key}`) ?? null),
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`${pid}:${key}`) ?? null,
  })),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, v: string) => {
    mockKv.set(`${pid}:${key}`, v);
  }),
  scopedKvSet: jest.fn(async () => {}),
}));

/** Что вернул sendMessage: строка — конверт ушёл, null — отказ. */
let mockCid: string | null = 'cid-1';
const mockSend = jest.fn(async () => mockCid);
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: (...a: unknown[]) => mockSend(...(a as [])) }),
}));

const mockReach = jest.fn(async () => true);
jest.mock('../sendGate', () => ({ canReachPeer: (...a: unknown[]) => mockReach(...(a as [])) }));

let mockContacts: string[] = [];
jest.mock('../contacts', () => ({
  listContactsFor: jest.fn(async () => mockContacts.map((p) => ({ peerPublicKey: p }))),
  setPeerProfileFor: jest.fn(async () => true),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(async () => 'Рита'),
  getOwnUsernameFor: jest.fn(async () => 'rita'),
  ownFieldGetFor: jest.fn(async () => ''),
}));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarNameFor: jest.fn(async () => null),
  ownAvatarUriFor: jest.fn(async () => null),
}));
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: jest.fn(async () => 'everybody'),
}));
jest.mock('../../identity/ownBadge', () => ({ ownBadgeGrantFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: jest.fn(async () => []) }));
jest.mock('../../identity/verification', () => ({ badgeFor: jest.fn(() => false) }));
jest.mock('../../identity/did', () => ({ didFromPubB64: (p: string) => `did:key:${p}` }));

jest.mock('../presenceService', () => ({
  setPeerLastSeenAllowedFor: jest.fn(() => {}),
  setMyLastSeenVisibility: jest.fn(() => {}),
  effectiveMyLastSeenVisibility: jest.fn(() => 'nobody'),
  presenceOwnerPid: jest.fn(() => 7),
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGetFor: jest.fn(async () => ({ value: 'nobody' })),
}));
jest.mock('../controlWatermark', () => ({ acceptControlTs: jest.fn(async () => true) }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { broadcastMyProfile, syncMyProfileTo, requestPeerProfile } from '../profileSync';
import { broadcastLastSeenPref, syncLastSeenPrefTo } from '../presencePrefSync';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SYNC = (): string => read('core/social/profileSync.ts');
const PREF = (): string => read('core/social/presencePrefSync.ts');
const GATE = (): string => read('core/social/sendGate.ts');
const MESSAGING = (): string => read('core/social/messaging.ts');

/** Строки кода без комментариев: свой же комментарий ломает отрицания. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Карта «этому уже сообщено», как она лежит в базе сейчас. */
function stored(key: string): Record<string, unknown> {
  const raw = mockKv.get(`7:${key}`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(() => {
  mockKv.clear();
  mockSend.mockClear();
  mockReach.mockClear();
  mockReach.mockResolvedValue(true);
  mockCid = 'cid-1';
  mockContacts = [];
});

describe('карточка профиля', () => {
  it('рассылка не помечает отказ как доставку', async () => {
    mockContacts = ['PEER_A'];
    mockCid = null;
    await broadcastMyProfile();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stored('profile:sent')).toEqual({});
  });

  it('после отказа следующая рассылка пробует того же собеседника снова', async () => {
    mockContacts = ['PEER_A'];
    mockCid = null;
    await broadcastMyProfile();
    mockCid = 'cid-2';
    await broadcastMyProfile();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(stored('profile:sent'))).toEqual(['PEER_A']);
  });

  it('ушедший конверт по-прежнему записывается, и второй раз не уходит', async () => {
    mockContacts = ['PEER_A'];
    await broadcastMyProfile();
    await broadcastMyProfile();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('отказ одному собеседнику не мешает доставке другому', async () => {
    mockContacts = ['PEER_A', 'PEER_B'];
    mockSend.mockImplementationOnce(async () => null);
    await broadcastMyProfile();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(stored('profile:sent'))).toEqual(['PEER_B']);
  });

  it('досылка при открытии переписки не записывает отказ', async () => {
    mockCid = null;
    await syncMyProfileTo('PEER_C');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stored('profile:sent')).toEqual({});
    mockCid = 'cid-3';
    await syncMyProfileTo('PEER_C');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(stored('profile:sent'))).toEqual(['PEER_C']);
  });
});

describe('просьба прислать профиль', () => {
  it('отказ не занимает пятиминутное окно', async () => {
    mockCid = null;
    await requestPeerProfile('PEER_D');
    expect(mockSend).toHaveBeenCalledTimes(1);
    mockCid = 'cid-4';
    await requestPeerProfile('PEER_D');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('ушедшая просьба окно занимает', async () => {
    await requestPeerProfile('PEER_E');
    await requestPeerProfile('PEER_E');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('просьба не отмечать время последнего входа', () => {
  it('рассылка не помечает отказ как доставку', async () => {
    mockContacts = ['PEER_F'];
    mockCid = null;
    await broadcastLastSeenPref();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stored('presence:pref_sent')).toEqual({});
  });

  it('после отказа следующая рассылка пробует снова', async () => {
    mockContacts = ['PEER_F'];
    mockCid = null;
    await broadcastLastSeenPref();
    mockCid = 'cid-5';
    await broadcastLastSeenPref();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(stored('presence:pref_sent')).toEqual({ PEER_F: false });
  });

  it('досылка при открытии переписки не записывает отказ', async () => {
    mockCid = null;
    await syncLastSeenPrefTo('PEER_G');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stored('presence:pref_sent')).toEqual({});
    mockCid = 'cid-6';
    await syncLastSeenPrefTo('PEER_G');
    expect(stored('presence:pref_sent')).toEqual({ PEER_G: false });
  });
});

describe('форма правки', () => {
  it('ни одна служебная отправка не выбрасывает ответ', () => {
    // Голая `await svc.sendMessage(` — это и есть выброшенный ответ. Проверка
    // построчная: «const cid = await svc.sendMessage(» содержит старую строку
    // целиком, и `not.toContain` здесь ничего не поймал бы.
    for (const src of [codeOnly(SYNC()), codeOnly(PREF())]) {
      expect(src.split('\n').filter((l) => /^\s*await svc\.sendMessage\(/.test(l))).toHaveLength(0);
    }
  });

  it('разобранный ответ есть на всех четырёх местах', () => {
    const sync = codeOnly(SYNC());
    expect(sync).toContain('const cid = await svc.sendMessage(peer, text);');
    expect(sync).toContain(
      'const cid = await svc.sendMessage(peerPubB64, encodeProfileEnvelope(built.env));'
    );
    expect(sync).toContain('const cid = await svc.sendMessage(peerPubB64, encodeProfileRequest());');
    expect(sync.match(/\bif \(!cid\)/g)?.length).toBe(3);
    const pref = codeOnly(PREF());
    expect(pref).toContain('const cid = await svc.sendMessage(');
    expect(pref.match(/\bif \(!cid\)/g)?.length).toBe(1);
  });

  it('в рассылке профиля отказ идёт мимо записи, а не в неё', () => {
    const sync = codeOnly(SYNC());
    const send = sync.indexOf('const cid = await svc.sendMessage(peer, text);');
    const refused = sync.indexOf('refused += 1;', send);
    const cont = sync.indexOf('continue;', refused);
    const write = sync.indexOf('fresh[peer] = version;', send);
    expect(send).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(send);
    expect(cont).toBeGreaterThan(refused);
    expect(write).toBeGreaterThan(cont);
  });
});

describe('повод для правки жив', () => {
  it('проверка перед отправкой по-прежнему знает только два повода из шести', () => {
    const gate = codeOnly(GATE());
    expect(gate).toContain('if (rateLimiter.isBlocked(peerPubB64)) return false;');
    expect(gate).toContain('return !rateLimiter.messageLimitReached(peerPubB64);');
    // Сама она ничего не отправляет — значит остальные поводы ей не видны.
    expect(gate).not.toContain('sendMessage');
  });

  it('два отказа sendMessage случаются ДО того, как заведена строка переписки', () => {
    const src = codeOnly(MESSAGING());
    const sig = src.indexOf(`  async sendMessage(`);
    expect(sig).toBeGreaterThan(-1);
    const body = src.slice(sig);
    const noSession = body.indexOf(`code: 'NO_SESSION_DM',`);
    const noDid = body.indexOf('if (!peerDid) return null;');
    const mid = body.indexOf('const messageId = uuidv4();');
    expect(noSession).toBeGreaterThan(-1);
    expect(noDid).toBeGreaterThan(noSession);
    expect(mid).toBeGreaterThan(noDid);
  });

  it('служебный конверт не оставляет строки в переписке даже когда её завели', () => {
    const src = codeOnly(MESSAGING());
    expect(src).toContain('const control = isControlOnlyText(text);');
    expect(src).toContain('if (!control && !callerOwnsRow) await upsertChatMessage(row);');
  });

  it('часовой лимит служебных конвертов по-прежнему отдельный отказ', () => {
    const src = codeOnly(MESSAGING());
    expect(src).toContain('if (!rateLimiter.canSendControl(contactPubB64)) {');
    expect(src).toContain('if (!rateLimiter.canSendMessage(contactPubB64)) {');
  });
});
