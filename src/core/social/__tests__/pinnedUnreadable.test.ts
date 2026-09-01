/**
 * Закрепление, которое не открылось ключом данных (v4.32.576).
 *
 * Дефект. Текст закреплённого читается из своей копии сообщения, а читатели
 * (getGroupMessageTexts / getChatMessageTexts) с v4.32.575 отдают `null`,
 * когда строка есть, но ключом не открывается. resolvePinned и
 * resolveDmPinned равняли этот `null` с пустой строкой (`texts.get(id) ?? ''`),
 * и дальше «не открылось» было неотличимо от «объявление без текста»:
 * в шапке чата висела пустая полоска, в списке закреплений — пустая строка.
 *
 * Хуже показа была запись. applyLocalPin отдавал ту же пустую строку в
 * setGroupPinnedMessage, groups.pinned_message_text шифровался ею ПОВЕРХ
 * прежнего значения — и непрочитанное закрепление превращалось в пустое
 * насовсем, без обратного хода. Тот же класс, что закрыт для столбца
 * сообщения в v4.32.544 (не переписывать непрочитанное).
 *
 * Что проверяется. Что `null` доезжает до показа отдельным признаком
 * `unreadable`, что текст при этом остаётся ПУСТЫМ (пометка живёт рядом с
 * текстом, а не подменяет его — иначе она ушла бы наружу как настоящая
 * строка), что закрепление не выпадает из списка, и что в groups ничего не
 * записывается текстом.
 */
const mockKv = new Map<string, string>();
/** Своя копия сообщения: строка — прочиталась, null — есть, но не открылась. */
const mockTexts = new Map<string, string | null>();
const mockSetGroupPinned = jest.fn();
const mockSetConvPinned = jest.fn();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  setConversationPinnedMessage: (...a: unknown[]) => { mockSetConvPinned(...a); return Promise.resolve(); },
  setGroupPinnedMessage: (...a: unknown[]) => { mockSetGroupPinned(...a); return Promise.resolve(); },
  notifyChatStorageChanged: () => undefined,
  listGroupMembers: async () => [],
  getGroup: async () => null,
  getChatMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) ?? null])),
  getGroupMessageTexts: async (ids: string[]) =>
    new Map(ids.filter((i) => mockTexts.has(i)).map((i) => [i, mockTexts.get(i) ?? null])),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 7 }) },
}));

jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true, recipients: 1 }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { applyLocalDmPin, resolveDmPinned } from '../dmPinSync';
import { applyLocalPin, resolvePinned } from '../groupPinSync';

const PEER = 'P'.repeat(43);
const GROUP = 'g-1';
const PID = 7;

const GROUP_PIN = () => fs.readFileSync(path.join(__dirname, '..', 'groupPinSync.ts'), 'utf8');
const DM_PIN = () => fs.readFileSync(path.join(__dirname, '..', 'dmPinSync.ts'), 'utf8');
const GROUP_MODAL = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'groups', 'GroupPinnedListModal.tsx'),
    'utf8'
  );
const CHAT_MODAL = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'chat', 'ChatPinnedListModal.tsx'),
    'utf8'
  );
const GROUPS_SCREEN = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const CHAT_SCREEN = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');

