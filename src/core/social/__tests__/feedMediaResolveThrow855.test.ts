/**
 * Дефект: `resolveFeedMediaUri` не ловила бросок чтения вложения.
 *
 * Цена несоразмерна причине. Единственный вызов этой функции — задача внутри
 * `runWithConcurrency`, а тот при первом же отказе теряет результаты ВСЕХ
 * задач: пул отдаёт массив только после `Promise.all`, и отказ одной задачи
 * уносит уже посчитанное остальными. Дальше отказ поднимался в `loadFeed`,
 * где его молча проглатывал `catch` с одной строкой в журнал. Итог: лента
 * показывала записи вообще без снимков и, поскольку счётчики комментариев и
 * просмотров читаются ниже в том же блоке, без единого числа под записями.
 * Повторялось при каждом обновлении — битое вложение само не чинится.
 *
 * База при этом закрыта не по ошибке: её закрывают выгрузка в облачное
 * хранилище, восстановление и «выйти и удалить данные» (v4.32.853), а лента
 * в этот момент остаётся на экране.
 *
 * Правка: чтение обёрнуто в `try`, отказ возвращает пустую строку — тот же
 * исход, что уже был у битой ссылки и пропавшего вложения. Слот останется
 * незагруженным, и с v4.32.852 об этом сказано прямо.
 *
 * Правило здесь не «в этой строке стоит try», а «ни один `await` этой функции
 * не остаётся без защиты»: допишут второе чтение — оно попадёт под то же
 * требование само.
 */
import fs from 'fs';
import path from 'path';
import { runWithConcurrency } from '../../utils/runWithConcurrency';

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const FEED = codeOnly(read('core', 'social', 'feedService.ts'));
const POOL = codeOnly(read('core', 'utils', 'runWithConcurrency.ts'));
const SCREEN = codeOnly(read('ui', 'screens', 'FeedScreen.tsx'));

/** Текст от открывающей скобки `at` до парной ей закрывающей включительно. */
function block(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

function bodyOf(src: string, header: string): string {
  const at = src.indexOf(header);
  expect(at).toBeGreaterThan(-1);
  return block(src, src.indexOf('{', at));
}

/** Диапазоны [начало, конец) всех блоков `try { … }` внутри текста. */
function tryRanges(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\btry \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    out.push([open, open + block(body, open).length]);
  }
  return out;
}

/** Смещения всех `await` в теле, до которых не добрался ни один `try`. */
function unguardedAwaits(body: string): number[] {
  const ranges = tryRanges(body);
  const out: number[] = [];
  const re = /\bawait /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!ranges.some(([a, b]) => m!.index > a && m!.index < b)) out.push(m.index);
  }
  return out;
}

const RESOLVE = (): string => bodyOf(FEED, 'export async function resolveFeedMediaUri(');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('функция находится, и в ней вправду есть что защищать', () => {
    const body = RESOLVE();
    expect(body).toContain('kvGetInlineAttachment(');
    expect(body.match(/\bawait /g)?.length).toBeGreaterThan(0);
  });

  it('разбор `try` не слепой: без обёртки тот же await считается незащищённым', () => {
    expect(unguardedAwaits('{ const a = await f(); }')).toHaveLength(1);
    expect(unguardedAwaits('{ try { const a = await f(); } catch { } }')).toHaveLength(0);
  });
});

describe('чтение вложения не роняет разбор', () => {
  it('ни один await не остаётся без try', () => {
    expect(unguardedAwaits(RESOLVE())).toEqual([]);
  });

  it('отказ отвечает пустой строкой — тем же, чем битая ссылка и пропажа', () => {
    const body = RESOLVE();
    const t = body.indexOf('catch (e) {');
    expect(t).toBeGreaterThan(-1);
    const c = block(body, body.indexOf('{', t + 'catch (e)'.length));
    expect(c).toContain("return '';");
    expect(c).toContain('log.warn(');
  });

  it('отказ встал в один ряд с прежними исходами, а не завёл свой', () => {
    const body = RESOLVE();
    // Битая ссылка, битый разделитель, пропавшее вложение — и теперь отказ
    // чтения. Один ответ на все четыре: показывать нечего.
    expect(body.match(/return '';/g)).toHaveLength(4);
  });
});

describe('цена отказа в пуле — на живом пуле, а не на словах', () => {
  it('одна упавшая задача уносит результаты всех остальных', async () => {
    const done: number[] = [];
    await expect(
      runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error('одно вложение не прочиталось');
        done.push(n);
        return n * 10;
      }),
    ).rejects.toThrow('одно вложение не прочиталось');
    // Работа была сделана — а вернуть её пулу уже нечем.
    expect(done.length).toBeGreaterThan(0);
  });

  it('та же задача с собственным try — и пакет цел', async () => {
    const out = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      try {
        if (n === 2) throw new Error('одно вложение не прочиталось');
        return n * 10;
      } catch {
        return null;
      }
    });
    expect(out).toEqual([10, null, 30, 40]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('пул по-прежнему без защиты на задачу — чинить надо было в задаче', () => {
    expect(POOL).toContain('results[i] = await fn(items[i], i);');
    // Ни одного try во всём модуле: защищать задачу — дело самой задачи.
    expect(POOL).not.toContain('try {');
    expect(unguardedAwaits(POOL).length).toBeGreaterThan(0);
  });

  it('вызов у ленты один — он же задача пула', () => {
    expect(FEED.match(/resolveFeedMediaUri\(/g)).toHaveLength(2); // объявление и вызов
    const at = FEED.indexOf('await resolveFeedMediaUri(');
    expect(FEED.slice(at - 300, at)).toContain('runWithConcurrency(tasks, FEED_IMAGE_READ_CONCURRENCY');
  });

  it('экран отказ не показывает — он уходит в журнал одной строкой', () => {
    expect(SCREEN).toContain("log.warn('feed_load_failed'");
  });

  it('вместе с медиа терялись и числа под записями: они читаются следом', () => {
    const media = SCREEN.indexOf('const map = await resolveFeedMediaUris(');
    const comments = SCREEN.indexOf('await getFeedCommentCounts(');
    const views = SCREEN.indexOf('await getFeedPostViewCountsMap(');
    expect(media).toBeGreaterThan(-1);
    expect(comments).toBeGreaterThan(media);
    expect(views).toBeGreaterThan(comments);
  });
});
