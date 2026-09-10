/**
 * Настройка «кто видит фото» решает один раз на отправку (v4.32.707).
 *
 * Переключатель читался ДВАЖДЫ за одну отправку. Сначала в `sendProfileTo` —
 * чтобы понять, надо ли вообще сверяться со списком контактов; затем ещё раз в
 * `buildEnvelope` — чтобы решить, класть ли фотографию в конверт. Между
 * чтениями стоит база, и совпадать их ответы не обязаны.
 *
 * Два расхождения ведут к одному и тому же исходу — фотография уезжает тому,
 * от кого её прятали:
 *
 * 1. Первое чтение не удалось (`null`). Условие `null === 'contacts'` ложно,
 *    значит аудиторией назначается `contacts`, а список контактов не
 *    спрашивается ВООБЩЕ. Второе чтение проходит и возвращает `contacts` —
 *    и `avatarAllowed('contacts', 'contacts')` разрешает фотографию
 *    постороннему, которого никто не проверял.
 *
 * 2. Первое чтение вернуло `contacts` и посторонний честно распознан
 *    (`direct`), а второе застало уже `everybody` — например человек как раз
 *    переключил настройку, или первое чтение видело устаревшее значение.
 *    `avatarAllowed('everybody', 'direct')` разрешает — и фотография снова
 *    уходит.
 *
 * Отозвать отправленную фотографию нельзя, поэтому правка простая: положение
 * читается ОДИН раз на отправку и дальше едет значением, а не повторным
 * чтением. Здесь это проверяется и поведением, и формой исходника.
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

// v4.32.715: пустой ответ sendMessage теперь означает отказ, а отказ не
// заносится в карту «этому уже сообщено». Возвращаем настоящий cid.
const mockSend = jest.fn(async () => 'cid-707');
jest.mock('../messaging', () => ({
  getMessagingService: () => ({ sendMessage: (...a: unknown[]) => mockSend(...(a as [])) }),
}));

jest.mock('../sendGate', () => ({ canReachPeer: jest.fn(async () => true) }));

let mockContacts: string[] = [];
let mockContactsFail = false;
const mockListContacts = jest.fn(async () => {
  if (mockContactsFail) throw new Error('база не ответила');
  return mockContacts.map((peerPublicKey) => ({ peerPublicKey }));
});
jest.mock('../contacts', () => ({
  listContactsFor: (...a: unknown[]) => mockListContacts(...(a as [])),
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
  ownAvatarNameFor: jest.fn(async () => 'ava.jpg'),
  // Путь недоступен нарочно: единственный источник дескриптора — кэш загрузки
  // ниже, поэтому «фотография в конверте» не может появиться случайно.
  ownAvatarUriFor: jest.fn(async () => null),
}));

// Положение переключателя программируется по шагам: так проверяются оба
// расхождения — «первое чтение упало» и «между чтениями значение сменилось».
const mockVis = jest.fn(async () => 'everybody' as string | null);
jest.mock('../../settings/avatarVisibility', () => ({
  avatarVisibilityTryFor: (...a: unknown[]) => mockVis(...(a as [])),
}));

jest.mock('../../identity/ownBadge', () => ({ ownBadgeGrantFor: jest.fn(async () => null) }));
jest.mock('../../identity/ownLinks', () => ({ ownLinksFor: jest.fn(async () => []) }));
jest.mock('../../identity/verification', () => ({ badgeFor: jest.fn(() => false) }));
jest.mock('../../identity/did', () => ({ didFromPubB64: (p: string) => `did:key:${p}` }));

import { decodeProfileEnvelope } from '../profileEnvelope';
import { syncMyProfileTo, broadcastMyProfile } from '../profileSync';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SYNC = (): string => read('core/social/profileSync.ts');
const VIS = (): string => read('core/settings/avatarVisibility.ts');

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

/** Форма настоящего CID: конверт разбирается на приёме по-настоящему, и
 *  подставленный плейсхолдер уронил бы весь конверт (см. isSafeMediaCid). */
const AVATAR_CID = `Qm${'a'.repeat(44)}`;
const STRANGER = 'pubStranger00000000000000';
const FRIEND = 'pubFriend0000000000000000';

/** Дескриптор фотографии берётся из кэша загрузки — заливать нечего. */
function seedAvatarUpload(): void {
  mockKv.set(
    '7:profile:avatar_upload',
    JSON.stringify({ name: 'ava.jpg', cid: AVATAR_CID, at: Date.now() })
  );
}

