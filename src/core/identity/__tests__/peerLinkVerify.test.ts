/**
 * Проверка чужой привязки (v4.32.575).
 *
 * Сама проверка публикации живёт в linkProofCheck и покрыта там. Здесь —
 * своя половина: к чему привязан запомненный ответ и что в сеть без нажатия
 * никто не ходит.
 */
import { peerLinkVerifiedAt, verifyPeerLink } from '../peerLinkVerify';
import type { ProfileLink } from '../profileLinks';

const mockStore = new Map<string, string>();
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGet: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  scopedKvSet: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));

const mockCheck = jest.fn();
jest.mock('../linkProofCheck', () => ({
  checkLinkProof: (...args: unknown[]) => mockCheck(...args),
}));

const PEER = 'cGVlcg==';
const OTHER = 'b3RoZXI=';
const GIST = 'https://gist.github.com/0123456789abcdef0123456789abcdef';
const link: ProfileLink = { p: 'github', h: 'octocat', u: GIST };

beforeEach(() => {
  mockStore.clear();
  mockCheck.mockReset();
  mockCheck.mockResolvedValue({ ok: true });
});

describe('peerLinkVerify', () => {
  it('до нажатия ответа нет и в сеть никто не ходит', async () => {
    expect(await peerLinkVerifiedAt(PEER, link)).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('успешная проверка запоминается и переживает перезаход', async () => {
    const res = await verifyPeerLink(PEER, link);
    expect(res.ok).toBe(true);
    expect(await peerLinkVerifiedAt(PEER, link)).toEqual(expect.any(Number));
    expect(mockCheck).toHaveBeenCalledWith(GIST, {
      platform: 'github',
      handle: 'octocat',
      publicKeyB64: PEER,
    });
  });

  it('ответ привязан к адресу: подменили публикацию — галочка гаснет', async () => {
    await verifyPeerLink(PEER, link);
    const moved: ProfileLink = { ...link, u: 'https://gist.github.com/ffffffffffffffffffffffffffffffff' };
    expect(await peerLinkVerifiedAt(PEER, moved)).toBeNull();
  });

  it('ответ привязан к аккаунту: та же учётная запись у другого — не подтверждена', async () => {
    await verifyPeerLink(PEER, link);
    expect(await peerLinkVerifiedAt(OTHER, link)).toBeNull();
  });

  it('неудача не запоминается — иначе вчерашний сбой сети показывали бы как факт', async () => {
    mockCheck.mockResolvedValue({ ok: false, reason: 'network' });
    const res = await verifyPeerLink(PEER, link);
    expect(res).toEqual({ ok: false, reason: 'network' });
    expect(await peerLinkVerifiedAt(PEER, link)).toBeNull();
    mockCheck.mockResolvedValue({ ok: true });
    await verifyPeerLink(PEER, link);
    expect(await peerLinkVerifiedAt(PEER, link)).toEqual(expect.any(Number));
  });

  it('имя без адреса проверять негде', async () => {
    const claimed: ProfileLink = { p: 'x', h: 'jack', u: null };
    expect(await verifyPeerLink(PEER, claimed)).toEqual({ ok: false, reason: 'no_token' });
    expect(await peerLinkVerifiedAt(PEER, claimed)).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe('ответ относится к паре «адрес + имя» (v4.32.638)', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: то же имя по тому же адресу остаётся подтверждённым', async () => {
    await verifyPeerLink(PEER, link);
    expect(await peerLinkVerifiedAt(PEER, link)).toEqual(expect.any(Number));
  });

  it('тот же адрес под другим именем не считается подтверждённым', async () => {
    // Своя настоящая публикация: имя своё, ключ свой, проверка честно прошла.
    await verifyPeerLink(PEER, link);
    // Тот же адрес, но в конверте профиля заявлено чужое имя. Сверяется автор
    // публикации, а его никто не спрашивал про torvalds.
    const impostor: ProfileLink = { ...link, h: 'torvalds' };
    expect(await peerLinkVerifiedAt(PEER, impostor)).toBeNull();
  });

  it('регистр имени различием не считается', async () => {
    await verifyPeerLink(PEER, link);
    expect(await peerLinkVerifiedAt(PEER, { ...link, h: 'OctoCat' })).toEqual(expect.any(Number));
  });

  it('запись без имени (до v4.32.638) подтверждением не считается', async () => {
    // Ровно то, что лежит на устройствах со старой версии.
    mockStore.set(
      `peer_link:github:${PEER}`,
      JSON.stringify({ url: GIST, verifiedAt: 1_700_000_000_000 })
    );
    expect(await peerLinkVerifiedAt(PEER, link)).toBeNull();
    // И чинится обычной проверкой, а не переустановкой.
    await verifyPeerLink(PEER, link);
    expect(await peerLinkVerifiedAt(PEER, link)).toEqual(expect.any(Number));
  });

  it('имя действительно попадает в запись, а не сверяется вхолостую', async () => {
    await verifyPeerLink(PEER, link);
    const raw = mockStore.get(`peer_link:github:${PEER}`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toMatchObject({ url: GIST, h: 'octocat' });
  });
});
