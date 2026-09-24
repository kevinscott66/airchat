/**
 * Окно просьбы о карточке принадлежит профилю, а не устройству (v4.32.826).
 *
 * Дефект. У просьбы прислать профиль и у ответа на неё одно окно — пять минут,
 * и обе отметки лежат в картах на уровне модуля. Ключом в них стоял один
 * собеседник. Карты смену профиля переживают, значит окно было общим на все
 * мои профили сразу: стоило одному из них попросить карточку соседа или
 * ответить ему, и следующие пять минут другой профиль на того же соседа не
 * тратил ни просьбы, ни ответа.
 *
 * Цена. Ровно та, ради которой профили и заведены: они не должны знать друг о
 * друге. Переключился с рабочего на личный, открыл карточку того же человека —
 * кружок с буквой и ничего больше, потому что просьбу «уже отправляли» (с
 * другого профиля). С той стороны хуже: ответ не уходит, а кадр объявляется
 * разобранным, и просящий переспросит не раньше чем через те же пять минут —
 * своё окно он занял этой же просьбой.
 *
 * Правка. В ключе окна стоит и номер профиля. Больше ничего: потолок в пятьсот
 * записей, вытеснение самых старых и сама длина окна остались прежними.
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

const mockSend = jest.fn(async (): Promise<string> => 'cid-826');
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: (...a: unknown[]) => mockSend(...(a as [])) }),
}));

const mockReach = jest.fn(async () => true);
jest.mock('../sendGate', () => ({ canReachPeer: (...a: unknown[]) => mockReach(...(a as [])) }));

jest.mock('../contacts', () => ({
  listContactsFor: jest.fn(async () => []),
  setPeerProfileFor: jest.fn(async () => true),
}));

/** Какой профиль сейчас открыт: просьба уходит от него. */
let mockActiveId = 7;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

jest.mock('../../identity/ownProfile', () => ({
  getOwnDisplayNameFor: jest.fn(async () => 'Рита'),
  getOwnUsernameFor: jest.fn(async () => null),
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
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: jest.fn(async () => null) }));
jest.mock('../../identity/verification', () => ({ badgeFor: jest.fn(() => false) }));
jest.mock('../../identity/did', () => ({ didFromPubB64: (p: string) => `did:key:${p}` }));

import { PROFILE_PREFIX, PROFILE_REQ_PREFIX, encodeProfileRequest } from '../profileEnvelope';
import { handleIncomingProfileRequest, requestPeerProfile } from '../profileSync';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/** Прислать просьбу названному профилю от названного собеседника. */
const ask = (peer: string, pid: number): Promise<string> =>
  handleIncomingProfileRequest(encodeProfileRequest(), peer, pid);

/** Что ушло: только карточки. */
const cards = (): string[] =>
  mockSend.mock.calls
    .map((c) => (c as unknown as [string, string])[1])
    .filter((t) => t.startsWith(PROFILE_PREFIX));

/** Что ушло: только просьбы. */
const requests = (): string[] =>
  mockSend.mock.calls
    .map((c) => (c as unknown as [string, string])[1])
    .filter((t) => t.startsWith(PROFILE_REQ_PREFIX));

beforeEach(() => {
  mockKv.clear();
  mockActiveId = 7;
  mockReach.mockResolvedValue(true);
  mockSend.mockReset();
  mockSend.mockResolvedValue('cid-826');
});