function sentAvatarCid(): string | null | undefined {
  const call = mockSend.mock.calls[mockSend.mock.calls.length - 1] as unknown as [string, string];
  const env = decodeProfileEnvelope(call[1], Date.now());
  return env?.avatarCid;
}

beforeEach(() => {
  mockKv.clear();
  seedAvatarUpload();
  mockSend.mockClear();
  mockListContacts.mockClear();
  mockVis.mockReset();
  mockContacts = [FRIEND];
  mockContactsFail = false;
});

describe('расхождение двух чтений больше не отдаёт фотографию', () => {
  it('сбой первого чтения не открывает фотографию постороннему', async () => {
    // Прежде: `null` не равен 'contacts', значит аудитория «contacts» и список
    // контактов не спрашивается; второе чтение возвращает 'contacts' и
    // разрешает фотографию тому, кого не проверяли.
    mockVis.mockResolvedValueOnce(null).mockResolvedValue('contacts');
    await syncMyProfileTo(STRANGER);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentAvatarCid()).toBeNull();
  });

  it('на эту отправку переключатель спрошен ровно один раз', async () => {
    mockVis.mockResolvedValueOnce(null).mockResolvedValue('contacts');
    await syncMyProfileTo(STRANGER);
    expect(mockVis).toHaveBeenCalledTimes(1);
  });

  it('смена значения между чтениями не открывает фотографию постороннему', async () => {
    // Прежде: первое чтение 'contacts' честно давало «direct», а второе уже
    // 'everybody' — и `avatarAllowed('everybody', 'direct')` разрешал.
    mockVis.mockResolvedValueOnce('contacts').mockResolvedValue('everybody');
    await syncMyProfileTo(STRANGER);
    expect(sentAvatarCid()).toBeNull();
    expect(mockVis).toHaveBeenCalledTimes(1);
  });

  it('остальная карточка при этом уезжает — молчания вместо отправки нет', async () => {
    mockVis.mockResolvedValueOnce(null).mockResolvedValue('contacts');
    await syncMyProfileTo(STRANGER);
    const call = mockSend.mock.calls[0] as unknown as [string, string];
    expect(call[0]).toBe(STRANGER);
    const env = decodeProfileEnvelope(call[1], Date.now());
    expect(env?.name).toBe('Рита');
    expect(env?.username).toBe('rita');
  });

  it('своему контакту расхождение тоже не меняет ответ', async () => {
    mockVis.mockResolvedValueOnce('contacts').mockResolvedValue('nobody');
    await syncMyProfileTo(FRIEND);
    expect(sentAvatarCid()).toBe(AVATAR_CID);
    expect(mockVis).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('«всем» — фотография уходит и постороннему', async () => {
    mockVis.mockResolvedValue('everybody');
    await syncMyProfileTo(STRANGER);
    expect(sentAvatarCid()).toBe(AVATAR_CID);
  });

  it('«всем» — список контактов вообще не читается', async () => {
    mockVis.mockResolvedValue('everybody');
    await syncMyProfileTo(STRANGER);
    expect(mockListContacts).not.toHaveBeenCalled();
  });

  it('«никому» — фотографии нет даже своему контакту', async () => {
    mockVis.mockResolvedValue('nobody');
    await syncMyProfileTo(FRIEND);
    expect(sentAvatarCid()).toBeNull();
  });

  it('«только контакты» — своему контакту фотография уходит', async () => {
    mockVis.mockResolvedValue('contacts');
    await syncMyProfileTo(FRIEND);
    expect(mockListContacts).toHaveBeenCalled();
    expect(sentAvatarCid()).toBe(AVATAR_CID);
  });

  it('«только контакты» — постороннему фотографии нет', async () => {
    mockVis.mockResolvedValue('contacts');
    await syncMyProfileTo(STRANGER);
    expect(sentAvatarCid()).toBeNull();
  });

  it('чтение переключателя не удалось — фотографии нет никому', async () => {
    mockVis.mockResolvedValue(null);
    await syncMyProfileTo(FRIEND);
    expect(sentAvatarCid()).toBeNull();
  });

  it('сбой чтения списка контактов трактуется как «не контакт»', async () => {
    mockVis.mockResolvedValue('contacts');
    mockContactsFail = true;
    await syncMyProfileTo(FRIEND);
    expect(sentAvatarCid()).toBeNull();
  });

  it('без кэша загрузки фотографии в конверте не появляется', async () => {
    mockKv.delete('7:profile:avatar_upload');
    mockVis.mockResolvedValue('everybody');
    await syncMyProfileTo(STRANGER);
    expect(sentAvatarCid()).toBeNull();
  });

  it('рассылка по контактам с «только контакты» несёт фотографию', async () => {
    mockVis.mockResolvedValue('contacts');
    mockContacts = [FRIEND, STRANGER];
    await broadcastMyProfile();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sentAvatarCid()).toBe(AVATAR_CID);
  });

  it('рассылка спрашивает переключатель один раз на всех адресатов', async () => {
    mockVis.mockResolvedValue('contacts');
    mockContacts = [FRIEND, STRANGER];
    await broadcastMyProfile();
    expect(mockVis).toHaveBeenCalledTimes(1);
  });

  it('рассылка с «никому» фотографию не несёт', async () => {
    mockVis.mockResolvedValue('nobody');
    mockContacts = [FRIEND];
    await broadcastMyProfile();
    expect(sentAvatarCid()).toBeNull();
  });

  it('переключатель спрашивают именно про этот профиль', async () => {
    mockVis.mockResolvedValue('everybody');
    await syncMyProfileTo(STRANGER);
    expect(mockVis).toHaveBeenCalledWith(7);
  });
});

