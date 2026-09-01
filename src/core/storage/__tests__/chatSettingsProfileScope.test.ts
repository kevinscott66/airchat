/**
 * Оформление и настройки разговора принадлежат аккаунту (v4.32.487).
 *
 * Дефект. Фон чата, размер шрифта, автоперевод и пауза медленного режима
 * лежали в kv под именами, собранными из одного открытого ключа собеседника
 * (`chat_bg_<peer>`) или одного id группы (`chat_font_size_grp_<id>`), — без
 * номера профиля. Но собеседник у двух аккаунтов на телефоне бывает общий, а
 * в одной группе человек состоит двумя аккаунтами сразу. Следствия:
 *
 *  - фон, поставленный в одном аккаунте, показывался и во втором — по одному
 *    совпадению собеседника; то же с размером шрифта;
 *  - автоперевод, включённый в одном аккаунте, молча отдавал стороннему
 *    переводчику переписку второго — при том, что решение об облачном
 *    переводе с v4.32.486 своё у каждого профиля;
 *  - паузу медленного режима два участника группы делили на двоих: второй
 *    досиживал чужую;
 *  - уборка удалённого профиля сметает `p<id>:%` — под общие имена эти записи
 *    не подпадали и доставались следующему профилю с тем же номером.
 *
 * Рэтчет держит две вещи: изоляцию между профилями (поведение) и то, что имя
 * ключа набирается в одном месте (форма исходников) — разъехавшиеся копии
 * одного правила про имена уже стоили нам чужих заметок в соседнем профиле.
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
  chatAutoTranslateKey,
  chatBgKey,
  chatFontSizeKey,
  groupConvId,
  groupLastSentKey,
} from '../kvKeys';
import { scopedKvGet, scopedKvSet } from '../profileScopedKv';

const PEER = 'P'.repeat(43);
const GROUP = 'g-shared';

beforeEach(() => {
  mockKv.clear();
  mockActiveId = 1;
});

describe('имена ключей', () => {
  it('личный разговор зовётся открытым ключом собеседника', () => {
    expect(chatBgKey(PEER)).toBe(`chat_bg_${PEER}`);
    expect(chatFontSizeKey(PEER)).toBe(`chat_font_size_${PEER}`);
    expect(chatAutoTranslateKey(PEER)).toBe(`autotranslate_${PEER}`);
  });

  it('групповой разговор зовётся grp_<id> — тем же именем, что и до v4.32.487', () => {
    expect(groupConvId(GROUP)).toBe('grp_g-shared');
    expect(chatBgKey(groupConvId(GROUP))).toBe('chat_bg_grp_g-shared');
    expect(chatFontSizeKey(groupConvId(GROUP))).toBe('chat_font_size_grp_g-shared');
    expect(chatAutoTranslateKey(groupConvId(GROUP))).toBe('autotranslate_grp_g-shared');
    expect(groupLastSentKey(GROUP)).toBe('grp_last_sent_g-shared');
  });

  it('разные разговоры не сталкиваются именами', () => {
    expect(chatBgKey(PEER)).not.toBe(chatBgKey(groupConvId(GROUP)));
    expect(chatFontSizeKey(PEER)).not.toBe(chatAutoTranslateKey(PEER));
  });
});

describe('изоляция между аккаунтами', () => {
  it('фон, поставленный в одном аккаунте, не виден во втором', async () => {
    mockActiveId = 3;
    await scopedKvSet(chatBgKey(PEER), '{"type":"color","value":"#123456"}');
    mockActiveId = 5;
    expect(await scopedKvGet(chatBgKey(PEER))).toBeNull();
    mockActiveId = 3;
    expect(await scopedKvGet(chatBgKey(PEER))).toBe('{"type":"color","value":"#123456"}');
  });

  it('автоперевод включается только тому аккаунту, который его включил', async () => {
    mockActiveId = 3;
    await scopedKvSet(chatAutoTranslateKey(PEER), '1');
    mockActiveId = 5;
    expect(await scopedKvGet(chatAutoTranslateKey(PEER))).toBeNull();
  });

  it('размер шрифта в группе свой у каждого участника-аккаунта', async () => {
    const key = chatFontSizeKey(groupConvId(GROUP));
    mockActiveId = 3;
    await scopedKvSet(key, '20');
    mockActiveId = 5;
    await scopedKvSet(key, '13');
    mockActiveId = 3;
    expect(await scopedKvGet(key)).toBe('20');
  });

  it('пауза медленного режима не переносится на второй аккаунт', async () => {
    mockActiveId = 3;
    await scopedKvSet(groupLastSentKey(GROUP), '1700000000000');
    mockActiveId = 5;
    expect(await scopedKvGet(groupLastSentKey(GROUP))).toBeNull();
  });

  it('запись уходит в namespace профиля, а не под общее имя', async () => {
    mockActiveId = 7;
    await scopedKvSet(chatBgKey(PEER), 'x');
    expect(mockKv.get(`p7:${chatBgKey(PEER)}`)).toBe('x');
    expect(mockKv.has(chatBgKey(PEER))).toBe(false);
  });

  it('уборка удалённого профиля (p<id>:%) забирает эти записи', async () => {
    mockActiveId = 4;
    await scopedKvSet(chatBgKey(PEER), 'x');
    await scopedKvSet(chatFontSizeKey(PEER), '15');
    await scopedKvSet(chatAutoTranslateKey(groupConvId(GROUP)), '1');
    await scopedKvSet(groupLastSentKey(GROUP), '1');
    const left = [...mockKv.keys()].filter((k) => !k.startsWith('p4:'));
    expect(left).toEqual([]);
  });
});

describe('записи, сделанные до v4.32.487', () => {
  it('достаются первому профилю и переезжают в его namespace', async () => {
    mockKv.set(chatBgKey(PEER), '{"type":"color","value":"#abcdef"}');
    mockActiveId = 1;
    expect(await scopedKvGet(chatBgKey(PEER))).toBe('{"type":"color","value":"#abcdef"}');
    expect(mockKv.get(`p1:${chatBgKey(PEER)}`)).toBe('{"type":"color","value":"#abcdef"}');
    expect(mockKv.has(chatBgKey(PEER))).toBe(false);
  });

  it('второму профилю не достаются', async () => {
    mockKv.set(chatFontSizeKey(PEER), '20');
    mockActiveId = 2;
    expect(await scopedKvGet(chatFontSizeKey(PEER))).toBeNull();
    expect(mockKv.get(chatFontSizeKey(PEER))).toBe('20');
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
    expect(mentions('chat_bg_')).toEqual([]);
    expect(mentions('chat_font_size_')).toEqual([]);
    expect(mentions('autotranslate_')).toEqual([]);
    expect(mentions('grp_last_sent_')).toEqual([]);
  });

  it('экраны читают и пишут их через profileScopedKv', () => {
    for (const rel of [
      'ui/screens/ChatScreen.tsx',
      'ui/screens/GroupsScreen.tsx',
      'ui/components/modals/chat/ChatWallpaperPickerModal.tsx',
    ]) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(src).toContain('storage/profileScopedKv');
      expect(src).toContain('storage/kvKeys');
    }
  });
});
