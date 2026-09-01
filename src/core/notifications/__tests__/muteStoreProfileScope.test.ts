/**
 * Заглушённые собеседники принадлежат аккаунту, а порченый срок снимается
 * (v4.32.490).
 *
 * Дефект первый. Ключи `mute:<kind>:<id>` лежали без номера профиля, и
 * объяснялось это тем, что «mute — настройка устройства». Настройка устройства
 * — это звонить или вибрировать; а в имени ключа стоит открытый ключ
 * собеседника, id группы или id публикации, то есть конкретный человек. Такой
 * человек бывает общим у двух аккаунтов на одном телефоне: заглушённый в
 * первом молчал и во втором, где его никто не глушил, — сообщения там
 * пропадали беззвучно; список «Заглушённые» показывал второму аккаунту людей,
 * которых он не добавлял; а уборка при удалении профиля (`p<id>:%`) эти записи
 * не забирала.
 *
 * Дефект второй. Далёкая дата в `until:` не отвергалась, а подрезалась до
 * «сейчас плюс год» — и подрезалась заново при каждом чтении. Срок уезжал
 * вперёд со скоростью хода времени, и запись не истекала никогда: ни ленивой
 * проверкой, ни уборкой. Комментарий над этим кодом обещал ровно обратное.
 *
 * Дефект третий. `setMuted` принимал любой `number`, включая NaN: он
 * записывался как `until:NaN`, при чтении не разбирался и давал «не
 * заглушено» — отсрочка молча не работала.
 *
 * v4.32.510: имена ключей в проверках ниже переписаны с открытого ключа на
 * did:key — под этой формой записи и лежат. Сам разъезд форм разбирается
 * отдельно, в muteChatIdKey.test.ts.
 */
const mockKv = new Map<string, string>();
let mockActiveId = 1;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  getMuteState,
  isMuted,
  listMuted,
  setMuted,
  sweepExpiredMutes,
  unmute,
} from '../muteStore';
import { didFromPubB64 } from '../../identity/did';

const PEER = 'P'.repeat(43);
/** Та же личность в канонической форме — под ней запись и лежит. */
const PEER_DID = didFromPubB64(PEER) as string;
const GROUP = 'g-shared';
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  mockKv.clear();
  mockActiveId = 1;
  jest.clearAllMocks();
});

describe('заглушение принадлежит аккаунту', () => {
  it('запись уходит в namespace профиля, а не под общее имя', async () => {
    mockActiveId = 3;
    await setMuted('chat', PEER);
    expect(mockKv.get(`p3:mute:chat:${PEER_DID}`)).toBe('1');
    expect(mockKv.has(`mute:chat:${PEER_DID}`)).toBe(false);
  });

  it('заглушённый в одном аккаунте не молчит во втором', async () => {
    mockActiveId = 3;
    await setMuted('chat', PEER);
    mockActiveId = 5;
    expect(await isMuted('chat', PEER)).toBe(false);
    mockActiveId = 3;
    expect(await isMuted('chat', PEER)).toBe(true);
  });

  it('список «Заглушённые» не показывает чужих людей', async () => {
    mockActiveId = 3;
    await setMuted('chat', PEER);
    await setMuted('group', GROUP);
    mockActiveId = 5;
    expect(await listMuted()).toEqual([]);
    mockActiveId = 3;
    expect((await listMuted()).map((e) => e.id).sort()).toEqual([GROUP, PEER_DID].sort());
  });

  it('снятие в одном аккаунте не снимает во втором', async () => {
    mockActiveId = 3;
    await setMuted('chat', PEER);
    mockActiveId = 5;
    await setMuted('chat', PEER);
    await unmute('chat', PEER);
    mockActiveId = 3;
    expect(await isMuted('chat', PEER)).toBe(true);
  });

  it('уборка удалённого профиля (p<id>:%) забирает эти записи', async () => {
    mockActiveId = 4;
    await setMuted('chat', PEER);
    await setMuted('post', 'post-1');
    expect([...mockKv.keys()].filter((k) => !k.startsWith('p4:'))).toEqual([]);
  });

  it('записи, сделанные до v4.32.490, достаются первому профилю', async () => {
    mockKv.set(`mute:chat:${PEER_DID}`, '1');
    mockActiveId = 2;
    expect(await isMuted('chat', PEER)).toBe(false);
    mockActiveId = 1;
    expect(await isMuted('chat', PEER)).toBe(true);
    expect(mockKv.get(`p1:mute:chat:${PEER_DID}`)).toBe('1');
    expect(mockKv.has(`mute:chat:${PEER_DID}`)).toBe(false);
  });

  it('старые записи попадают и в список — вместе с переездом', async () => {
    mockKv.set(`mute:group:${GROUP}`, '1');
    const list = await listMuted('group');
    expect(list).toEqual([{ kind: 'group', id: GROUP, untilMs: null }]);
    expect(mockKv.get(`p1:mute:group:${GROUP}`)).toBe('1');
    expect(mockKv.has(`mute:group:${GROUP}`)).toBe(false);
  });
});