/** Кусок файла между двумя якорями — чтобы утверждение било в одно место. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

beforeEach(() => {
  mockKv.clear();
  mockTexts.clear();
  mockSetGroupPinned.mockClear();
  mockSetConvPinned.mockClear();
});

describe('группа: непрочитанное закрепление', () => {
  it('приезжает отдельным признаком, а не пустым текстом', async () => {
    mockTexts.set('m1', null);
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m1"]');
    const list = await resolvePinned(GROUP, PID);
    expect(list).toEqual([{ id: 'm1', text: '', unreadable: true }]);
  });

  it('не выпадает из списка: закрепление осталось закреплением', async () => {
    mockTexts.set('m1', null);
    mockTexts.set('m2', 'обычное объявление');
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m1","m2"]');
    const list = await resolvePinned(GROUP, PID);
    expect(list.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  it('прочитанное закрепление признака не получает', async () => {
    mockTexts.set('m2', 'обычное объявление');
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m2"]');
    expect(await resolvePinned(GROUP, PID)).toEqual([
      { id: 'm2', text: 'обычное объявление', unreadable: false },
    ]);
  });

  it('пустой текст — это пустой текст, а не «не открылось»', async () => {
    mockTexts.set('m3', '');
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m3"]');
    expect(await resolvePinned(GROUP, PID)).toEqual([{ id: 'm3', text: '', unreadable: false }]);
  });

  it('сообщения, которого нет, в списке по-прежнему нет', async () => {
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["gone"]');
    expect(await resolvePinned(GROUP, PID)).toEqual([]);
  });

  it('длинный текст по-прежнему подрезается до 120 символов', async () => {
    mockTexts.set('m4', 'я'.repeat(500));
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m4"]');
    const list = await resolvePinned(GROUP, PID);
    expect(list[0].text).toHaveLength(120);
    expect(list[0].unreadable).toBe(false);
  });

  it('в groups не записывается текстом: id есть, текста нет', async () => {
    mockTexts.set('m1', null);
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(mockSetGroupPinned).toHaveBeenCalledWith(GROUP, PID, 'm1', null);
  });

  it('прочитанное закрепление записывается текстом как раньше', async () => {
    mockTexts.set('m2', 'обычное объявление');
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    expect(mockSetGroupPinned).toHaveBeenCalledWith(GROUP, PID, 'm2', 'обычное объявление');
  });

  it('открепление последнего чистит и id, и текст', async () => {
    mockTexts.set('m2', 'обычное объявление');
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: true });
    mockSetGroupPinned.mockClear();
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm2', on: false });
    expect(mockSetGroupPinned).toHaveBeenCalledWith(GROUP, PID, null, null);
  });

  it('непрочитанное сверху не отдаёт в groups текст того, что под ним', async () => {
    mockTexts.set('m1', null);
    mockTexts.set('m2', 'обычное объявление');
    mockKv.set(`p${PID}:group_pinned_list_${GROUP}`, '["m2"]');
    await applyLocalPin({ groupId: GROUP, ownerProfileId: PID, msgId: 'm1', on: true });
    expect(mockSetGroupPinned).toHaveBeenCalledWith(GROUP, PID, 'm1', null);
  });
});

describe('личка: непрочитанное закрепление', () => {
  it('приезжает отдельным признаком, а не пустым текстом', async () => {
    mockTexts.set('d1', null);
    mockKv.set(`p${PID}:pinned_list_${PEER}`, '["d1"]');
    expect(await resolveDmPinned(PEER, PID)).toEqual([{ id: 'd1', text: '', unreadable: true }]);
  });

  it('прочитанное закрепление признака не получает', async () => {
    mockTexts.set('d2', 'важное');
    mockKv.set(`p${PID}:pinned_list_${PEER}`, '["d2"]');
    expect(await resolveDmPinned(PEER, PID)).toEqual([{ id: 'd2', text: 'важное', unreadable: false }]);
  });

  it('чужой id в списке не появляется', async () => {
    mockKv.set(`p${PID}:pinned_list_${PEER}`, '["foreign"]');
    expect(await resolveDmPinned(PEER, PID)).toEqual([]);
  });

  it('в строке разговора и раньше лежал только id — так и остаётся', async () => {
    mockTexts.set('d1', null);
    await applyLocalDmPin({ peerPubB64: PEER, ownerProfileId: PID, msgId: 'd1', on: true });
    expect(mockSetConvPinned).toHaveBeenCalledWith(PEER, PID, 'd1');
  });
});

describe('форма исходников: признак не подменяет текст', () => {
  it('resolvePinned различает null и пустую строку', () => {
    const body = slice(GROUP_PIN(), 'export async function resolvePinned', '/** Пишет закрепление');
    expect(body).toContain('unreadable: text === null');
    expect(body).toContain("text: text === null ? '' : text.slice(0, 120)");
    expect(body).not.toContain("?? ''");
  });

  it('resolveDmPinned различает null и пустую строку', () => {
    const body = slice(DM_PIN(), 'export async function resolveDmPinned', '/** Пишет закрепление');
    expect(body).toContain('unreadable: text === null');
    expect(body).not.toContain("?? ''");
  });

  it('applyLocalPin не отдаёт текст непрочитанного закрепления в groups', () => {
    const body = slice(GROUP_PIN(), 'export async function applyLocalPin', 'export async function clearPinned');
    expect(body).toContain('top && !top.unreadable ? top.text : null');
    expect(body).not.toContain("entries[0]?.text ?? null");
  });

  it('обе сущности несут признак рядом с текстом', () => {
    expect(GROUP_PIN()).toContain('export type PinnedEntry = { id: string; text: string; unreadable: boolean };');
    expect(DM_PIN()).toContain('export type DmPinnedEntry = { id: string; text: string; unreadable: boolean };');
  });

  it('списки закреплений рисуют пометку, а не пустую строку', () => {
    for (const src of [GROUP_MODAL(), CHAT_MODAL()]) {
      expect(src).toContain('unreadable?: boolean;');
      expect(src).toContain('const unreadable = isUnreadableMessage(pin);');
      expect(src).toContain('{unreadable ? UNREADABLE_MESSAGE_TEXT : pin.text}');
    }
  });

  it('баннер группы рисует пометку вместо пустой полоски', () => {
    const src = GROUPS_SCREEN();
    // v4.32.603: у наследного текста из колонки групп своя пометка, поэтому
    // строка списка спрашивается только когда она есть.
    expect(src).toContain(
      'const currentPinUnreadable = currentPin ? isUnreadableMessage(currentPin) : pinnedMsgUnreadable;'
    );
    expect(src).toContain('currentPinUnreadable ? UNREADABLE_MESSAGE_TEXT : currentPin.text');
  });

  it('баннер лички рисует пометку вместо пустой полоски', () => {
    const src = CHAT_SCREEN();
    expect(src).toContain('const displayPinUnreadable = isUnreadableMessage(displayPin);');
    expect(src).toContain("{displayPinUnreadable ? UNREADABLE_MESSAGE_TEXT : displayPin?.text ?? ''}");
  });
});
