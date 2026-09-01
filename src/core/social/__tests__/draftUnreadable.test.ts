/**
 * Непрочитанный черновик (v4.32.583).
 *
 * Три беды одного корня: столбец draft_text читался двухсостоянийным
 * помощником, пустая строка означала «черновика нет», и пустая запись поверх
 * непрочитанного шифртекста уничтожала его молча. Поведение правила
 * проверяется вызовами, проводка — по форме исходников: только так видно, что
 * ни одна из трёх точек записи не ходит в базу мимо правила.
 */
import fs from 'fs';
import path from 'path';

import {
  decideDraftWrite,
  draftIsEmpty,
  draftIsUnreadable,
  hasReadableDraft,
  unreadableAfterWrite,
} from '../draftGuard';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const TEXTS = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'unreadableText.ts'), 'utf8');
const CHAT = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');
const GROUPS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
const CHAT_LIST = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatListScreen.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('draftGuard: пустотой поверх непрочитанного не пишем', () => {
  it('пустой черновик — это null, undefined и пробелы', () => {
    expect(draftIsEmpty(null)).toBe(true);
    expect(draftIsEmpty(undefined)).toBe(true);
    expect(draftIsEmpty('   \n\t ')).toBe(true);
    expect(draftIsEmpty('а')).toBe(false);
  });

  it('стереть непрочитанный черновик нельзя — именно так его и теряли', () => {
    expect(decideDraftWrite(null, true)).toEqual({ write: false, reason: 'clearOverUnreadable' });
    expect(decideDraftWrite('', true)).toEqual({ write: false, reason: 'clearOverUnreadable' });
    expect(decideDraftWrite('   ', true)).toEqual({ write: false, reason: 'clearOverUnreadable' });
  });

  it('новый текст поверх непрочитанного — законная замена, ею и лечат', () => {
    expect(decideDraftWrite('новый ответ', true)).toEqual({ write: true, reason: 'ok' });
  });

  it('над прочитанным столбцом запрета нет, иначе черновик станет неудаляемым', () => {
    expect(decideDraftWrite(null, false)).toEqual({ write: true, reason: 'ok' });
    expect(decideDraftWrite(null, undefined)).toEqual({ write: true, reason: 'ok' });
    expect(decideDraftWrite('текст', false)).toEqual({ write: true, reason: 'ok' });
  });

  it('после записи непустого текста столбец наш и читается', () => {
    expect(unreadableAfterWrite('новый ответ', true)).toBe(false);
    expect(unreadableAfterWrite(null, true)).toBe(true); // записи не было — признак держится
    expect(unreadableAfterWrite('что угодно', false)).toBe(false);
  });

  it('в поле ввода возвращается только прочитанный непустой черновик', () => {
    expect(hasReadableDraft('черновик', false)).toBe(true);
    expect(hasReadableDraft('черновик', true)).toBe(false);
    expect(hasReadableDraft(null, false)).toBe(false);
    expect(hasReadableDraft('', false)).toBe(false);
    expect(hasReadableDraft('   ', false)).toBe(false);
  });

  it('непрочитанность — отдельный вопрос от наличия текста', () => {
    expect(draftIsUnreadable(true)).toBe(true);
    expect(draftIsUnreadable(false)).toBe(false);
    expect(draftIsUnreadable(undefined)).toBe(false);
  });

  it('признак живёт рядом с текстом, а не подменяет его', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'draftGuard.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toContain('не удалось прочитать');
  });
});

describe('строка про непрочитанный черновик', () => {
  it('своя и не совпадает с сообщением и шаблоном', () => {
    const src = TEXTS();
    expect(src).toContain("export const UNREADABLE_DRAFT_TEXT = 'Черновик не удалось прочитать'");
    const marks = src.match(/= '([^']*не удалось прочитать)'/g) ?? [];
    expect(new Set(marks).size).toBe(marks.length);
  });
});

