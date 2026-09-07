/**
 * Список недавних эмодзи и реакций, который не прочитался, — не пустой список
 * (v4.32.649).
 *
 * Дефект. Три места читали накопленный список через `scopedKvGet`, который
 * сводит «записи нет» и «прочитать не вышло» в один `null`, и тут же писали
 * поверх результат «прежнее плюс новое». На сбое чтения «прежнее» выходило
 * пустым, и на диск ложился список из одного элемента: восемь сохранённых
 * реакций или двадцать четыре эмодзи исчезали навсегда, без единого следа в
 * журнале. Достаточно было одного заблокированного мига базы в тот момент,
 * когда человек ставит реакцию.
 *
 * Что сделано. Все три читают `scopedKvTryGet` и на `null` не пишут ничего:
 * запись поверх — право того, кто прочитал. В панели эмодзи запись идёт из
 * состояния, а не из свежего чтения, поэтому там появился флаг `recentsLoaded`
 * — он же закрывает и второе окно: чтение асинхронное, ввод им не блокируется,
 * и нажатие в первые миги после открытия панели тоже оставляло на диске список
 * из одного эмодзи.
 *
 * Чего это НЕ чинит. Чтение при монтировании в ChatScreen и GroupsScreen
 * по-прежнему сводит сбой к пустому списку: там по нему ничего не пишут, и
 * худшее — недавние не показались до перезахода. И сама запись остаётся
 * `scopedKvSet`: не легла — на экране список новее, чем на диске, но ничего
 * не потеряно.
 *
 * Проверки — по форме исходника: рендерера в проекте нет.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
const srcOf = (...rel: string[]): string =>
  fs
    .readFileSync(path.join(SRC, ...rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const PANEL = srcOf('ui', 'screens', 'chat-components', 'EmojiPanel.tsx');
const CHAT = srcOf('ui', 'screens', 'ChatScreen.tsx');
const GROUPS = srcOf('ui', 'screens', 'GroupsScreen.tsx');
const KV = srcOf('core', 'storage', 'profileScopedKv.ts');

/** Кусок исходника от объявления до закрывающей строки — включительно. */
function chunk(src: string, head: string, tail: string): string {
  const i = src.indexOf(head);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(tail, i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j + tail.length);
}

describe('повод для правки жив', () => {
  it('scopedKvGet по-прежнему сводит «нет записи» и «не прочиталось» в один null', () => {
    expect(KV).toContain('(await scopedKvTryGetFor(pid, key))?.value ?? null');
  });

  it('и трёхисходный сосед по-прежнему на месте', () => {
    expect(KV).toContain('export async function scopedKvTryGet(key: string): Promise<{ value: string | null } | null>');
  });

  it('накопленные списки по-прежнему обрезаны, то есть терять было что', () => {
    expect(PANEL).toContain('.slice(0, 24)');
    expect(CHAT).toContain('.slice(0, 8)');
    expect(GROUPS).toContain('.slice(0, 8)');
  });
});

describe('панель эмодзи: пишет только тот, кто прочитал', () => {
  it('читает тремя исходами, а не двумя', () => {
    expect(PANEL).toContain('void scopedKvTryGet(RECENT_EMOJIS_PANEL_KEY).then((got) => {');
    expect(PANEL).not.toContain('scopedKvGet(');
  });

  it('сбой чтения не поднимает флаг и попадает в журнал', () => {
    const body = chunk(PANEL, 'void scopedKvTryGet(RECENT_EMOJIS_PANEL_KEY)', '  }, []);');
    const fail = body.indexOf("log.warn('recent_emojis_read_failed'");
    const ok = body.indexOf('setRecentsLoaded(true)');
    expect(fail).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(fail);
    expect(body).toContain('if (got === null) {');
  });

  it('единственная запись списка закрыта этим флагом', () => {
    const writes = PANEL.match(/scopedKvSet\(RECENT_EMOJIS_PANEL_KEY/g) ?? [];
    expect(writes.length).toBe(1);
    expect(PANEL).toContain('if (recentsLoaded) void scopedKvSet(RECENT_EMOJIS_PANEL_KEY, JSON.stringify(next));');
  });

  it('и она больше не спрятана внутри обновляющей функции состояния', () => {
    expect(PANEL).not.toMatch(/setRecentEmojis\(\(prev\)/);
  });
});

describe('реакции: пустое «прежнее» больше не берётся из сбоя', () => {
  it('в диалоге чтение трёхисходное и на сбое ничего не пишется', () => {
    const body = chunk(CHAT, 'const addRecentReaction = useCallback', '  }, []);');
    expect(body).toContain('await scopedKvTryGet(RECENT_REACTIONS_KEY)');
    expect(body).not.toContain('scopedKvGet(');
    const guard = body.indexOf('if (got === null) {');
    const write = body.indexOf('await scopedKvSet(RECENT_REACTIONS_KEY');
    expect(guard).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
    expect(body.slice(guard, write)).toContain('return;');
  });

  it('в группах — то же самое, и запись лежит в ветке «прочитали»', () => {
    const body = chunk(GROUPS, 'const got = await scopedKvTryGet(RECENT_REACTIONS_KEY)', 'setGrpRecentReactions(list);');
    expect(body).toContain('if (got === null) {');
    expect(body).toContain("log.warn('recent_reactions_read_failed'");
    expect(body).toContain('} else {');
    const els = body.indexOf('} else {');
    expect(body.indexOf('await scopedKvSet(RECENT_REACTIONS_KEY')).toBeGreaterThan(els);
  });

  it('и разбор формы в группах теперь такой же, как в диалоге', () => {
    expect(GROUPS).toContain(
      'try { const p = got.value ? JSON.parse(got.value) : null; if (Array.isArray(p)) list = p as string[]; } catch { /* */ }'
    );
    expect(GROUPS).not.toContain('JSON.parse(raw) as string[]');
  });

  it('проверка не пустая: чтение при монтировании нарочно осталось прежним', () => {
    const load = chunk(CHAT, '  useEffect(() => {\n    void (async () => {\n      const raw = await scopedKvGet(RECENT_REACTIONS_KEY);', '  }, []);');
    expect(load).toContain('scopedKvGet(RECENT_REACTIONS_KEY)');
    expect(load).not.toContain('scopedKvSet(');
  });
});
