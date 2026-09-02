/**
 * Недавние реакции, эмодзи и язык перевода принадлежат аккаунту (v4.32.561).
 *
 * Дефект. Три записи kv жили под общими именами — `recent_reactions`,
 * `recent_emojis_panel`, `translation_target_lang`, — хотя каждая из них след
 * КОНКРЕТНОГО человека, а не телефона. Пока разговоры (v4.32.487) и решения о
 * приватности (v4.32.311) уезжали в namespace профиля, эти три остались, и
 * поэтому на одном устройстве:
 *
 *  - панель реакций открывалась во втором аккаунте с реакциями первого —
 *    восемь последних, первой же строкой, без единого действия;
 *  - панель эмодзи показывала двадцать четыре последних символа соседа, а по
 *    ним видно, о чём человек вообще переписывается;
 *  - язык перевода выбирался в настройках каждым аккаунтом отдельно, но
 *    запись была одна: второй профиль молча получал чужой выбор, а свой
 *    сохранить не мог — он перебивал чужой.
 *
 * И то же, что со всеми общими именами: уборка удалённого профиля идёт по
 * `p<id>:%`, под неё эти записи не подпадали и доставались следующему
 * аккаунту с тем же номером.
 *
 * Рэтчет держит и поведение (изоляция, наследование первым профилем, уборка),
 * и форму исходников: имена набираются только в kvKeys, экраны читают их
 * через profileScopedKv, а удаление профиля перечисляет их по списку.
 */
const mockKv = new Map<string, string>();
let mockActiveId = 1;

jest.mock('../local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvDelete: async (k: string) => { mockKv.delete(k); },
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  OWN_PROFILE_KEYS,
  PER_PROFILE_UI_KEYS,
  PRIVACY_PREF_KEYS,
  RECENT_EMOJIS_PANEL_KEY,
  RECENT_REACTIONS_KEY,
  TRANSLATION_TARGET_LANG_KEY,
  hasProfilePrefix,
  profileScopedKey,
} from '../kvKeys';
import { scopedKvGet, scopedKvSet } from '../profileScopedKv';

beforeEach(() => {
  mockKv.clear();
  mockActiveId = 1;
});

describe('имена ключей', () => {
  it('остались прежними — миграция читает старую запись по старому имени', () => {
    expect(RECENT_REACTIONS_KEY).toBe('recent_reactions');
    expect(RECENT_EMOJIS_PANEL_KEY).toBe('recent_emojis_panel');
    expect(TRANSLATION_TARGET_LANG_KEY).toBe('translation_target_lang');
  });

  it('список перечисляет все три и ничего сверх того', () => {
    expect([...PER_PROFILE_UI_KEYS].sort()).toEqual(
      [RECENT_EMOJIS_PANEL_KEY, RECENT_REACTIONS_KEY, TRANSLATION_TARGET_LANG_KEY].sort(),
    );
  });

  it('ни одно имя не пересекается с другими списками уборки', () => {
    const others = new Set<string>([...OWN_PROFILE_KEYS, ...PRIVACY_PREF_KEYS]);
    for (const k of PER_PROFILE_UI_KEYS) expect(others.has(k)).toBe(false);
  });

  it('в списке лежат логические имена, без префикса профиля', () => {
    for (const k of PER_PROFILE_UI_KEYS) expect(hasProfilePrefix(k)).toBe(false);
  });
});

describe('изоляция между аккаунтами', () => {
  it('недавние реакции одного аккаунта не видны второму', async () => {
    mockActiveId = 3;
    await scopedKvSet(RECENT_REACTIONS_KEY, '["🍑","🔥"]');
    mockActiveId = 5;
    expect(await scopedKvGet(RECENT_REACTIONS_KEY)).toBeNull();
    mockActiveId = 3;
    expect(await scopedKvGet(RECENT_REACTIONS_KEY)).toBe('["🍑","🔥"]');
  });

  it('недавние эмодзи панели тоже свои у каждого', async () => {
    mockActiveId = 3;
    await scopedKvSet(RECENT_EMOJIS_PANEL_KEY, '["😀"]');
    mockActiveId = 5;
    expect(await scopedKvGet(RECENT_EMOJIS_PANEL_KEY)).toBeNull();
  });

  it('язык перевода второго аккаунта не перебивает язык первого', async () => {
    mockActiveId = 3;
    await scopedKvSet(TRANSLATION_TARGET_LANG_KEY, 'ru');
    mockActiveId = 5;
    await scopedKvSet(TRANSLATION_TARGET_LANG_KEY, 'tr');
    mockActiveId = 3;
    expect(await scopedKvGet(TRANSLATION_TARGET_LANG_KEY)).toBe('ru');
    mockActiveId = 5;
    expect(await scopedKvGet(TRANSLATION_TARGET_LANG_KEY)).toBe('tr');
  });

  it('запись уходит в namespace профиля, а не под общее имя', async () => {
    mockActiveId = 7;
    await scopedKvSet(RECENT_REACTIONS_KEY, '["👍"]');
    expect(mockKv.get(profileScopedKey(7, RECENT_REACTIONS_KEY))).toBe('["👍"]');
    expect(mockKv.has(RECENT_REACTIONS_KEY)).toBe(false);
  });

  it('уборка удалённого профиля (p<id>:%) забирает все три', async () => {
    mockActiveId = 4;
    for (const k of PER_PROFILE_UI_KEYS) await scopedKvSet(k, 'x');
    expect([...mockKv.keys()].filter((k) => !k.startsWith('p4:'))).toEqual([]);
  });
});

