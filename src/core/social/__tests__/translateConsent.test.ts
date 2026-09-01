/**
 * Согласие на облачный перевод: одно, своё у каждого аккаунта и достижимое
 * (v4.32.486).
 *
 * Проверка «включён ли облачный перевод» стояла в четырёх местах переписки и
 * читала запись `allow_cloud_translate`, которую НИКТО никогда не записывал:
 * переключателя, на который ссылались и комментарии, и текст ошибки, в
 * настройках не было. Перевод в переписке поэтому не работал вовсе, а человеку
 * предлагалось включить его там, где включать нечего.
 *
 * В ленте при этом действовало второе согласие (`feed_translate_consent`) —
 * диалог на один тап, после которого текст публикации уходил тому же сервису.
 * Одно и то же действие с одного экрана разрешалось одним тапом, с другого —
 * не разрешалось никак.
 *
 * Обе записи были общими на устройство. Аккаунт, заведённый ради того, чтобы
 * его переписка никуда не уходила, наследовал бы чужое согласие, ни разу его
 * не дав, — и уборка удалённого профиля (`p<id>:%`) обе записи пропускала.
 */

const mockKv = new Map<string, string>();
let mockReadFails = false;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockReadFails ? null : { value: mockKv.get(k) ?? null }),
  kvGet: async (k: string) => mockKv.get(k) ?? null,
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
}));

let mockActivePid = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: mockActivePid, name: 'П', did: `did:key:z${mockActivePid}` }),
    getAllProfiles: () => [
      { id: 1, name: 'Личный', did: 'did:key:z1' },
      { id: 2, name: 'Рабочий', did: 'did:key:z2' },
    ],
  },
}));
jest.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  CLOUD_TRANSLATE_KEY,
  CLOUD_TRANSLATE_OFF_MESSAGE,
  cloudTranslateAllowed,
  cloudTranslateAllowedFor,
  setCloudTranslateAllowed,
} from '../translateConsent';
import { PRIVACY_PREF_KEYS } from '../../storage/kvKeys';

const SRC = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Файлы, где встречается строка, кроме её единственного дома. */
function mentions(needle: string, home: string): string[] {
  return walk(SRC)
    .filter((f) => !f.endsWith(home))
    .filter((f) => readFileSync(f, 'utf8').includes(needle))
    .map((f) => f.slice(SRC.length + 1));
}

beforeEach(() => {
  mockKv.clear();
  mockReadFails = false;
  mockActivePid = 1;
});

describe('решение по умолчанию', () => {
  it('выключено — текст не уходит наружу, пока не разрешили', async () => {
    expect(await cloudTranslateAllowed()).toBe(false);
  });

  it('база не ответила — считаем, что нельзя', async () => {
    await setCloudTranslateAllowed(true);
    mockReadFails = true;
    expect(await cloudTranslateAllowed()).toBe(false);
  });

  it('прежнее общее имя разрешения не даёт', async () => {
    mockKv.set('allow_cloud_translate', 'true');
    expect(await cloudTranslateAllowed()).toBe(false);
  });

  it('прежнее согласие ленты не расширяется на переписку', async () => {
    mockKv.set('feed_translate_consent', '1');
    expect(await cloudTranslateAllowed()).toBe(false);
  });
});

describe('своё у каждого аккаунта', () => {
  it('записывается в namespace профиля, а не под общим именем', async () => {
    mockActivePid = 2;
    await setCloudTranslateAllowed(true);
    expect(mockKv.get(`p2:${CLOUD_TRANSLATE_KEY}`)).toBe('true');
    expect(mockKv.has(CLOUD_TRANSLATE_KEY)).toBe(false);
  });

  it('согласие одного аккаунта не разрешает перевод другому', async () => {
    mockActivePid = 1;
    await setCloudTranslateAllowed(true);
    mockActivePid = 2;
    expect(await cloudTranslateAllowed()).toBe(false);
    expect(await cloudTranslateAllowedFor(1)).toBe(true);
  });

  it('выключение возвращает запрет', async () => {
    await setCloudTranslateAllowed(true);
    await setCloudTranslateAllowed(false);
    expect(await cloudTranslateAllowed()).toBe(false);
  });

  it('уборка удалённого профиля знает про это имя', () => {
    expect(PRIVACY_PREF_KEYS).toContain(CLOUD_TRANSLATE_KEY);
  });
});

describe('одно решение на всё приложение', () => {
  it('прежние имена не читает больше никто', () => {
    // В кавычках: `privacy_allow_cloud_translate` содержит прежнее имя как
    // подстроку, а упоминание в пояснении — не чтение.
    expect(mentions("'allow_cloud_translate'", 'core/social/translateConsent.ts')).toEqual([]);
    expect(mentions("'feed_translate_consent'", 'core/social/translateConsent.ts')).toEqual([]);
  });

  it('все места перевода спрашивают один и тот же модуль', () => {
    for (const f of ['ui/screens/ChatScreen.tsx', 'ui/screens/GroupsScreen.tsx', 'ui/screens/FeedScreen.tsx']) {
      const s = readFileSync(join(SRC, f), 'utf8');
      expect(s).toContain("from '../../core/social/translateConsent'");
      expect(s).toContain('await cloudTranslateAllowed()');
    }
  });

  it('в переписке проверок ровно четыре — авто и вручную, лично и в группе', () => {
    const chat = readFileSync(join(SRC, 'ui/screens/ChatScreen.tsx'), 'utf8');
    const grp = readFileSync(join(SRC, 'ui/screens/GroupsScreen.tsx'), 'utf8');
    expect((chat.match(/await cloudTranslateAllowed\(\)/g) ?? []).length).toBe(2);
    expect((grp.match(/await cloudTranslateAllowed\(\)/g) ?? []).length).toBe(2);
  });

  it('отказ звучит одинаково и называет, где включить', () => {
    expect(CLOUD_TRANSLATE_OFF_MESSAGE).toContain('Настройки');
    expect(CLOUD_TRANSLATE_OFF_MESSAGE).toContain('Приватность');
    expect(mentions('Облачный перевод выключен', 'core/social/translateConsent.ts')).toEqual([]);
  });
});

describe('переключатель существует', () => {
  it('настройки его показывают и записывают', () => {
    const s = readFileSync(join(SRC, 'ui/screens/SettingsScreen.tsx'), 'utf8');
    expect(s).toContain('<Text style={styles.label}>Облачный перевод</Text>');
    expect(s).toContain('void setCloudTranslateAllowed(v);');
    expect(s).toContain('cloudTranslateAllowed(),');
  });

  it('диалог в ленте включает то же самое решение', () => {
    const s = readFileSync(join(SRC, 'ui/screens/FeedScreen.tsx'), 'utf8');
    expect(s).toContain('await setCloudTranslateAllowed(true);');
  });

  it('текст диалога говорит, что согласие можно отозвать', () => {
    const ru = JSON.parse(readFileSync(join(SRC, 'i18n/ru.json'), 'utf8')) as {
      feed: { translateConfirmMsg: string };
    };
    expect(ru.feed.translateConfirmMsg).toContain('api.mymemory.translated.net');
    expect(ru.feed.translateConfirmMsg).toContain('Приватность');
  });
});
