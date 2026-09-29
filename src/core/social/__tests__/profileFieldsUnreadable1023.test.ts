/**
 * Нечитаемая ячейка карточки уезжала контактам как «поля нет» (v4.32.1023).
 *
 * ДЕФЕКТ. Конверт профиля собирается восемью отдельными чтениями: имя, @имя,
 * «О себе», местоимения, статус, имя файла фотографии, привязки, бумага на
 * галочку. Каждое шло через `ownFieldGetFor`, а та сводит «записи нет» и
 * «запись не открылась» к одному `null` — различающая форма рядом есть
 * (`ownFieldTryGetFor`, v4.32.705), и в её же пояснении сказано, что конверт
 * собирается из этих чтений. Отказ одной ячейки становился в конверте пустым
 * полем.
 *
 * ЦЕНА. Пустое поле в конверте — это не «не знаем», а «стёрто»: получатель
 * пишет `peerName: profile.name ?? ''`, `bio: …?? ''`, `avatarCid: …?? ''`
 * (contacts, setPeerProfileForChecked). То есть один отказ SQLite или
 * Keychain — и человек у ВСЕХ своих контактов остаётся без имени, без
 * фотографии и без «О себе». Отметка `profileTs` при этом уезжает вперёд, а
 * свёртка версии ложится в карту «эту версию он видел». Отменить нечем:
 * карточка — единственное, чем человек представлен собеседнику.
 *
 * Ячейки читаются по одной, разными запросами: занята база на одном запросе из
 * восьми — остальные семь отвечают, и конверт уходит непустым. Рассылку зовут
 * на запуске приложения и из фона (см. ownBadge про фоновую рассылку) — то
 * есть в занятую секунду и при запертом устройстве.
 *
 * ПРАВКА. Все восемь чтений спрашивают различающей формой, и нечитаемая ячейка
 * даёт исход `'unreadable'` — тот самый, что завела здесь v4.32.960 для
 * отметки версии. Рассылка молча пропускает заход, точечная досылка отвечает
 * `failed`, просьба о карточке остаётся неотвеченной.
 *
 * ГРАНИЦЫ. Незаполненное поле — по-прежнему пустое поле: стёртое имя обязано
 * стереться и у собеседника, иначе правка ломает удаление. Совсем пустой
 * профиль по-прежнему тихо пропускается.
 */

/** Содержимое ячеек карточки: логический ключ → строка. */
let mockCells: Record<string, string> = {};
/** Логические ключи, чтение которых отказывает. */
let mockCellFail = new Set<string>();

/** Ключ без префикса профиля: `p7:user_username` → `user_username`. */
const bare = (key: string): string => key.replace(/^p\d+:/, '');

const cellFor = (key: string) => {
  const k = bare(key);
  if (mockCellFail.has(k)) return { state: 'unreadable' as const };
  return k in mockCells
    ? { state: 'plain' as const, text: mockCells[k] }
    : { state: 'absent' as const };
};

jest.mock('../../storage/local', () => ({
  kvGetSecretCellUpgrading: async (key: string) => cellFor(key),
  kvGetSecretCell: async (key: string) => cellFor(key),
  kvSetSecret: async () => true,
  kvSetSecretScoped: async () => true,
  kvDelete: async () => undefined,
  kvGet: async () => null,
  kvSet: async () => undefined,
}));

/** Значения профильного kv рассылки (отметка версии, карта отправленного). */
let mockKv: Record<string, string> = {};

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (_pid: number, key: string) => ({ value: mockKv[key] ?? null }),
  scopedKvGetFor: async (_pid: number, key: string) => mockKv[key] ?? null,
  scopedKvSetCheckedFor: async (_pid: number, key: string, value: string) => {
    mockKv[key] = value;
    return true;
  },
  scopedKvSetFor: async (_pid: number, key: string, value: string) => { mockKv[key] = value; },
  scopedKvSet: async (key: string, value: string) => { mockKv[key] = value; },
  scopedKvTryGetSecretFor: async (_pid: number, key: string) => ({ value: mockKv[key] ?? null }),
  scopedKvSetSecretCheckedFor: async (_pid: number, key: string, value: string) => {
    mockKv[key] = value;
    return true;
  },
}));

/** Что и кому ушло: сам текст конверта нужен, чтобы увидеть стёртое поле. */
let mockSent: { peer: string; text: string }[] = [];

jest.mock('../messaging', () => ({
  getMessagingService: () => ({
    sendMessage: async (peer: string, text: string) => {
      mockSent.push({ peer, text });
      return 'cid1';
    },
  }),
}));

let mockContacts: { peerPublicKey: string }[] = [];
jest.mock('../contacts', () => ({
  listContactsFor: async () => mockContacts,
  setPeerProfileForChecked: async () => 'applied',
  isMyContact: async () => true,
}));

jest.mock('../sendGate', () => ({ canReachPeer: async () => true }));
jest.mock('../../settings/avatarVisibility', () => ({ avatarVisibilityTryFor: async () => 'all' }));
jest.mock('../publicAvatar', () => ({ publishOwnAvatarToDirectory: async () => undefined }));
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 7 }),
    getProfileName: () => '',
    getAllProfiles: () => [{ id: 7, did: 'did:key:zOwner' }],
  },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { broadcastMyProfile, handleIncomingProfileRequest } from '../profileSync';

