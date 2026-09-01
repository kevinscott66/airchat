/**
 * v4.32.582 — быстрый ответ, который не открылся, перестал притворяться пустым.
 *
 * `listQuickReplies` читала текст через `decryptAtRestString`, а он на неудаче
 * отдаёт пустую строку. Дальше эта пустота показывалась строкой без текста в
 * настройках, вставлялась в поле ввода при нажатии во вкладке «Ответ» и
 * выпадала из поиска по шаблонам. Проверки ниже держат все три правила.
 */
import fs from 'fs';
import path from 'path';
import {
  filterTemplates,
  mayPickTemplate,
  templateMatchesQuery,
  templateReadable,
  type TemplateLike,
} from '../templateSearch';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const SHEET = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'AttachSheet.tsx'), 'utf8');
const SETTINGS = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'SettingsScreen.tsx'), 'utf8');

/** Кусок исходника между двумя якорями — чтобы проверка не ловила чужой код. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const OK: TemplateLike = { text: 'Буду через 10 минут' };
const EMPTY: TemplateLike = { text: '' };
const BROKEN: TemplateLike = { text: '', unreadable: true };

describe('правила про непрочитанный шаблон', () => {
  it('пустой шаблон и непрочитанный — разные вещи', () => {
    expect(templateReadable(EMPTY)).toBe(true);
    expect(templateReadable(BROKEN)).toBe(false);
    expect(templateReadable(OK)).toBe(true);
  });

  it('ничего и никого нет — тоже не прочитано', () => {
    expect(templateReadable(null)).toBe(false);
    expect(templateReadable(undefined)).toBe(false);
    expect(mayPickTemplate(null)).toBe(false);
  });

  it('непрочитанный шаблон нельзя вставить в поле ввода', () => {
    expect(mayPickTemplate(OK)).toBe(true);
    // Пустой шаблон вставить можно: это законное, пусть и странное, значение.
    expect(mayPickTemplate(EMPTY)).toBe(true);
    expect(mayPickTemplate(BROKEN)).toBe(false);
  });

  it('пустой запрос показывает всё', () => {
    expect(templateMatchesQuery(OK, '')).toBe(true);
    expect(templateMatchesQuery(BROKEN, '   ')).toBe(true);
  });

  it('непрочитанный шаблон не прячется из выдачи: мы не знаем, подходит ли он', () => {
    expect(templateMatchesQuery(BROKEN, 'встреча')).toBe(true);
    expect(templateMatchesQuery(EMPTY, 'встреча')).toBe(false);
  });

  it('обычный отбор по подстроке не сломан и не зависит от регистра', () => {
    expect(templateMatchesQuery(OK, 'МИНУТ')).toBe(true);
    expect(templateMatchesQuery(OK, ' буду ')).toBe(true);
    expect(templateMatchesQuery(OK, 'завтра')).toBe(false);
  });

  it('filterTemplates оставляет совпавшие и все непрочитанные', () => {
    const list = [OK, EMPTY, BROKEN, { text: 'Перезвоню' }];
    expect(filterTemplates(list, 'минут')).toEqual([OK, BROKEN]);
    expect(filterTemplates(list, '')).toEqual(list);
    expect(filterTemplates(list, 'ничего такого')).toEqual([BROKEN]);
  });

  it('модуль ни от чего не зависит — правила проверяются без базы и ключей', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'templateSearch.ts'), 'utf8');
    expect(/^import\s/m.test(src)).toBe(false);
  });
});

describe('чтение и показ шаблонов', () => {
  it('listQuickReplies читает текст трёхзначно и несёт признак наружу', () => {
    const body = slice(LOCAL(), 'export async function listQuickReplies(', "log.warn('list_quick_replies_failed'");
    expect(body).not.toContain('decryptAtRestString(r.text, dek)');
    expect(body).toContain('const cell = readAtRestCell(r.text, dek);');
    expect(body).toContain("text: cellTextOrNull(cell) ?? '',");
    expect(body).toContain('unreadable: unreadableFromCellState(cell.state),');
  });

  it('тип шаблона несёт признак рядом с текстом, а не вместо него', () => {
    const type = slice(LOCAL(), 'export type QuickReply = {', '};');
    expect(type).toContain('text: string;');
    expect(type).toContain('unreadable?: boolean;');
  });

  it('вкладка «Ответ»: отбор через filterTemplates, нажатие отключено, пометка вместо пустоты', () => {
    const src = SHEET();
    const tab = slice(src, 'function ReplyTab(', '// Tab: Контакт');
    expect(tab).toContain('filterTemplates(replies, q)');
    // Старый отбор сравнивал пустую строку и прятал непрочитанный шаблон.
    expect(tab).not.toContain('replies.filter((r) => r.text.toLowerCase().includes(needle))');
    expect(tab).toContain('disabled={!mayPickTemplate(item)}');
    expect(tab).toContain('{readable ? item.text : UNREADABLE_TEMPLATE_TEXT}');
  });

  it('настройки: строка шаблона показывает пометку, а правка остаётся доступной', () => {
    const list = slice(SETTINGS(), '{quickReplies.map((qr) => (', '</View>\n      ))}');
    expect(list).toContain('templateReadable(qr) ? qr.text : UNREADABLE_TEMPLATE_TEXT');
    // Карандаш — единственный способ заменить непрочитанный шаблон, он не гасится.
    expect(list).not.toContain('disabled');
    expect(SETTINGS()).toContain("setEditingQR(qr); setEditingQRText(qr.text);");
  });

  it('редактор шаблона не даёт сохранить пустоту поверх непрочитанного столбца', () => {
    // Пустое поле правки у непрочитанного шаблона — норма; важно, что кнопка
    // «Сохранить» на пустой строке ничего не пишет (правило v4.32.579 в миниатюре).
    expect(SETTINGS()).toContain('if (editingQR && editingQRText.trim()) {');
  });
});
