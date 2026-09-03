/**
 * Непрочитанные вложения в общей галерее (v4.32.584).
 *
 * Обе выборки общих медиа отсеивали строку, у которой не открылся столбец
 * media_cids: `decryptAtRestString` отдавал пустую строку, а `.filter((r) =>
 * r.mediaCids !== '')` убирал её из списка. Окно писало «Нет медиафайлов», а
 * карточка контакта показывала заниженный счётчик — оба ровно так же, как при
 * переписке без единой фотографии.
 */
import fs from 'fs';
import path from 'path';

import { pluralRu } from '../../storage/ruPlural';
import {
  attachmentWordForCount,
  countUnreadableMedia,
  mediaRowReadable,
  mediaSkippedNotice,
  readableMediaCount,
} from '../sharedMediaScan';

const LOCAL = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const CHAT_MEDIA = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'chat', 'ChatSharedMediaModal.tsx'), 'utf8');
const GROUP_MEDIA = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'groups', 'GroupSharedMediaModal.tsx'), 'utf8');
const CONTACT_INFO = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'profile', 'ProfileChatBlock.tsx'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('окончания считаются одним правилом', () => {
  it('11–14 берут форму многих, иначе решает последняя цифра', () => {
    const w = (n: number) => pluralRu(n, 'один', 'два', 'много');
    expect(w(1)).toBe('один');
    expect(w(21)).toBe('один');
    expect(w(101)).toBe('один');
    expect(w(2)).toBe('два');
    expect(w(24)).toBe('два');
    expect(w(5)).toBe('много');
    expect(w(0)).toBe('много');
    expect(w(11)).toBe('много');
    expect(w(14)).toBe('много');
    expect(w(111)).toBe('много');
  });

  it('знак и дробная часть не меняют формы — счёт всегда про строки', () => {
    expect(pluralRu(-1, 'один', 'два', 'много')).toBe('один');
    expect(pluralRu(2.7, 'один', 'два', 'много')).toBe('два');
  });

  it('вложения склоняются тем же правилом', () => {
    expect(attachmentWordForCount(1)).toBe('вложение');
    expect(attachmentWordForCount(3)).toBe('вложения');
    expect(attachmentWordForCount(11)).toBe('вложений');
    expect(attachmentWordForCount(21)).toBe('вложение');
  });
});

describe('строка галереи с непрочитанной ячейкой', () => {
  const ok = { mediaCids: 'nb:a' };
  const bad = { mediaCids: '', unreadable: true };
  const empty = { mediaCids: '' };

  it('плитку строит только прочитанная непустая строка', () => {
    expect(mediaRowReadable(ok)).toBe(true);
    expect(mediaRowReadable(bad)).toBe(false);
    expect(mediaRowReadable(empty)).toBe(false);
    expect(mediaRowReadable(null)).toBe(false);
    expect(mediaRowReadable(undefined)).toBe(false);
  });

  it('счётчик показывает столько, сколько и правда покажем', () => {
    expect(readableMediaCount([ok, bad, ok, empty])).toBe(2);
    expect(countUnreadableMedia([ok, bad, ok, empty])).toBe(1);
    expect(readableMediaCount([])).toBe(0);
  });

  it('подпись появляется только когда есть о чём молчать', () => {
    expect(mediaSkippedNotice([ok, ok])).toBeNull();
    expect(mediaSkippedNotice([])).toBeNull();
    expect(mediaSkippedNotice([bad])).toBe('1 вложение не удалось прочитать — его не показать');
    expect(mediaSkippedNotice([bad, bad, ok])).toBe('2 вложения не удалось прочитать — их не показать');
    expect(mediaSkippedNotice(Array.from({ length: 5 }, () => bad)))
      .toBe('5 вложений не удалось прочитать — их не показать');
  });

  it('модуль зависит только от такого же чистого правила окончаний', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sharedMediaScan.ts'), 'utf8');
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import { pluralRu } from '../storage/ruPlural';"]);
    const plural = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'ruPlural.ts'), 'utf8');
    expect(/^import\s/m.test(plural)).toBe(false);
  });
});

describe('хранилище больше не теряет непрочитанные строки', () => {
  it('ни один читатель медиа не берёт двухсостоянийного помощника', () => {
    expect(LOCAL()).not.toContain('decryptAtRestString(r.media_cids');
  });

  it('обе выборки читают ячейку и оставляют строку с признаком', () => {
    const src = LOCAL();
    for (const [name, from, to] of [
      ['listConversationMedia', 'export async function listConversationMedia(', 'export async function listGroupConversationMedia('],
      ['listGroupConversationMedia', 'export async function listGroupConversationMedia(', '// ─── Scheduled Messages'],
    ] as Array<[string, string, string]>) {
      const body = slice(src, from, to);
      expect(body).toContain('const cell = readAtRestCell(r.media_cids, dek);');
      expect(body).toContain('unreadable: unreadableFromCellState(cell.state),');
      expect(body).toContain(".filter((r) => r.unreadable === true || r.mediaCids !== '');");
      expect(name).toBeTruthy();
    }
  });

  it('тип строки объявлен один раз и несёт признак', () => {
    const body = slice(LOCAL(), 'export type SharedMediaRow = {', '\n};');
    expect(body).toContain('unreadable?: boolean;');
  });
});

describe('окна галереи говорят про непрочитанные вложения', () => {
  it('окно переписки рисует и подпись, и место в сетке', () => {
    const src = CHAT_MEDIA();
    expect(src).toContain('const mediaNotice = useMemo(() => mediaSkippedNotice(items), [items]);');
    expect(src).toContain('if (!mediaRowReadable(item)) {');
    expect(src.indexOf('{mediaNotice}')).toBeLessThan(src.indexOf('renderItem={renderItem}'));
  });

  it('окно группы рисует и подпись, и место в сетке', () => {
    const src = GROUP_MEDIA();
    expect(src).toContain('const mediaNotice = useMemo(() => mediaSkippedNotice(mediaItems), [mediaItems]);');
    expect(src).toContain('if (!mediaRowReadable(item)) {');
    expect(src.indexOf('{mediaNotice}')).toBeLessThan(src.indexOf('data={mediaItems}'));
  });

  // v4.32.574: профиль собеседника стал один, и своей галереи у него больше
  // нет — «Медиа» открывает то же окно переписки, что и всё остальное, а оно
  // про пропущенные уже говорит (проверка выше). От карточки требуется, чтобы
  // число над этим окном совпадало с тем, что в нём покажут, и чтобы второго
  // списка она не заводила: разошлись бы именно на непрочитанных.
  it('карточка профиля считает только показываемое и открывает общую галерею', () => {
    const src = CONTACT_INFO();
    expect(src).toContain('setMediaCount(readableMediaCount(m));');
    expect(src).not.toContain('setMediaCount(m.length);');
    expect(src).toContain('onPress={onOpenMedia}');
    expect(src).not.toContain('FlatList');
  });
});