describe('срок отсрочки', () => {
  it('живая отсрочка держится', async () => {
    await setMuted('chat', PEER, { untilMs: Date.now() + HOUR });
    expect(await isMuted('chat', PEER)).toBe(true);
  });

  it('порченый далёкий срок снимает заглушение, а не продлевает его вечно', async () => {
    mockKv.set(`p1:mute:chat:${PEER_DID}`, 'until:99999999999999');
    expect(await isMuted('chat', PEER)).toBe(false);
    expect(mockKv.has(`p1:mute:chat:${PEER_DID}`)).toBe(false);
  });

  it('порченый срок не переживает уборку', async () => {
    mockKv.set(`p1:mute:chat:${PEER_DID}`, 'until:99999999999999');
    expect(await sweepExpiredMutes()).toEqual({ removed: 1, migrated: 0 });
    expect(mockKv.size).toBe(0);
  });

  it('порченый срок не попадает в список «Заглушённые»', async () => {
    mockKv.set(`p1:mute:chat:${PEER_DID}`, 'until:99999999999999');
    expect(await listMuted()).toEqual([]);
  });

  it('истёкшая отсрочка снимается лениво', async () => {
    mockKv.set(`p1:mute:chat:${PEER_DID}`, `until:${Date.now() - 1}`);
    expect(await isMuted('chat', PEER)).toBe(false);
    expect(mockKv.has(`p1:mute:chat:${PEER_DID}`)).toBe(false);
  });

  it('NaN не записывается как отсрочка', async () => {
    await setMuted('chat', PEER, { untilMs: Number.NaN });
    expect([...mockKv.values()]).not.toContain('until:NaN');
    expect(await isMuted('chat', PEER)).toBe(false);
  });

  it('прошедший срок не превращается в бессрочное молчание', async () => {
    await setMuted('chat', PEER, { untilMs: Date.now() - HOUR });
    expect(await isMuted('chat', PEER)).toBe(false);
  });

  it('слишком далёкий срок подрезается при записи — и потом истекает', async () => {
    await setMuted('chat', PEER, { untilMs: Date.now() + 50 * 365 * 24 * HOUR });
    const state = await getMuteState('chat', PEER);
    expect(state.muted).toBe(true);
    expect(state.untilMs).not.toBeNull();
    expect(state.untilMs as number).toBeLessThanOrEqual(Date.now() + 366 * 24 * HOUR);
  });

  it('запись неизвестного формата считается порченой', async () => {
    mockKv.set(`p1:mute:chat:${PEER_DID}`, 'yes');
    expect(await isMuted('chat', PEER)).toBe(false);
    expect(mockKv.has(`p1:mute:chat:${PEER_DID}`)).toBe(false);
  });

  it('бессрочное заглушение уборка не трогает', async () => {
    await setMuted('chat', PEER);
    expect(await sweepExpiredMutes()).toEqual({ removed: 0, migrated: 0 });
    expect(await isMuted('chat', PEER)).toBe(true);
  });
});
