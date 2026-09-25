/**
 * Предел документа в записи был записан трижды (v4.32.919).
 *
 * Дефект. Одно и то же ограничение существовало в трёх независимых копиях:
 *
 *   composeDraft.ts  FEED_MAX_DOC_BYTES     = Math.round(1.2 * 1024 * 1024)
 *   feedService.ts   FEED_DOC_MAX_RAW_BYTES = 1.2 * 1024 * 1024
 *   i18n/ru.json     «Тяжелее 1,2 МБ»       — набрано руками
 *
 * По первой отбирал документы экран (`selectComposeDocs`), по второй отказывал
 * сервис при публикации, третью читал человек. Ровно так же был устроен и
 * предел всей записи: `SAFE_LIMIT` жил локальной переменной внутри
 * `publishFeedPost`, а «превышает лимит 1,8 МБ» стояло словами в ru.json.
 * Счётчик документов тоже двоился: FEED_MAX_DOCS против FEED_DOC_MAX_PER_POST.
 *
 * Цена. Сегодня копии совпадают, поэтому на экране не видно ничего. Расходятся
 * такие пары молча и в худшую сторону: подвинуть предел в коде и не тронуть
 * ru.json — значит получить отказ, который называет неверное число, а человек
 * по нему ужимает файл и получает отказ снова. Комментарий рядом с SAFE_LIMIT
 * уже разошёлся с кодом сам: он говорил «1.84 MB» там, где Math.floor даёт
 * 1 887 436 Б — ни 1,84 десятичных, ни 1,8 двоичных.
 *
 * Сторож «единицы размера пишутся только в byteSize» (v4.32.422) этого не
 * ловил: он обходит src/** по маске \.tsx?$, а ru.json под неё не попадает.
 * Здесь проверяется прямо он — в текстах подписей размера больше нет.
 *
 * Правка. Пределы сборки записи живут там, где и остальные, — в composeDraft;
 * feedService берёт их оттуда. Предел всей записи поднят из тела функции в
 * экспортируемую FEED_POST_MAX_BYTES. Обе строки ru.json получили {{limit}},
 * который экран подставляет через formatLimit — тем же округлением вниз, каким
 * подписан любой другой предел в приложении.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  FEED_MAX_DOC_BYTES,
  FEED_MAX_DOCS,
  FEED_POST_MAX_BYTES,
  selectComposeDocs,
} from '../composeDraft';
import { formatLimit } from '../../media/uploadRoute';

const SRC = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const FEED_SERVICE = SRC('social/feedService.ts');
const FEED_SCREEN = SRC('../ui/screens/FeedScreen.tsx');
const RU_RAW = SRC('../i18n/ru.json');
const RU = JSON.parse(RU_RAW) as { feed: Record<string, string> };

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитались', () => {
    expect(FEED_SERVICE.length).toBeGreaterThan(10_000);
    expect(FEED_SCREEN.length).toBeGreaterThan(10_000);
    expect(RU.feed.docSkippedTooBig).toBeTruthy();
  });

  it('пределы — настоящие числа, а не ноль и не бесконечность', () => {
    // Про FEED_POST_MAX_BYTES здесь нарочно не спрашиваем: до правки его не
    // существовало, и эта проверка обязана быть верной по обе стороны.
    expect(FEED_MAX_DOC_BYTES).toBe(1_258_291);
    expect(FEED_MAX_DOCS).toBe(3);
  });
});

describe('предел записан один раз', () => {
  it('своих копий предела документа в сервисе не осталось', () => {
    expect(FEED_SERVICE).not.toContain('FEED_DOC_MAX_RAW_BYTES = ');
    expect(FEED_SERVICE).not.toContain('FEED_DOC_MAX_PER_POST = ');
  });

  it('сервис берёт оба предела из composeDraft', () => {
    expect(FEED_SERVICE).toContain(
      "import { FEED_MAX_DOC_BYTES, FEED_MAX_DOCS, FEED_POST_MAX_BYTES } from './composeDraft';"
    );
    expect(FEED_SERVICE).toContain('if (size > FEED_MAX_DOC_BYTES) {');
    expect(FEED_SERVICE).toContain('opts.documents.slice(0, FEED_MAX_DOCS)');
  });

  it('предел всей записи вынесен из тела функции наружу', () => {
    expect(SRC('social/composeDraft.ts')).toContain('export const FEED_POST_MAX_BYTES = ');
    // Локальной переменной с этим числом больше нет — ни здесь, ни где-то ещё.
    expect(FEED_SERVICE).not.toContain('const SAFE_LIMIT');
    expect(FEED_SERVICE).toContain('if (estimatedBytes > FEED_POST_MAX_BYTES) {');
  });

  it('проверка публикации считает ровно по вынесенной константе', () => {
    // Значение не переехало по дороге: 90 % от двух мегабайт, округление вниз.
    expect(FEED_POST_MAX_BYTES).toBe(Math.floor(2 * 1024 * 1024 * 0.9));
    expect(FEED_POST_MAX_BYTES).toBe(1_887_436);
  });
});

describe('текст называет то же число, что и проверка', () => {
  it('в ru.json подписей размера не осталось вовсе', () => {
    // Тот самый пробел в стороже v4.32.422: он смотрит только .ts/.tsx.
    expect(RU_RAW).not.toMatch(/[0-9][.,]?[0-9]*\s*(КБ|МБ|ГБ)/);
  });

  it('обе строки просят подстановку', () => {
    expect(RU.feed.postTooLargeDetail).toContain('превышает лимит {{limit}}.');
    expect(RU.feed.docSkippedTooBig).toContain('Тяжелее {{limit}} —');
  });

  it('экран подставляет предел во все три места', () => {
    expect(FEED_SCREEN).toContain(
      "t('feed.postTooLargeDetail', { limit: formatLimit(FEED_POST_MAX_BYTES) })"
    );
    expect(FEED_SCREEN).toContain(
      "t('feed.docSkippedTooBig', { count: tooBig, limit: formatLimit(FEED_MAX_DOC_BYTES) })"
    );
    // Ни одного зова без подстановки: иначе человек увидит «{{limit}}».
    expect(FEED_SCREEN).not.toContain("t('feed.postTooLargeDetail')");
    expect(FEED_SCREEN).not.toContain("t('feed.docSkippedTooBig', { count: tooBig })");
  });

  it('подставится ровно то, что стояло словами до правки', () => {
    expect(formatLimit(FEED_POST_MAX_BYTES)).toBe('1,8 МБ');
    expect(formatLimit(FEED_MAX_DOC_BYTES)).toBe('1,2 МБ');
  });

  it('подпись не обещает больше, чем пропустит проверка', () => {
    // Дом требует округления вниз именно ради этого: файл ровно на названном
    // пределе обязан проходить.
    const namedDoc = 1.2 * 1_000_000;
    expect(namedDoc).toBeLessThanOrEqual(FEED_MAX_DOC_BYTES);
    const namedPost = 1.8 * 1_000_000;
    expect(namedPost).toBeLessThanOrEqual(FEED_POST_MAX_BYTES);
  });
});

describe('до правки было верно и осталось верно', () => {
  it('отбор документов в экране пропускает и отвергает по тем же границам', () => {
    const under = { uri: 'file://a', name: 'a.pdf', size: FEED_MAX_DOC_BYTES };
    const over = { uri: 'file://b', name: 'b.pdf', size: FEED_MAX_DOC_BYTES + 1 };
    const r = selectComposeDocs([under, over], 0);
    expect(r.picked).toHaveLength(1);
    expect(r.tooBig).toBe(1);
    expect(r.noRoom).toBe(0);
  });

  it('больше трёх документов к записи по-прежнему не берут', () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ uri: `file://${n}`, name: `${n}.pdf`, size: 10 }));
    const r = selectComposeDocs(many, 0);
    expect(r.picked).toHaveLength(FEED_MAX_DOCS);
    expect(r.noRoom).toBe(2);
  });

  it('остальной текст обоих сообщений не тронут', () => {
    expect(RU.feed.postTooLargeDetail).toContain('Уменьшите количество фото или сократите текст.');
    expect(RU.feed.docSkippedTooBig).toContain('Такой файл не поместится в запись.');
    expect(RU.feed.docSkippedTooBig).toContain('{{count}}');
  });
});
