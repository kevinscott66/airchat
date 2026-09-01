/**
 * Закрепления и завершённые опросы принадлежат профилю (v4.32.484).
 *
 * Дефект. Имена kv-записей состояли из одного открытого ключа собеседника
 * (`pinned_list_<peer>`), одного id группы (`group_pinned_list_<id>`) или
 * одного id сообщения (`poll_closed_<id>`) — без номера профиля. Но общий
 * контакт у двух аккаунтов бывает, в одной группе человек состоит двумя
 * аккаунтами сразу, а id сообщений в группе у них общие. Следствия:
 *
 *  - «Открепить всё» в одном аккаунте снимало закрепления другого; входящий
 *    конверт `clear` от собеседника — тоже, и он не знал, что попадает
 *    сразу в две переписки;
 *  - полусотенный потолок на список закреплений два аккаунта делили;
 *  - завершение опроса в одном аккаунте закрывало его во втором, без всякого
 *    конверта;
 *  - уборка удалённого профиля сметает `p<id>:%` — под общие имена эти
 *    записи не подпадали и доставались следующему профилю с тем же номером.
 */
const mockKv = new Map<string, string>();
const mockTexts = new Map<string, string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  setConversationPinnedMessage: async () => undefined,
  setGroupPinnedMessage: async () => undefined,
  notifyChatStorageChanged: () => undefined,
  listGroupMembers: async () => [],
  getGroup: async () => null,
  getChatMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) as string])),
  getGroupMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) as string])),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 99 }) },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { applyLocalDmPin, clearDmPinned, loadDmPinnedIds } from '../dmPinSync';
import { applyLocalPin, clearPinned, loadPinnedIds } from '../groupPinSync';

const PEER = 'P'.repeat(43);
const GROUP = 'g-shared';
/** Два аккаунта одного человека, у которых общий контакт и общая группа. */
const FIRST = 3;
const SECOND = 5;

beforeEach(() => {
  mockKv.clear();
  mockTexts.clear();
  for (const id of ['m1', 'm2', 'm3']) mockTexts.set(id, `текст ${id}`);
});

describe('закрепления в личке', () => {
  it('ложатся под именем своего профиля, а не общим', async () => {
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: FIRST, msgId: 'm1', on: true });
    expect(mockKv.get(`p${FIRST}:pinned_list_${PEER}`)).toBe('["m1"]');
    expect(mockKv.has(`pinned_list_${PEER}`)).toBe(false);
  });

  it('второй аккаунт с тем же контактом ведёт свой список', async () => {
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: FIRST, msgId: 'm1', on: true });
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: SECOND, msgId: 'm2', on: true });
    expect(await loadDmPinnedIds(PEER, FIRST)).toEqual(['m1']);
    expect(await loadDmPinnedIds(PEER, SECOND)).toEqual(['m2']);
  });

  it('«открепить всё» у одного не стирает закрепления другого', async () => {
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: FIRST, msgId: 'm1', on: true });
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: SECOND, msgId: 'm2', on: true });
    await clearDmPinned(PEER, SECOND);
    expect(await loadDmPinnedIds(PEER, SECOND)).toEqual([]);
    expect(await loadDmPinnedIds(PEER, FIRST)).toEqual(['m1']);
  });

  it('открепление у одного не снимает то же сообщение у другого', async () => {
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: FIRST, msgId: 'm1', on: true });
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: SECOND, msgId: 'm1', on: true });
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: SECOND, msgId: 'm1', on: false });
    expect(await loadDmPinnedIds(PEER, SECOND)).toEqual([]);
    expect(await loadDmPinnedIds(PEER, FIRST)).toEqual(['m1']);
  });

  it('список, записанный когда профиль был один, достаётся первому', async () => {
    mockKv.set(`pinned_list_${PEER}`, '["m3"]');
    expect(await loadDmPinnedIds(PEER, 1)).toEqual(['m3']);
    expect(mockKv.get(`p1:pinned_list_${PEER}`)).toBe('["m3"]');
    expect(mockKv.has(`pinned_list_${PEER}`)).toBe(false);
    // Второму он не достаётся — разделить старую запись между аккаунтами нечем.
    expect(await loadDmPinnedIds(PEER, SECOND)).toEqual([]);
  });
});

describe('закрепления в группе', () => {
  it('ложатся под именем своего профиля', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: FIRST, msgId: 'm1', on: true });
    expect(mockKv.get(`p${FIRST}:group_pinned_list_${GROUP}`)).toBe('["m1"]');
    expect(mockKv.has(`group_pinned_list_${GROUP}`)).toBe(false);
  });

  it('два аккаунта в одной группе не делят один список', async () => {
    await applyLocalPin({ groupId: GROUP, ownerProfileId: FIRST, msgId: 'm1', on: true });
    await applyLocalPin({ groupId: GROUP, ownerProfileId: SECOND, msgId: 'm2', on: true });
    await clearPinned(GROUP, FIRST);
    expect(await loadPinnedIds(GROUP, FIRST)).toEqual([]);
    expect(await loadPinnedIds(GROUP, SECOND)).toEqual(['m2']);
  });
});

describe('форма исходников', () => {
  const src = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

  it('закрепления нигде не читаются мимо профиля', () => {
    for (const f of ['core/social/dmPinSync.ts', 'core/social/groupPinSync.ts']) {
      const s = src(f);
      expect(s).not.toContain('kvGet(pinListKey(');
      expect(s).not.toContain('kvSet(pinListKey(');
      expect(s).toContain('scopedKvGetFor(ownerProfileId, pinListKey(');
      expect(s).toContain('scopedKvSetFor(ownerProfileId, pinListKey(');
    }
  });

  it('отметка «опрос завершён» — тоже в namespace профиля', () => {
    const s = src('core/social/pollVoteSync.ts');
    expect(s).not.toContain('kvGet(pollClosedKey(');
    expect(s).not.toContain('kvSet(pollClosedKey(');
    // Все четыре места: свой голос, чужой голос, своё завершение, чужое.
    expect(s.split('scopedKvGetFor(pid, pollClosedKey(').length - 1).toBe(2);
    expect(s.split('scopedKvSetFor(pid, pollClosedKey(').length - 1).toBe(2);
  });

  it('пузырь опроса читает флаг у своего профиля', () => {
    for (const f of [
      'ui/screens/chat-components/DmPollBubble.tsx',
      'ui/screens/groups-components/PollBubble.tsx',
    ]) {
      const s = src(f);
      expect(s).toContain('scopedKvGetFor(pid, pollClosedKey(messageId))');
      expect(s).not.toContain('kvGet(pollClosedKey(messageId))');
    }
  });

  it('уборка следов опроса снимает и запись профиля', () => {
    const s = src('core/storage/local.ts');
    expect(s).toContain('closedKeys.map((k) => profileScopedKey(ownerProfileId, k))');
    expect(s).toContain("profileScopedKey(ownerProfileId, POLL_CLOSED_KEY_PREFIX)}' || id");
  });

  it('имя ключа «опрос завершён» набрано один раз', () => {
    expect(src('core/storage/kvKeys.ts')).toContain('return `poll_closed_${msgId}`;');
    expect(src('core/storage/local.ts')).not.toContain("'poll_closed_'");
    expect(src('core/social/pollVoteSync.ts')).toContain(
      "export { pollClosedKey } from '../storage/kvKeys';"
    );
  });

  it('проверка не пустая', () => {
    expect(src('core/social/dmPinSync.ts')).toContain('pinListKey');
  });
});