describe('записи, сделанные до v4.32.561', () => {
  it('достаются первому профилю и переезжают в его namespace', async () => {
    mockKv.set(TRANSLATION_TARGET_LANG_KEY, 'de');
    mockActiveId = 1;
    expect(await scopedKvGet(TRANSLATION_TARGET_LANG_KEY)).toBe('de');
    expect(mockKv.get(profileScopedKey(1, TRANSLATION_TARGET_LANG_KEY))).toBe('de');
    expect(mockKv.has(TRANSLATION_TARGET_LANG_KEY)).toBe(false);
  });

  it('второму профилю не достаются — и не стираются у первого', async () => {
    mockKv.set(RECENT_REACTIONS_KEY, '["🍑"]');
    mockActiveId = 2;
    expect(await scopedKvGet(RECENT_REACTIONS_KEY)).toBeNull();
    expect(mockKv.get(RECENT_REACTIONS_KEY)).toBe('["🍑"]');
  });
});

/** Все .ts/.tsx под src — чтобы проверять форму исходников целиком. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const SRC = path.resolve(__dirname, '../../..');
const HOME = path.join(SRC, 'core/storage/kvKeys.ts');

function mentions(needle: string): string[] {
  return walk(SRC)
    .filter((f) => f !== HOME && !f.includes('__tests__'))
    .filter((f) => fs.readFileSync(f, 'utf8').includes(needle))
    .map((f) => path.relative(SRC, f));
}

describe('форма исходников', () => {
  it('имена этих ключей набираются только в kvKeys', () => {
    expect(mentions(RECENT_REACTIONS_KEY)).toEqual([]);
    expect(mentions(RECENT_EMOJIS_PANEL_KEY)).toEqual([]);
    expect(mentions(TRANSLATION_TARGET_LANG_KEY)).toEqual([]);
  });

  it('все четыре экрана читают их через profileScopedKv', () => {
    for (const rel of [
      'ui/screens/ChatScreen.tsx',
      'ui/screens/GroupsScreen.tsx',
      'ui/screens/FeedScreen.tsx',
      'ui/screens/SettingsScreen.tsx',
    ]) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(src).toContain('storage/profileScopedKv');
      expect(src).toContain('storage/kvKeys');
    }
  });

  it('удаление профиля перечисляет их по списку, а не поимённо', () => {
    const local = fs.readFileSync(path.join(SRC, 'core/storage/local.ts'), 'utf8');
    expect(local).toContain('...LEGACY_GLOBAL_SYNC_KEYS, ...PER_PROFILE_UI_KEYS]');
  });

  it('панель эмодзи и реакции больше не тянут kv динамическим импортом', () => {
    const chat = fs.readFileSync(path.join(SRC, 'ui/screens/ChatScreen.tsx'), 'utf8');
    // v4.32.534: сама панель уехала в chat-components/EmojiPanel.tsx — её
    // открывают оба экрана, и держать её в одном из них было незачем. Правило
    // то же: свои записи она читает через namespace профиля.
    const panel = fs.readFileSync(path.join(SRC, 'ui/screens/chat-components/EmojiPanel.tsx'), 'utf8');
    // Общий kvGet/kvSet в этом экране не нужен вовсе: всё, что он читал, — эти
    // три записи, и каждая теперь идёт через namespace профиля.
    for (const src of [chat, panel]) {
      expect(src).not.toMatch(/\{\s*kvGet:\s*kg/);
      expect(src).not.toContain("m.kvGet('");
      expect(src).not.toContain("m.kvSet('");
    }
    expect(panel).toContain('void scopedKvGet(RECENT_EMOJIS_PANEL_KEY).then(');
    expect(chat).toContain('await scopedKvSet(RECENT_REACTIONS_KEY, JSON.stringify(list));');
  });
});
