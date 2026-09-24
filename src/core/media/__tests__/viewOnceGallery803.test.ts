/**
 * Галерея «Медиа и файлы» больше не открывает одноразовые снимки (v4.32.803).
 *
 * Дефект. Обе выборки общих медиа (`listConversationMedia`,
 * `listGroupConversationMedia`) читали из строки только `media_cids` — столбец
 * `text` в запрос не входил. А признак одноразового сообщения живёт именно в
 * тексте: префикс '\x09vo:'. То есть на уровне галереи одноразовый снимок был
 * неотличим от обычного, и отличить его было нечем даже при желании.
 *
 * Цена. Снимок расшифровывался наравне с остальными — `useResolvedMediaUrls`
 * кладёт открытый файл в кэш, — и появлялся плиткой в сетке ещё до того, как
 * его «открыли» в переписке. Открыть его из галереи можно было сколько угодно
 * раз: этот путь не зовёт ни `runViewOnceTap`, ни удаление, так что ни один
 * показ сообщение не сжигал. Обещание «один раз» отменялось целиком, причём
 * тем, кто снимок получил, — без единого инструмента, одним пунктом меню.
 *
 * Правка. Выборки читают `text` ради одного бита и отдают наружу `viewOnce` —
 * сам текст не отдают, подпись одноразового не должна покидать переписку.
 * Выбор адресов на расшифровку переехал из двух разметок в общий
 * `galleryCids`, и одноразовая строка адресов не даёт: плитку можно было бы не
 * рисовать и в разметке, но файл в кэше от этого бы не исчез. В сетке остаётся
 * место со значком — молчать о строке нельзя, она в переписке есть.
 */
import fs from 'fs';
import path from 'path';

import { galleryCids, galleryFirstCids, GALLERY_CID_LIMIT } from '../galleryCids';
import { mediaRowViewOnce, readableMediaCount, type SharedMediaLike } from '../sharedMediaScan';
import { isViewOnceText, VIEW_ONCE_PREFIX } from '../../social/messagePreview';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Обычная строка галереи с одним вложением. */
const plain = (cid: string): SharedMediaLike => ({ mediaCids: cid });
/** Одноразовая строка: вложение есть, показывать его галерее нельзя. */
const once = (cid: string): SharedMediaLike => ({ mediaCids: cid, viewOnce: true });

