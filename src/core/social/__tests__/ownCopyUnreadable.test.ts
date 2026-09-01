/**
 * «Своя копия не открылась» — это не «в сообщении пусто» (v4.32.575).
 *
 * Дефект. getGroupMessageTexts / getChatMessageTexts читали текст через
 * decryptAtRestString, а он на осечке расшифровки отдаёт пустую строку. Оба
 * состояния — «строку не прочесть» и «в строке пусто» — приходили вызывающему
 * одинаково, и вызывающий выбирал не то:
 *
 *   • цитата в группе. Присланное превью заменяется своим текстом, чтобы
 *     участник не подписал под чужим сообщением любую строку. Нечитаемая своя
 *     копия давала пустую замену — и цитата исчезала совсем;
 *   • живая геолокация. Конверт обновления вправе править только строку с
 *     живой меткой; проверка сравнивала префикс с пустой строкой и отказывала
 *     верно, но по случайности, а не по решению.
 *
 * Здесь проверяется и то и другое, и форма самих читателей.
 */
import fs from 'fs';
import path from 'path';

type FakeGroup = {
  id: string;
  ownerProfileId: number;
  name: string;
  type: 'group' | 'channel' | 'supergroup';
  archived: boolean;
  isAdmin?: boolean;
};

const mockGroups: FakeGroup[] = [];
const mockMembers: Record<string, Array<{ peerPubB64: string; role: string; ownerProfileId: number }>> = {};
const mockInserted: Array<{ replyToId: string | null; replyToPreview: string | null }> = [];
/** Что отдаёт читатель своих копий: строка, null (не открылась) или ничего. */
let mockOwnText: Map<string, string | null> = new Map();

jest.mock('../../storage/local', () => ({
  getGroup: jest.fn(async (id: string, pid: number) =>
    mockGroups.find((g) => g.id === id && g.ownerProfileId === pid) ?? null),
  listGroupMembers: jest.fn(async (gid: string, pid: number) =>
    (mockMembers[gid] ?? []).filter((m) => m.ownerProfileId === pid)),
  getGroupMessageTexts: jest.fn(async () => mockOwnText),
  insertGroupMessage: jest.fn(async (row: { replyToId: string | null; replyToPreview: string | null }) => {
    mockInserted.push(row);
  }),
  touchGroupConversation: jest.fn(async () => {}),
  markGroupMessageSeen: jest.fn(async () => {}),
  insertGroupJoinRequest: jest.fn(async () => ({ created: true })),
  profileKvGet: jest.fn(async () => null),
  kvDeleteScoped: jest.fn(async () => {}),
  createGroup: jest.fn(async () => {}),
  upsertGroupMember: jest.fn(async () => {}),
  updateGroupMemberRole: jest.fn(async () => {}),
  removeGroupMember: jest.fn(async () => {}),
  updateGroupMeta: jest.fn(async () => {}),
  recountGroupMembers: jest.fn(async () => {}),
  setGroupSlowMode: jest.fn(async () => {}),
  setGroupDisappearTimer: jest.fn(async () => {}),
  listGroups: jest.fn(async () => mockGroups),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: async () => 'Я',
  getOwnDisplayName: async () => 'Я',
}));
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: async () => {}, groupRecipient: async () => null }),
}));
jest.mock('../controlFanout', () => ({
  activeRecipients: async () => [],
  fanoutControlEnvelope: async () => ({ sent: 0, failed: 0, skipped: 0 }),
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryBoolFor: async () => false,
  privacyPrefBoolFor: async () => false,
  readReceiptsAllowedFor: async () => true,
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { encodeGroupMsgEnvelope, handleIncomingGroupEnvelope } from '../groupMessaging';
import { log } from '../../logger';
import type { GroupRecipient } from '../groupRecipient';

const GID = 'g-1';
const ME = 'M'.repeat(43);
const PEER = 'P'.repeat(43);
const PID = 1;
const QUOTED = 'm-quoted';

const RCPT = {
  pid: PID,
  pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
  myPub: ME,
} as unknown as GroupRecipient;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const LOCAL = () => read('core', 'storage', 'local.ts');
const MESSAGING = () => read('core', 'social', 'messaging.ts');
const GROUP = () => read('core', 'social', 'groupMessaging.ts');

const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

function ownGroup(): void {
  mockGroups.push({ id: GID, ownerProfileId: PID, name: 'Двор', type: 'group', archived: false, isAdmin: true });
  mockMembers[GID] = [
    { peerPubB64: ME, role: 'owner', ownerProfileId: PID },
    { peerPubB64: PEER, role: 'member', ownerProfileId: PID },
  ];
}

function replyFrom(sender: string, preview: string): string {
  return encodeGroupMsgEnvelope({
    groupId: GID,
    msgId: 'm-new',
    senderName: 'Пётр',
    senderPubB64: sender,
    text: 'согласен',
    ts: 1_700_000_000_000,
    replyToId: QUOTED,
    replyToPreview: preview,
  });
}

beforeEach(() => {
  mockGroups.length = 0;
  mockInserted.length = 0;
  mockOwnText = new Map();
  for (const k of Object.keys(mockMembers)) delete mockMembers[k];
  jest.clearAllMocks();
});

describe('цитата в группе', () => {
  it('своя читаемая копия заменяет присланное превью', async () => {
    ownGroup();
    mockOwnText.set(QUOTED, 'я против');
    await handleIncomingGroupEnvelope(replyFrom(PEER, 'я за'), RCPT, PEER);
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].replyToPreview).toBe('я против');
  });

  it('нечитаемая своя копия оставляет присланное превью, а не стирает цитату', async () => {
    // Прежнее поведение: пустая строка вместо текста — и в базу ложился
    // пустой replyToPreview, то есть ответ без всякой видимой связи.
    ownGroup();
    mockOwnText.set(QUOTED, null);
    await handleIncomingGroupEnvelope(replyFrom(PEER, 'я за'), RCPT, PEER);
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].replyToPreview).toBe('я за');
    expect(mockInserted[0].replyToId).toBe(QUOTED);
  });

  it('нечитаемая копия оставляет след в журнале', async () => {
    ownGroup();
    mockOwnText.set(QUOTED, null);
    await handleIncomingGroupEnvelope(replyFrom(PEER, 'я за'), RCPT, PEER);
    expect((log.warn as jest.Mock).mock.calls.map((c) => c[0])).toContain('reply_own_copy_unreadable');
  });

  it('своей копии нет вовсе — присланное превью остаётся, следа нет', async () => {
    ownGroup();
    await handleIncomingGroupEnvelope(replyFrom(PEER, 'я за'), RCPT, PEER);
    expect(mockInserted[0].replyToPreview).toBe('я за');
    expect((log.warn as jest.Mock).mock.calls.map((c) => c[0])).not.toContain('reply_own_copy_unreadable');
  });

  it('пустая своя копия убирает превью, но оставляет ссылку на сообщение', async () => {
    // Честный ответ на «в сообщении пусто»: показывать нечего, но связь с
    // цитируемым сообщением сохраняется (truncateReplyPreview отдаёт null).
    ownGroup();
    mockOwnText.set(QUOTED, '');
    await handleIncomingGroupEnvelope(replyFrom(PEER, 'я за'), RCPT, PEER);
    expect(mockInserted[0].replyToPreview).toBeNull();
    expect(mockInserted[0].replyToId).toBe(QUOTED);
  });
});

