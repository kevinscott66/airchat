/**
 * Имя, которым человек представляется группе, — имя ВЛАДЕЛЬЦА конверта.
 *
 * v4.32.478. Групповые конверты подписываются ключом того профиля, кому
 * сообщение адресовано (`rcpt.myPub`), а имя рядом с подписью бралось у
 * профиля, открытого на экране. У человека с двумя аккаунтами приём идёт в
 * фоне: пока открыт рабочий аккаунт, личный отвечал группе рабочим именем — и
 * уходило это не в свою базу, а участникам, по сети.
 */
jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const kvSetSecret = jest.fn(async (key: string, value: string) => { kv[key] = PREFIX + value; return true; });
  return {
    __kv: kv,
    kvGet: jest.fn(async (key: string) => kv[key] ?? null),
    kvSet: jest.fn(async (key: string, value: string) => { kv[key] = value; }),
    kvDelete: jest.fn(async (key: string) => { delete kv[key]; }),
    kvGetSecret: jest.fn(async (key: string) => {
      const stored = kv[key];
      if (stored == null) return null;
      return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
    }),
    kvSetSecret,
    kvGetSecretUpgrading: jest.fn(async (key: string) => {
      const stored = kv[key];
      if (stored == null) return null;
      return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
    }),
    kvSetSecretScoped: jest.fn(async (profileId: number, key: string, value: string) =>
      kvSetSecret(`p${profileId}:${key}`, value)),
  };
});

let mockActiveProfile: { id: number; name: string } | null = { id: 1, name: 'Личный' };
let mockProfiles: { id: number; name: string }[] = [];
jest.mock('../profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockActiveProfile,
    getProfileName: (pid: number) =>
      mockProfiles.find((row) => row.id === pid)?.name
      ?? (mockActiveProfile?.id === pid ? mockActiveProfile.name : null),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  OWN_DISPLAY_NAME_KEY,
  getOwnDisplayName,
  getOwnDisplayNameFor,
  ownFieldGet,
  ownFieldGetFor,
  ownFieldSet,
} from '../ownProfile';

const mockLocal = jest.requireMock('../../storage/local') as { __kv: Record<string, string> };

const groupSrc = readFileSync(join(__dirname, '..', '..', 'social', 'groupMessaging.ts'), 'utf8');
const ownSrc = readFileSync(join(__dirname, '..', 'ownProfile.ts'), 'utf8');
const managerSrc = readFileSync(join(__dirname, '..', 'profileManager.ts'), 'utf8');

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockActiveProfile = { id: 1, name: 'Личный' };
  mockProfiles = [];
});

describe('имя берётся у заданного профиля, а не у открытого на экране', () => {
  it('фоновый профиль представляется своим именем при другом активном', async () => {
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, 'Аня');
    mockActiveProfile = { id: 2, name: 'Рабочий' };
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, 'Анна Петровна');
    // Открыт второй, конверт адресован первому.
    expect(await getOwnDisplayNameFor(1)).toBe('Аня');
    expect(await getOwnDisplayName()).toBe('Анна Петровна');
  });

  it('без своей карточки подставляется имя, под которым завели ИМЕННО этот профиль', async () => {
    mockActiveProfile = { id: 2, name: 'Рабочий' };
    mockProfiles = [{ id: 1, name: 'Личный' }, { id: 2, name: 'Рабочий' }];
    expect(await getOwnDisplayNameFor(1)).toBe('Личный');
  });

  it('null, когда у профиля нет ни карточки, ни записи в списке', async () => {
    mockActiveProfile = { id: 2, name: 'Рабочий' };
    expect(await getOwnDisplayNameFor(7)).toBeNull();
  });

  it('имя чистится так же, как у активного профиля', async () => {
    mockActiveProfile = { id: 3, name: 'Третий' };
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, '‮Аня​');
    mockActiveProfile = { id: 1, name: 'Личный' };
    expect(await getOwnDisplayNameFor(3)).toBe('Аня');
  });

  it('обычный вызов — это тот же вызов для активного профиля', async () => {
    mockActiveProfile = { id: 4, name: 'Четвёртый' };
    await ownFieldSet(OWN_DISPLAY_NAME_KEY, 'Кто-то');
    expect(await getOwnDisplayName()).toBe(await getOwnDisplayNameFor(4));
  });
});

describe('карточка целиком читается по номеру профиля', () => {
  it('поле второго профиля не подменяется полем первого', async () => {
    await ownFieldSet('user_bio', 'первый');
    mockActiveProfile = { id: 2, name: 'Второй' };
    await ownFieldSet('user_bio', 'второй');
    expect(await ownFieldGetFor(1, 'user_bio')).toBe('первый');
    expect(await ownFieldGetFor(2, 'user_bio')).toBe('второй');
  });

  it('обычное чтение равно чтению активного профиля', async () => {
    mockActiveProfile = { id: 2, name: 'Второй' };
    await ownFieldSet('user_bio', 'второй');
    expect(await ownFieldGet('user_bio')).toBe(await ownFieldGetFor(2, 'user_bio'));
  });

  it('запись до разделения по профилям достаётся только первому', async () => {
    mockLocal.__kv['user_avatar_uri'] = 'file:///старый.jpg';
    expect(await ownFieldGetFor(1, 'user_avatar_uri')).toBe('file:///старый.jpg');
    expect(await ownFieldGetFor(2, 'user_avatar_uri')).toBeNull();
  });
});

describe('приём группового конверта не спрашивает активный профиль', () => {
  it('groupMessaging больше не зовёт версию без номера профиля', () => {
    expect(groupSrc).not.toMatch(/await getOwnDisplayName\(\)/);
    expect(groupSrc).toContain("import { getOwnDisplayNameFor } from '../identity/ownProfile';");
  });

  it('все пять мест приёма спрашивают имя владельца', () => {
    const calls = groupSrc.match(/await getOwnDisplayNameFor\(pid\)/g) ?? [];
    expect(calls).toHaveLength(5);
  });

  it('имя и ключ в ответах берутся у одного профиля', () => {
    // rcpt.myPub — ключ владельца; pid = rcpt.pid — его же номер.
    expect(groupSrc).toContain('const pid = rcpt.pid;');
    for (const pub of ['myPubRv', 'myPubQ', 'myPubAdd']) {
      expect(groupSrc).toContain(pub);
    }
  });
});

describe('источник имени — состояние, а не вывод ключей', () => {
  it('getProfileName не трогает getAllProfiles', () => {
    const body = managerSrc.slice(managerSrc.indexOf('getProfileName('), managerSrc.indexOf('getAllProfiles('));
    expect(body).toContain('this.state?.profiles.find');
    expect(body).not.toContain('getAllProfiles');
  });

  it('запасное имя берётся у заданного профиля, а не у активного', () => {
    const body = ownSrc.slice(ownSrc.indexOf('export async function getOwnDisplayNameFor('));
    expect(body).toContain('profileManager.getProfileName(pid)');
    expect(body).not.toContain('getActiveProfile()?.name');
  });

  it('версия без номера профиля не дублирует логику, а делегирует', () => {
    expect(ownSrc).toContain('return await getOwnDisplayNameFor(activeProfileId());');
    expect(ownSrc).toContain('return await ownFieldGetFor(activeProfileId(), key);');
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны', () => {
    expect(groupSrc.length).toBeGreaterThan(1000);
    expect(ownSrc.length).toBeGreaterThan(1000);
    expect(managerSrc.length).toBeGreaterThan(1000);
  });
});