const PEER = 'P'.repeat(43);
const STAMP_KEY = 'profile:changed_at';
const REAL_STAMP = 1_700_000_000_000;

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const here = (...p: string[]): string => join(__dirname, '..', '..', ...p);
const SYNC = codeOnly(readFileSync(here('social', 'profileSync.ts'), 'utf8'));
const CONTACTS = codeOnly(readFileSync(here('social', 'contacts.ts'), 'utf8'));
const OWN = codeOnly(readFileSync(here('identity', 'ownProfile.ts'), 'utf8'));

/** Разобранный конверт последней отправки. */
const lastEnvelope = (): Record<string, unknown> =>
  JSON.parse(mockSent[mockSent.length - 1].text.replace(/^[^{]*/, '')) as Record<string, unknown>;

beforeEach(() => {
  mockCells = { user_username: 'Аня', user_bio: 'Пишу про сети' };
  mockCellFail = new Set();
  mockKv = { [STAMP_KEY]: String(REAL_STAMP) };
  mockSent = [];
  mockContacts = [{ peerPublicKey: PEER }];
});

describe('нечитаемая ячейка — это не стёртое поле', () => {
  it('имя не прочиталось — карточка без имени никому не уезжает', async () => {
    mockCellFail.add('user_username');

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('«О себе» не прочиталось — молчим: пустое поле значило бы «стёрто»', async () => {
    mockCellFail.add('user_bio');

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('имя файла фотографии не прочиталось — фотография не пропадает у контактов', async () => {
    mockCells.user_avatar_uri = 'a1.jpg';
    mockCellFail.add('user_avatar_uri');

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('бумага на галочку не прочиталась — галочка не снимается у контактов', async () => {
    mockCells.user_verify_grant = 'grant-abc';
    mockCellFail.add('user_verify_grant');

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('просьба о карточке остаётся неотвеченной, а не отвеченной пустотой', async () => {
    mockCellFail.add('user_username');
    const { encodeProfileRequest } = await import('../profileEnvelope');

    await expect(handleIncomingProfileRequest(encodeProfileRequest(), PEER, 7))
      .resolves.toBe('deferred');
    expect(mockSent).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная карточка уезжает как прежде', () => {
  it('все ячейки на месте — конверт уходит и несёт имя с «О себе»', async () => {
    await broadcastMyProfile();

    expect(mockSent.map((s) => s.peer)).toEqual([PEER]);
    expect(lastEnvelope()).toMatchObject({ name: 'Аня', bio: 'Пишу про сети' });
  });

  it('ГРАНИЦА: незаполненное поле остаётся пустым — стёртое обязано стереться', async () => {
    delete mockCells.user_bio;

    await broadcastMyProfile();

    expect(mockSent.map((s) => s.peer)).toEqual([PEER]);
    expect(lastEnvelope()).toMatchObject({ name: 'Аня', bio: null });
  });

  it('ГРАНИЦА: совсем пустой профиль по-прежнему тихо пропускается', async () => {
    mockCells = {};

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });

  it('ГРАНИЦА: вторая рассылка той же версии молчит — круга рассылки нет', async () => {
    await broadcastMyProfile();
    mockSent = [];

    await broadcastMyProfile();

    expect(mockSent).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('получатель записывает пустое поле поверх своего: «нет значения» = «стёрто»', () => {
    const at = CONTACTS.indexOf('export async function setPeerProfileForChecked(');
    expect(at).toBeGreaterThan(0);
    const body = CONTACTS.slice(at, CONTACTS.indexOf('\nexport async function renameContact(', at));
    expect(body).toContain("peerName: profile.name ?? ''");
    expect(body).toContain("bio: profile.bio ?? ''");
    expect(body).toContain("avatarCid: profile.avatarCid ?? ''");
    expect(body).toContain('profileTs: profile.ts');
  });

  it('различающая форма чтения поля в карточке есть и отвечает «не прочитали»', () => {
    const at = OWN.indexOf('export async function ownFieldTryGetFor(');
    expect(at).toBeGreaterThan(0);
    expect(OWN.slice(at, at + 900)).toContain("if (own.state === 'unreadable') return null;");
  });

  it('исход «не прочитали» у рассылки уже заведён — им и пользуемся', () => {
    expect(SYNC).toContain("if (built === 'empty') return 'skipped';");
    expect(SYNC).toContain("if (built === 'unreadable') return 'failed';");
  });
});

describe('ЗАКРЕПКА: сборка конверта не спрашивает поля сводящей формой', () => {
  it('buildEnvelope читает только различающими формами', () => {
    const at = SYNC.indexOf('async function buildEnvelope(');
    expect(at).toBeGreaterThan(0);
    const body = SYNC.slice(at, SYNC.indexOf('\nexport async function markProfileChanged(', at));
    expect(body).not.toContain('ownFieldGetFor(');
    expect(body).not.toContain('getOwnDisplayNameFor(');
    expect(body).not.toContain('getOwnUsernameFor(');
    expect(body).not.toContain('ownAvatarNameFor(');
    expect(body).not.toContain('ownLinksFor(');
    expect(body).not.toContain('ownBadgeGrantFor(');
  });
});