describe('форма читателей и второго вызывающего', () => {
  it('групповой читатель отдаёт «не открылось» отдельно от «пусто»', () => {
    const body = slice(
      LOCAL(),
      'export async function getGroupMessageTexts(',
      '\n/**'
    );
    expect(body).toContain('Promise<Map<string, string | null>>');
    expect(body).toContain('cellTextOrNull(readAtRestCell(r.text, dek))');
    expect(body).not.toContain('decryptAtRestString');
  });

  it('личный читатель — так же', () => {
    const body = slice(
      LOCAL(),
      'export async function getChatMessageTexts(',
      '\n/**'
    );
    expect(body).toContain('Promise<Map<string, string | null>>');
    expect(body).toContain('cellTextOrNull(readAtRestCell(r.text, dek))');
    expect(body).not.toContain('decryptAtRestString');
  });

  it('живая геолокация отказывается править нечитаемую строку осознанно', () => {
    const s = MESSAGING();
    const at = s.indexOf('getChatMessageTexts([rowId], peerPubKeyB64, ownerPid)');
    expect(at).toBeGreaterThan(0);
    const after = s.slice(at, at + 1800);
    expect(after).toContain('if (prev === null) {');
    expect(after).toContain("log.warn('liveloc_update_rejected_unreadable'");
    // Отказ идёт РАНЬШЕ разбора метки: иначе нечитаемая строка попала бы в
    // parseLiveLoc пустой и решение принималось бы по выдуманной метке.
    expect(after.indexOf('if (prev === null) {')).toBeLessThan(after.indexOf('decideLiveLocUpdate'));
  });

  it('цитата различает три состояния, а не два', () => {
    const s = GROUP();
    const at = s.indexOf('const own = (await getGroupMessageTexts(');
    expect(at).toBeGreaterThan(0);
    const after = s.slice(at, at + 700);
    expect(after).toContain('if (own === null) {');
    expect(after).toContain('} else if (own !== undefined) {');
    expect(after).not.toContain('if (own != null) replyPreview');
  });
});
