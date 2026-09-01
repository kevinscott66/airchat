/**
 * Непрочитанная сторис: пустая карточка и файл, который никто не сотрёт
 * (v4.32.586).
 *
 * Адрес снимка и подпись сторис читались двумя состояниями, и столбец, не
 * открывшийся ключом, приходил пустотой. На экране это давало пустую чёрную
 * карточку, неотличимую от сторис без содержимого; в уборке — файл, который
 * стереть нечем, и, хуже, стёртый файл живой сторис, чей адрес не прочитан.
 */
import fs from 'fs';
import path from 'path';

import {
  aliveAddressUnknown,
  lostAddressCount,
  planStoryMediaSweep,
  storyIsUnreadable,
  type StoryUriCell,
} from '../storyMediaSweep';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const ROW = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'StoriesRow.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const plain = (uri: string): StoryUriCell => ({ state: 'plain', uri });
const absent = (): StoryUriCell => ({ state: 'absent', uri: null });
const unreadable = (): StoryUriCell => ({ state: 'unreadable', uri: null });

describe('план уборки файлов сторис', () => {
  it('стирает файл истёкшей сторис, на который никто больше не смотрит', () => {
    const plan = planStoryMediaSweep(['file://a'], [plain('file://b'), absent()]);
    expect(plan).toEqual({ deletable: ['file://a'], blocked: false });
  });

  it('не стирает файл, который делит с ещё живой сторис', () => {
    const plan = planStoryMediaSweep(['file://a', 'file://b'], [plain('file://a')]);
    expect(plan.deletable).toEqual(['file://b']);
    expect(plan.blocked).toBe(false);
  });

  it('откладывает уборку целиком, пока адрес живой сторис не прочитан', () => {
    const plan = planStoryMediaSweep(['file://a'], [unreadable()]);
    expect(plan).toEqual({ deletable: [], blocked: true });
  });

  it('повторный адрес не попадает в список дважды', () => {
    expect(planStoryMediaSweep(['file://a', 'file://a'], []).deletable).toEqual(['file://a']);
  });

  it('пустой список ничего не откладывает и ничего не стирает', () => {
    expect(planStoryMediaSweep([], [unreadable()])).toEqual({ deletable: [], blocked: false });
  });

  it('считает истёкшие строки, унёсшие адрес своего файла', () => {
    expect(lostAddressCount([plain('file://a'), unreadable(), unreadable(), absent()])).toBe(2);
    expect(aliveAddressUnknown([plain('file://a'), absent()])).toBe(false);
    expect(aliveAddressUnknown([absent(), unreadable()])).toBe(true);
  });

  it('пометка ставится по любой из двух непрочитанных половин', () => {
    expect(storyIsUnreadable(false, false)).toBe(false);
    expect(storyIsUnreadable(undefined, undefined)).toBe(false);
    expect(storyIsUnreadable(true, false)).toBe(true);
    expect(storyIsUnreadable(false, true)).toBe(true);
  });

  it('модуль остаётся чистым: ни хранилища, ни файловой системы', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'storyMediaSweep.ts'), 'utf8');
    expect(src.match(/^import .*$/gm)).toBeNull();
  });
});

describe('хранилище читает сторис тремя состояниями', () => {
  it('снимок и подпись приходят с признаком непрочитанности', () => {
    const body = slice(LOCAL(), 'export async function listActiveStories(', 'export async function');
    expect(body).toContain('const mediaCell = readAtRestCell(r.media_uri, dek);');
    expect(body).toContain('const textCell = readAtRestCell(r.text, dek);');
    expect(body).toContain('mediaUnreadable: unreadableFromCellState(mediaCell.state),');
    expect(body).toContain('textUnreadable: unreadableFromCellState(textCell.state),');
    expect(body).not.toContain('mediaUri: decryptAtRestNullable(r.media_uri, dek),');
  });

  it('уборщик решает планом, а не пустой строкой', () => {
    const body = slice(LOCAL(), 'async function dropStoryMediaFiles(', 'export async function deleteExpiredStories');
    expect(body).toContain('const plan = planStoryMediaSweep(ours, alive);');
    expect(body).toContain('if (plan.blocked)');
    expect(body).toContain("log.warn('story_media_address_unreadable'");
    expect(body).not.toContain('const u = decryptAtRestNullable(r.media_uri, dek);');
  });

  it('оба вызова уборщика передают состояние столбца', () => {
    const src = LOCAL();
    expect(src).toContain('doomed.map((r) => storyUriCell(r.media_uri, dek))');
    expect(src).toContain('[storyUriCell(row.media_uri, dek)]');
    expect(src).not.toContain('[decryptAtRestNullable(row.media_uri, dek)]');
  });
});

describe('экран признаётся, что сторис не открылась', () => {
  it('вместо пустой карточки показывается пометка', () => {
    const src = ROW();
    expect(src).toContain('storyIsUnreadable(story.mediaUnreadable, story.textUnreadable)');
    expect(src).toContain('{UNREADABLE_STORY_TEXT}');
    // v4.32.590: утверждение про строку импорта целиком ломалось от каждой
    // новой пометки в том же импорте — теперь оно про имя, а не про строку.
    expect(src).toMatch(/^import \{[^}]*\bUNREADABLE_STORY_TEXT\b[^}]*\} from '\.\.\/\.\.\/core\/storage\/unreadableText';$/m);
  });

  it('подпись поверх снимка не рисуется пустотой', () => {
    expect(ROW()).toContain(
      '{story.mediaUri && story.text && !storyIsUnreadable(story.mediaUnreadable, story.textUnreadable) ? ('
    );
  });
});