describe('хранилище отдаёт третье состояние черновика', () => {
  it('обе строки списков несут признак', () => {
    const src = LOCAL();
    for (const name of ['ConversationRow', 'GroupRow']) {
      const a = src.indexOf(`export type ${name} = {`);
      expect(a).toBeGreaterThan(-1);
      const b = src.indexOf('\n};', a);
      expect(b).toBeGreaterThan(a);
      expect(src.slice(a, b)).toContain('draftUnreadable?: boolean;');
    }
  });

  it('ни один читатель черновика не берёт двухсостоянийного помощника', () => {
    const src = LOCAL();
    expect(src).not.toContain('decryptAtRestNullable(r.draft_text');
    expect(src).not.toContain('decryptAtRestString(r.draft_text');
  });

  it('все три места читают ячейку и отдают признак рядом с текстом', () => {
    const src = LOCAL();
    expect((src.match(/const draftCell = readAtRestCell\(/g) ?? []).length).toBe(3);
    expect((src.match(/draftText: cellTextOrNull\(draftCell\),/g) ?? []).length).toBe(3);
    expect((src.match(/draftUnreadable: unreadableFromCellState\(draftCell\.state\),/g) ?? []).length).toBe(3);
  });
});

describe('переписка: запись черновика идёт через правило', () => {
  it('единственная точка записи спрашивает решение и снимает признак', () => {
    const body = slice(CHAT(), 'const writeDraft = useCallback(', '// Save draft with debounce');
    expect(body).toContain('decideDraftWrite(next, draftUnreadableRef.current).write');
    expect(body).toContain('unreadableAfterWrite(next, draftUnreadableRef.current)');
    expect(body).toContain('setConversationDraft(peerB64, activeProfileId, next)');
  });

  it('отложенная, досрочная и снимающая записи ходят только через неё', () => {
    const src = CHAT();
    expect((src.match(/setConversationDraft\(/g) ?? []).length).toBe(1);
    expect(slice(src, 'const saveDraft = useCallback(', 'const flushDraft')).toContain("writeDraft(pending.trim() || null)");
    expect(slice(src, 'const flushDraft = useCallback(', 'useEffect(')).toContain("writeDraft(pending.trim() || null)");
    expect(slice(src, 'const clearDraft = useCallback(', 'const pickImage')).toContain('writeDraft(null)');
  });

  it('поле ввода заполняется только прочитанным черновиком', () => {
    const body = slice(CHAT(), 'const conv = convs.find(', '});');
    expect(body).toContain('draftUnreadableRef.current = draftIsUnreadable(conv?.draftUnreadable);');
    expect(body).toContain('hasReadableDraft(conv.draftText, conv.draftUnreadable)');
  });
});

describe('группа: запись черновика идёт через правило', () => {
  it('единственная точка записи спрашивает решение и снимает признак', () => {
    const body = slice(GROUPS(), 'const writeGroupDraft = useCallback(', '// Restore draft on mount');
    expect(body).toContain('decideDraftWrite(next, draftUnreadableRef.current).write');
    expect(body).toContain('unreadableAfterWrite(next, draftUnreadableRef.current)');
    expect(body).toContain('setGroupDraft(group.id, pid, next)');
  });

  it('все три записи ходят только через неё', () => {
    const src = GROUPS();
    expect((src.match(/setGroupDraft\(/g) ?? []).length).toBe(1);
    expect((src.match(/writeGroupDraft\(pending\.trim\(\) \|\| null\)/g) ?? []).length).toBe(2);
    expect(slice(src, 'const clearGroupDraft = useCallback(', '// Уход из группы')).toContain('writeGroupDraft(null)');
  });

  it('поле ввода заполняется только прочитанным черновиком', () => {
    expect(slice(GROUPS(), '// Restore draft on mount', '}, []);'))
      .toContain('hasReadableDraft(group.draftText, group.draftUnreadable)');
  });
});

describe('списки говорят про непрочитанный черновик', () => {
  it('в списке диалогов пометка стоит раньше пометки последней реплики', () => {
    const src = CHAT_LIST();
    const draft = src.indexOf('UNREADABLE_DRAFT_TEXT}');
    const preview = src.indexOf('{UNREADABLE_MESSAGE_TEXT}');
    expect(draft).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(draft);
  });

  it('в списке диалогов «Вы:» не приписывается к непрочитанному черновику', () => {
    expect(CHAT_LIST()).toContain('!isTyping && isOut && !draftReadable && !draftUnreadable ?');
  });

  it('в списке групп непрочитанный черновик вытесняет «Нет сообщений»', () => {
    const body = slice(GROUPS(), 'const draftUnreadable = draftIsUnreadable(item.draftUnreadable);', 'const showDraftLabel');
    expect(body).toContain('? UNREADABLE_DRAFT_TEXT');
  });
});
