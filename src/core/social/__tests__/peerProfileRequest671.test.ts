/**
 * Карточка собеседника умеет ПОПРОСИТЬ профиль (v4.32.671).
 *
 * Жалоба была короткой: в профиле контакта не видно ни юзернейма, ни всего
 * прочего. Разбор показал два независимых повода.
 *
 * 1. Привязанные учётные записи не доходили до модели карточки вовсе:
 *    `UserProfilePeek` собирал объект для `peekIdentity` без поля `links`,
 *    хотя и хранилище, и приём, и сама модель его знали. Ряд ссылок у
 *    собеседника был пуст ВСЕГДА — своя карточка брала их из `own` и
 *    работала, поэтому проверка «у себя видно» ничего не показывала.
 *
 * 2. Профиль ездил только «от себя»: рассылкой после правки и досылкой при
 *    открытии переписки. У собеседника, который наше приложение открывал
 *    редко, а нашу с ним переписку — ни разу, карточка оставалась пустой
 *    сколько угодно долго, и это неотличимо от «у него ничего не заполнено».
 *    Спросить было нечем: обратного поиска по открытому ключу нет и на
 *    сервере — юзернеймы там лежат свёрткой с перцем и по ключу не ищутся.
 *
 * Здесь проверяется вторая половина: просьба уходит, ответ уходит в обход
 * карты «этой версии он уже видел», и обе стороны ограничены по частоте —
 * ответ на просьбу это отправка своей карточки по чужой команде.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGetFor: jest.fn(async (pid: number, key: string) => mockKv.get(`${pid}:${key}`) ?? null),
  // v4.32.693: карта «эту версию он уже видел» читается трёхзначно — `null`
  // означает отказ базы, и запись поверх настоящей карты не идёт.
  scopedKvTryGetFor: jest.fn(async (pid: number, key: string) => ({
    value: mockKv.get(`${pid}:${key}`) ?? null,
  })),
  scopedKvSetFor: jest.fn(async (pid: number, key: string, v: string) => {
    mockKv.set(`${pid}:${key}`, v);
  }),
  scopedKvSet: jest.fn(async () => {}),
}));

const mockSend = jest.fn(async () => {});
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: (...a: unknown[]) => mockSend(...(a as [])) }),
}));

const mockReach = jest.fn(async () => true);
jest.mock('../sendGate', () => ({ canReachPeer: (...a: unknown[]) => mockReach(...(a as [])) }));

jest.mock('../contacts', () => ({
  listContactsFor: jest.fn(async () => []),
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

import {
  PROFILE_PREFIX,
  PROFILE_REQ_PREFIX,
  encodeProfileRequest,
  isProfileRequest,
} from '../profileEnvelope';
import {
  requestPeerProfile,
  handleIncomingProfileRequest,
  syncMyProfileTo,
} from '../profileSync';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PEEK = (): string => read('ui/components/UserProfilePeek.tsx');
const MSG = (): string => read('core/social/messaging.ts');
const SYNC = (): string => read('core/social/profileSync.ts');

/** Строки кода без комментариев: свой же комментарий, цитирующий старую
 *  запись, иначе ломает отрицательные проверки. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

beforeEach(() => {
  mockKv.clear();
  mockSend.mockClear();
  mockReach.mockClear();
  mockReach.mockResolvedValue(true);
});

describe('повод для правки жив', () => {
  it('профиль по-прежнему едет только по своей воле — тянуть его нечем', () => {
    // Если бы появился обычный «запрос профиля» через сервер, просьба
    // конвертом была бы не нужна. Не появился: единственные отправители —
    // рассылка и досылка при открытии чата, обе про СВОЙ профиль.
    const src = codeOnly(SYNC());
    expect(src).toContain('export async function broadcastMyProfile(');
    expect(src).toContain('export async function syncMyProfileTo(');
    expect(src).not.toContain('fetchPeerProfile(');
  });

  it('модель карточки по-прежнему ждёт привязки от места вызова', () => {
    // Ровно то место, из-за которого ряд ссылок у собеседника был пуст: сама
    // модель `links` у контакта читает и ничего не выдумывает.
    expect(read('ui/components/profilePeekModel.ts')).toContain(
      'links: (isSelf ? own?.links : contact?.links) ?? [],',
    );
  });

  it('у просьбы тот же занятый байт, что у профиля, но другое слово', () => {
    expect(PROFILE_REQ_PREFIX).not.toBe(PROFILE_PREFIX);
    expect(PROFILE_REQ_PREFIX.startsWith('\x14')).toBe(true);
    expect(PROFILE_PREFIX.startsWith('\x14')).toBe(true);
    expect(isProfileRequest(PROFILE_PREFIX)).toBe(false);
    expect(isProfileRequest(encodeProfileRequest())).toBe(true);
  });
});

describe('просьба уходит', () => {
  it('карточка просит профиль конвертом-просьбой', async () => {
    await requestPeerProfile('PEER_A');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('PEER_A', encodeProfileRequest());
  });

  it('повторное открытие карточки не шлёт просьбу заново', async () => {
    await requestPeerProfile('PEER_B');
    await requestPeerProfile('PEER_B');
    await requestPeerProfile('PEER_B');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('несостоявшаяся отправка не занимает окно', async () => {
    // Пять минут тишины после отправки, которой не было, — это пять минут
    // пустой карточки на ровном месте.
    mockReach.mockResolvedValue(false);
    await requestPeerProfile('PEER_C');
    expect(mockSend).not.toHaveBeenCalled();
    mockReach.mockResolvedValue(true);
    await requestPeerProfile('PEER_C');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('ответ на просьбу', () => {
  it('отвечает конвертом профиля тому, кто прислал просьбу', async () => {
    const answered = await handleIncomingProfileRequest(encodeProfileRequest(), 'PEER_D', 7);
    expect(answered).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [to, text] = mockSend.mock.calls[0] as unknown as [string, string];
    expect(to).toBe('PEER_D');
    expect(text.startsWith(PROFILE_PREFIX)).toBe(true);
  });

  it('отвечает, даже если эту версию собеседник уже получал', async () => {
    // Обычная досылка молчит по карте отправленного — и это правильно. Но у
    // просящего карточки нет, а карта утверждает обратное: без обхода карты
    // ответом на просьбу было бы молчание.
    await syncMyProfileTo('PEER_E');
    expect(mockSend).toHaveBeenCalledTimes(1);
    await syncMyProfileTo('PEER_E');
    expect(mockSend).toHaveBeenCalledTimes(1); // карта сработала

    await handleIncomingProfileRequest(encodeProfileRequest(), 'PEER_E', 7);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('вторая просьба подряд остаётся без ответа', async () => {
    await handleIncomingProfileRequest(encodeProfileRequest(), 'PEER_F', 7);
    await handleIncomingProfileRequest(encodeProfileRequest(), 'PEER_F', 7);
    await handleIncomingProfileRequest(encodeProfileRequest(), 'PEER_F', 7);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('без подтверждённого отправителя ответа нет, но конверт считается своим', async () => {
    // Тела у просьбы нет намеренно: адресат ответа — проверенный подписью
    // отправитель, и назвать себя кем-то другим в просьбе нечем.
    expect(await handleIncomingProfileRequest(encodeProfileRequest(), undefined, 7)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('чужой текст не считается просьбой', async () => {
    expect(await handleIncomingProfileRequest('привет', 'PEER_G', 7)).toBe(false);
    expect(await handleIncomingProfileRequest(PROFILE_PREFIX + '{}', 'PEER_G', 7)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('места вызова', () => {
  it('приём личных сообщений разбирает просьбу и не делает из неё пузырь', () => {
    const src = codeOnly(MSG());
    expect(src).toContain("import { PROFILE_PREFIX, PROFILE_REQ_PREFIX } from './profileEnvelope';");
    const body = slice(src, 'if (textPayload.text?.startsWith(PROFILE_REQ_PREFIX)) {', '\n    }');
    expect(body).toContain("await import('./profileSync')");
    expect(body).toContain('handleIncomingProfileRequest');
    expect(body).toContain('peerPubKeyB64, ownerPid');
  });

  it('карточка отдаёт привязки собеседника модели', () => {
    const src = codeOnly(PEEK());
    const body = slice(src, '() => peekIdentity({', 'fallbackName,');
    expect(body).toContain('links: contact.links,');
    // Соседние поля на месте — срез взят там, где нужно.
    expect(body).toContain('username: contact.peerUsername,');
    expect(body).toContain('peerStatus: contact.peerStatus,');
  });

  it('карточка просит профиль, которого у неё ни разу не было', () => {
    const src = codeOnly(PEEK());
    expect(src).toContain(
      "import { requestPeerProfile } from '../../core/social/profileSync';",
    );
    expect(src).toContain(
      'if (!mine && (found?.profileTs ?? 0) === 0) void requestPeerProfile(resolved.pubB64);',
    );
    // Своей карточки это не касается: она читается с устройства.
    const at = src.indexOf('void requestPeerProfile(');
    expect(src.slice(0, at)).toContain('const found = all.find(');
  });
});

describe('проверка не пустая', () => {
  it('файлы прочитаны, а не пусты', () => {
    expect(PEEK().length).toBeGreaterThan(1000);
    expect(MSG().length).toBeGreaterThan(1000);
    expect(SYNC().length).toBeGreaterThan(1000);
  });

  it('якоря срезов встречаются ровно по разу', () => {
    expect(codeOnly(MSG()).split('if (textPayload.text?.startsWith(PROFILE_REQ_PREFIX)) {').length - 1).toBe(1);
    expect(codeOnly(PEEK()).split('() => peekIdentity({').length - 1).toBe(1);
  });

  it('несуществующей строки в исходнике нет', () => {
    expect(codeOnly(PEEK())).not.toContain('links: contact.linksНикогда,');
  });
});