describe('окно одного профиля не молчит за другой', () => {
  it('второй профиль отвечает тому же собеседнику, а не отмалчивается', async () => {
    // Собеседник один: он просто просит карточку у каждого из моих профилей.
    expect(await ask('PEER_A', 7)).toBe('consumed');
    expect(await ask('PEER_A', 8)).toBe('consumed');
    // До правки вторая просьба упиралась в чужое окно: карточка была одна.
    expect(cards()).toHaveLength(2);
  });

  it('второй профиль просит карточку сам, а не считает её уже спрошенной', async () => {
    await requestPeerProfile('PEER_B');
    mockActiveId = 8;
    await requestPeerProfile('PEER_B');
    expect(requests()).toHaveLength(2);
  });

  it('просьба и ответ живут в разных окнах и друг друга не гасят', async () => {
    await requestPeerProfile('PEER_C');
    expect(await ask('PEER_C', 7)).toBe('consumed');
    expect(requests()).toHaveLength(1);
    expect(cards()).toHaveLength(1);
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Окно заведено против шквала: карточку открывают по десять раз подряд, а
 * недоброжелатель шлёт просьбы пачкой. Развести профили — не повод его
 * ослабить: внутри одного профиля повтор обязан упираться в частоту ровно как
 * прежде, иначе правка лечит не то и открывает отправку по первому же требованию.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: внутри профиля окно осталось прежним', () => {
  it('три просьбы подряд одному профилю — одна карточка', async () => {
    await ask('PEER_FAST', 7);
    await ask('PEER_FAST', 7);
    await ask('PEER_FAST', 7);
    expect(cards()).toHaveLength(1);
  });

  it('второй отказ по частоте — по-прежнему «разобрано», а не отсрочка', async () => {
    expect(await ask('PEER_FAST2', 7)).toBe('consumed');
    expect(await ask('PEER_FAST2', 7)).toBe('consumed');
    expect(cards()).toHaveLength(1);
  });

  it('повторное открытие карточки того же профиля просьбы не шлёт', async () => {
    await requestPeerProfile('PEER_FAST3');
    await requestPeerProfile('PEER_FAST3');
    expect(requests()).toHaveLength(1);
  });

  it('разные собеседники внутри профиля друг друга не задевают', async () => {
    await ask('PEER_X', 7);
    await ask('PEER_Y', 7);
    expect(cards()).toHaveLength(2);
  });

  it('отметка снимается по своему ключу: неудача не запирает свой же профиль', async () => {
    // v4.32.798 живёт дальше — но теперь снимается именно составной ключ. Взяли
    // бы на очистку прежний, голый, и окно осталось бы занятым навсегда.
    mockReach.mockResolvedValue(false);
    expect(await ask('PEER_FAIL', 7)).toBe('deferred');

    mockReach.mockResolvedValue(true);
    expect(await ask('PEER_FAIL', 7)).toBe('consumed');
    expect(cards()).toHaveLength(1);
  });

  it('то же у просьбы: не дошло — окно не занято', async () => {
    mockReach.mockResolvedValue(false);
    await requestPeerProfile('PEER_FAIL2');
    expect(requests()).toHaveLength(0);

    mockReach.mockResolvedValue(true);
    await requestPeerProfile('PEER_FAIL2');
    expect(requests()).toHaveLength(1);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Отметки лежат в памяти модуля, а не в базе, — это нарочно (окно против
 * шквала, а не учёт, который переживает перезапуск). Но именно поэтому смену
 * профиля они переживают, и разделять профили в ключе больше негде.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: карты общие на все профили', () => {
  it('отметки живут в памяти модуля и профилю не принадлежат', () => {
    const body = codeOnly(read('core/social/profileSync.ts'));
    expect(body).toContain('const reqSentAt = new Map<string, number>();');
    expect(body).toContain('const reqAnsweredAt = new Map<string, number>();');
    // Ни чистки при переключении профиля, ни отдельной карты на профиль.
    expect(body).not.toContain('reqSentAt.clear()');
    expect(body).not.toContain('reqAnsweredAt.clear()');
  });

  it('окно по-прежнему пять минут на обе стороны', () => {
    expect(codeOnly(read('core/social/profileSync.ts'))).toContain(
      'const REQ_COOLDOWN_MS = 5 * 60_000;'
    );
  });
});

describe('форма исходников: в ключе стоит профиль', () => {
  const BODY = codeOnly(read('core/social/profileSync.ts'));

  it('ключ собирается в одном месте', () => {
    expect(BODY).toContain('function throttleKey(pid: number, peerPubB64: string): string {');
    expect(BODY).toContain('return `${pid}|${peerPubB64}`;');
  });

  it('обе стороны берут ключ у него, а не голого собеседника', () => {
    expect(BODY).toContain('const reqKey = throttleKey(activeProfileId(), peerPubB64);');
    expect(BODY).toContain('const ansKey = throttleKey(ownerPid, senderPubB64);');
    expect(BODY).not.toContain('passThrottle(reqSentAt, peerPubB64,');
    expect(BODY).not.toContain('passThrottle(reqAnsweredAt, senderPubB64,');
  });
});
