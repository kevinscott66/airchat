/**
 * Переписки, которые не прочитались, — не отсутствие переписок (v4.32.650).
 *
 * `listConversations` отвечала пустым списком и на «диалогов нет», и на отказ
 * базы. Экран списка на этом рисовал «Нет переписок» с подсказкой «вставьте ID
 * собеседника» — человеку с целой историей на диске это читается как «всё
 * пропало»; заодно пропадала строка архива, а все контакты снова вставали в
 * список как «контакт без переписки». В переписке та же пустота стирала
 * черновик: поле ввода пустое, первая же отложенная запись затирала столбец.
 *
 * Поведение правила проверяется вызовами, проводка — по форме исходников:
 * поднять здесь настоящий экран нечем (react-test-renderer в проекте нет).
 */
import fs from 'fs';
import path from 'path';

import { decideDraftWrite } from '../../../core/social/draftGuard';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const LOCAL = () => read('core', 'storage', 'local.ts');
const TEXTS = () => read('core', 'storage', 'unreadableText.ts');
const CHAT_LIST = () => read('ui', 'screens', 'ChatListScreen.tsx');
const CHAT = () => read('ui', 'screens', 'ChatScreen.tsx');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Строки исходника без комментариев: собственная поясняющая цитата не должна ловиться. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('хранилище: три исхода чтения списка переписок', () => {
  it('оба списка читаются одним телом, а не двумя копиями', () => {
    const src = LOCAL();
    // Одно объявление и ровно два вызова: открытый список и архивный.
    expect((src.match(/readConversationRows\(/g) ?? []).length).toBe(3);
    expect(src).toContain('async function readConversationRows(');
    expect(src).toContain("const OPEN_CONV_ORDER = 'pinned DESC, last_message_at DESC';");
    expect(src).toContain("const ARCHIVED_CONV_ORDER = 'last_message_at DESC';");
  });

  it('исход берётся у общего правила readResult.ts, а не объявляется свой', () => {
    expect(LOCAL()).toContain('Promise<DbRead<ConversationRow>>');
  });

  it('обе метки в журнале сохранены: сбой различим по списку', () => {
    const src = LOCAL();
    expect(src).toContain("'conversations_list_failed'");
    expect(src).toContain("'conversations_archived_failed'");
  });

  it('пустой список сводится только в старых обёртках, а третий исход отдают новые', () => {
    const src = LOCAL();
    expect(slice(src, 'export async function listConversations(', '\n}\n'))
      .toContain('(await listConversationsRead(ownerProfileId)) ?? []');
    expect(slice(src, 'export async function listArchivedConversations(', '\n}\n'))
      .toContain('(await listArchivedConversationsRead(ownerProfileId)) ?? []');
    expect(slice(src, 'export async function listConversationsRead(', '\n}\n'))
      .toContain('read?.slice() ?? null');
    expect(slice(src, 'export async function listArchivedConversationsRead(', '\n}\n'))
      .toContain('read?.slice() ?? null');
  });
});

describe('пометка про непрочитанные переписки', () => {
  it('своя и не совпадает с остальными пометками каталога', () => {
    const src = TEXTS();
    expect(src).toContain("export const UNREADABLE_CONVERSATIONS_TEXT = 'Переписки не удалось прочитать'");
    const marks = src.match(/= '([^']*не удалось прочитать)'/g) ?? [];
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('список переписок: сбой чтения не выдаётся за пустоту', () => {
  it('оба списка читаются вариантом с третьим исходом', () => {
    const body = slice(CHAT_LIST(), 'const [openConvs, archivedConvs, ctactsRaw] = await Promise.all([', ']);');
    expect(body).toContain('listConversationsRead(pid)');
    expect(body).toContain('listArchivedConversationsRead(pid)');
  });

  it('на сбое показанное остаётся как было: ни списка, ни счётчика архива не трогаем', () => {
    const body = slice(CHAT_LIST(), 'if (openConvs === null || archivedConvs === null) {', 'setArchivedCount(');
    expect(body).toContain('setConvReadFailed(true);');
    expect(body).toContain('return;');
    // Возврат стоит раньше, чем счётчик архива и сбор строк списка.
    const src = CHAT_LIST();
    expect(src.indexOf('setConvReadFailed(true);')).toBeLessThan(src.indexOf('setArchivedCount('));
    expect(src.indexOf('setConvReadFailed(false);')).toBeLessThan(src.indexOf('setArchivedCount('));
  });

  it('пустой экран на сбое говорит правду и не зовёт добавлять собеседника', () => {
    const body = slice(CHAT_LIST(), ') : convReadFailed ? (', ') : (');
    expect(body).toContain('{UNREADABLE_CONVERSATIONS_TEXT}');
    expect(codeOnly(body)).not.toContain('вставьте ID собеседника');
  });

  it('повод для правки жив: обычная пустота по-прежнему зовёт добавить собеседника', () => {
    // Если бы этой подсказки не было, честная ветка выше была бы украшением:
    // ложью «Нет переписок» становится именно из-за неё.
    expect(CHAT_LIST()).toContain('Нажмите ✎ вверху и вставьте ID собеседника');
  });
});

describe('черновик: строка диалога, которую не прочитали', () => {
  it('пустотой поверх непрочитанной строки не пишем', () => {
    expect(decideDraftWrite(null, false, true)).toEqual({ write: false, reason: 'clearOverUnknownRow' });
    expect(decideDraftWrite('', false, true)).toEqual({ write: false, reason: 'clearOverUnknownRow' });
    expect(decideDraftWrite('   ', false, true)).toEqual({ write: false, reason: 'clearOverUnknownRow' });
  });

  it('новый текст поверх непрочитанной строки — законная замена', () => {
    expect(decideDraftWrite('новый ответ', false, true)).toEqual({ write: true, reason: 'ok' });
  });

  it('прочитанная строка запрета не даёт, иначе черновик станет неудаляемым', () => {
    expect(decideDraftWrite(null, false, false)).toEqual({ write: true, reason: 'ok' });
    expect(decideDraftWrite(null, false, undefined)).toEqual({ write: true, reason: 'ok' });
  });

  it('причины различимы: непрочитанный столбец называется своим именем', () => {
    expect(decideDraftWrite(null, true, true)).toEqual({ write: false, reason: 'clearOverUnreadable' });
    expect(decideDraftWrite(null, true, false)).toEqual({ write: false, reason: 'clearOverUnreadable' });
  });

  it('восстановление черновика различает сбой чтения и «диалога нет»', () => {
    const body = slice(CHAT(), '// Load and restore draft + mute state when opening chat', '// Load chat wallpaper');
    expect(body).toContain('listConversationsRead(activeProfileId)');
    expect(body).toContain('if (convs === null) {');
    expect(body).toContain('draftRowUnknownRef.current = true;');
    expect(body).toContain('draftRowUnknownRef.current = false;');
  });

  it('единственная точка записи спрашивает про оба неведения', () => {
    const body = slice(CHAT(), 'const writeDraft = useCallback(', '// Save draft with debounce');
    expect(body).toContain('decideDraftWrite(next, draftUnreadableRef.current, draftRowUnknownRef.current).write');
  });
});

describe('проверка не пустая', () => {
  it('срез исходника действительно вырезает тело, а не весь файл', () => {
    const body = slice(CHAT_LIST(), ') : convReadFailed ? (', ') : (');
    expect(body.length).toBeGreaterThan(50);
    expect(body.length).toBeLessThan(CHAT_LIST().length / 4);
    expect(body).not.toContain('Нет переписок');
  });

  it('снятие комментариев не съедает код', () => {
    expect(codeOnly('// вставьте ID собеседника\nconst a = 1;')).toBe('const a = 1;');
    expect(codeOnly('const b = 2;')).toBe('const b = 2;');
  });
});