describe('одноразовое не доходит до расшифровки', () => {
  it('его адреса нет в списке на загрузку — значит нет и файла в кэше', () => {
    const cids = galleryCids([plain('QmA'), once('nb:секрет'), plain('QmB')]);
    expect(cids).toEqual(['QmA', 'QmB']);
    expect(cids.join('|')).not.toContain('секрет');
  });

  it('в позиционном списке группы на его месте пусто, а не чужой адрес', () => {
    const first = galleryFirstCids([plain('QmA'), once('nb:секрет'), plain('QmB')]);
    // Длина та же: плитка берёт адрес по своему индексу в сетке, и сдвиг
    // подписал бы чужие снимки чужими датами.
    expect(first).toEqual(['QmA', '', 'QmB']);
  });

  it('несколько вложений одной одноразовой строки уходят все', () => {
    expect(galleryCids([once('["nb:a","nb:b","nb:c"]'), plain('QmA')])).toEqual(['QmA']);
  });

  it('признак строки спрашивается отдельно от «не прочиталось»', () => {
    expect(mediaRowViewOnce(once('nb:x'))).toBe(true);
    expect(mediaRowViewOnce(plain('QmA'))).toBe(false);
    expect(mediaRowViewOnce({ mediaCids: '', unreadable: true })).toBe(false);
    expect(mediaRowViewOnce(null)).toBe(false);
    expect(mediaRowViewOnce(undefined)).toBe(false);
  });

  it('признак одноразового считается по префиксу, а не по догадке', () => {
    expect(isViewOnceText(`${VIEW_ONCE_PREFIX}подпись`)).toBe(true);
    expect(isViewOnceText(VIEW_ONCE_PREFIX)).toBe(true);
    expect(isViewOnceText('обычный текст')).toBe(false);
    expect(isViewOnceText(`текст с ${VIEW_ONCE_PREFIX} внутри`)).toBe(false);
    expect(isViewOnceText('')).toBe(false);
    expect(isViewOnceText(null)).toBe(false);
    expect(isViewOnceText(undefined)).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная галерея работает как работала', () => {
  it('обычные вложения проходят целиком и в прежнем порядке', () => {
    expect(galleryCids([plain('QmA'), plain('["QmB","QmC"]')])).toEqual(['QmA', 'QmB', 'QmC']);
    expect(galleryFirstCids([plain('QmA'), plain('["QmB","QmC"]')])).toEqual(['QmA', 'QmB']);
  });

  it('потолок загрузок остался тем же и считается по адресам', () => {
    const rows = Array.from({ length: GALLERY_CID_LIMIT + 50 }, (_, i) => plain(`Qm${i}`));
    expect(galleryCids(rows)).toHaveLength(GALLERY_CID_LIMIT);
    expect(GALLERY_CID_LIMIT).toBe(300);
  });

  it('непрочитанная строка ведёт себя как прежде: адресов нет, место в сетке есть', () => {
    const bad: SharedMediaLike = { mediaCids: '', unreadable: true };
    expect(galleryCids([plain('QmA'), bad])).toEqual(['QmA']);
    expect(galleryFirstCids([plain('QmA'), bad])).toEqual(['QmA', '']);
  });

  it('счётчик вложений одноразовое считает — оно в переписке есть', () => {
    // Строка занимает место в сетке, поэтому и в числе над сеткой она должна
    // быть: иначе число разойдётся с тем, что видно.
    expect(readableMediaCount([plain('QmA'), once('nb:x')])).toBe(2);
  });

  it('пустой список остаётся пустым, а не падает', () => {
    expect(galleryCids([])).toEqual([]);
    expect(galleryFirstCids([])).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('разбор адреса пишет расшифрованное вложение в файл — отсюда и цена', () => {
    const body = codeOnly(read('ui/screens/chat-components/useResolvedMediaUrls.ts'));
    // Пока адрес в списке, вложение скачивается и расшифровывается в файл кэша.
    // Значит решение «показывать или нет» обязано приниматься ДО этого списка,
    // а не на отрисовке плитки.
    expect(body).toContain("await resolveBlobToLocalFile(ref, 'img')");
  });

  it('галерея не сжигает одноразовое: удаление живёт в другом месте', () => {
    // Путь, который гасит снимок, — runViewOnceTap на экране переписки. В окне
    // галереи его нет и не было: открытие оттуда не считалось показом.
    for (const rel of [
      'ui/components/modals/chat/ChatSharedMediaModal.tsx',
      'ui/components/modals/groups/GroupSharedMediaModal.tsx',
    ]) {
      expect(codeOnly(read(rel))).not.toContain('runViewOnceTap');
    }
    expect(codeOnly(read('ui/screens/ChatScreen.tsx'))).toContain('runViewOnceTap(');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('обе выборки читают text и отдают признак', () => {
    const src = codeOnly(read('core/storage/local.ts'));
    for (const [from, to] of [
      ['export async function listConversationMedia(', 'export async function listGroupConversationMedia('],
      ['export async function listGroupConversationMedia(', 'export type ScheduledMessage = {'],
    ] as Array<[string, string]>) {
      const body = slice(src, from, to);
      expect(body).toContain('SELECT id, media_cids, created_at, text FROM');
      expect(body).toContain('viewOnce: viewOnceFromTextCell(readAtRestCell(r.text, dek)),');
    }
  });

  it('непрочитанный text считается одноразовым — ошибаться можно только в эту сторону', () => {
    const body = slice(
      codeOnly(read('core/storage/local.ts')),
      'function viewOnceFromTextCell(',
      '\n}',
    );
    expect(body).toContain("if (cell.state === 'unreadable') return true;");
    expect(body).toContain('return isViewOnceText(cellTextOrNull(cell));');
  });

  it('сама подпись одноразового наружу из хранилища не идёт', () => {
    const body = slice(codeOnly(read('core/storage/local.ts')), 'export type SharedMediaRow = {', '\n};');
    expect(body).toContain('viewOnce?: boolean;');
    expect(body).not.toContain('text:');
  });

  it('обе разметки берут адреса из общего выбора, а не своей копией', () => {
    const chat = codeOnly(read('ui/components/modals/chat/ChatSharedMediaModal.tsx'));
    const group = codeOnly(read('ui/components/modals/groups/GroupSharedMediaModal.tsx'));
    expect(chat).toContain('galleryCids(items)');
    expect(group).toContain('galleryFirstCids(mediaItems)');
    // Копии выбора, каждая со своим потолком, ушли из разметки совсем.
    expect(chat).not.toContain('out.length >= 300');
    expect(group).not.toContain('parseMediaCidsColumn(it.mediaCids)[0]');
  });

  it('место в сетке остаётся, и значок у него свой', () => {
    for (const rel of [
      'ui/components/modals/chat/ChatSharedMediaModal.tsx',
      'ui/components/modals/groups/GroupSharedMediaModal.tsx',
    ]) {
      const body = codeOnly(read(rel));
      expect(body).toContain('if (mediaRowViewOnce(item)) {');
      expect(body).toContain('name="flame-outline"');
      // Значок «не прочиталось» остаётся за непрочитанным: сведи их в один —
      // и про обе строки будет сказана неправда.
      expect(body).toContain('if (!mediaRowReadable(item)) {');
    }
  });
});