describe('форма правки закреплена', () => {
  it('сборка конверта принимает положение параметром', () => {
    const build = slice(codeOnly(SYNC()), 'async function buildEnvelope(', '\n}');
    expect(build).toContain('visibility: AvatarVisibility | null,');
    expect(build).toContain('const shareAvatar = avatarAllowed(visibility, audience);');
  });

  it('внутри сборки конверта своего чтения больше нет', () => {
    const build = slice(codeOnly(SYNC()), 'async function buildEnvelope(', '\n}');
    expect(build).not.toContain('avatarVisibilityTryFor');
  });

  it('отправка одному читает один раз и несёт значение в сборку', () => {
    const one = slice(codeOnly(SYNC()), 'async function sendProfileTo(', '\n}');
    expect(one).toContain('const visibility = await avatarVisibilityTryFor(pid);');
    expect(one).toContain("visibility === 'contacts' && !(await isMyContact(pid, peerPubB64))");
    expect(one).toContain('await buildEnvelope(pid, audience, visibility)');
    expect(one.split('avatarVisibilityTryFor').length - 1).toBe(1);
  });

  it('рассылка читает на месте вызова и тоже один раз', () => {
    const all = slice(codeOnly(SYNC()), 'export async function broadcastMyProfile(', '\n}');
    expect(all).toContain("await buildEnvelope(pid, 'contacts', await avatarVisibilityTryFor(pid))");
    expect(all.split('avatarVisibilityTryFor').length - 1).toBe(1);
  });

  it('прежней двойной формы в исходнике не осталось', () => {
    const src = codeOnly(SYNC());
    expect(src).not.toContain('avatarAllowed(await avatarVisibilityTryFor(');
    expect(src).not.toContain("audience: Audience = 'contacts'");
    expect(src.split('avatarVisibilityTryFor').length - 1).toBe(3);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('разрешающее правило по-прежнему отказывает на null и «никому»', () => {
    const body = slice(SYNC(), 'function avatarAllowed(', '\nasync function buildEnvelope');
    expect(body).toContain("if (visibility === null || visibility === 'nobody') return false;");
    expect(body).toContain("if (visibility === 'contacts') return audience === 'contacts';");
  });

  it('чтение настройки по-прежнему умеет ответить «не прочитал»', () => {
    expect(VIS()).toContain('Promise<AvatarVisibility | null>');
    expect(VIS()).toContain('return read === null ? null : parseAvatarVisibility(read.value);');
  });

  it('сверка со списком контактов по-прежнему трактует сбой как «нет»', () => {
    const body = slice(SYNC(), 'async function isMyContact(', '\n}');
    expect(body).toContain("log.warn('profile_contact_check_failed'");
    expect(body).toContain('return false;');
  });

  it('досылка при открытии переписки по-прежнему не требует контакта', () => {
    const body = slice(SYNC(), 'export async function syncMyProfileTo(', '\n}');
    expect(body).toContain('await sendProfileTo(activeProfileId(), peerPubB64, false);');
  });

  it('исходники не выродились', () => {
    expect(SYNC().length).toBeGreaterThan(4000);
    expect(VIS().length).toBeGreaterThan(800);
  });
});
