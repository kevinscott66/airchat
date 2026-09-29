/**
 * v4.32.1032: «Репост опубликован» перестало говориться зря.
 *
 * Дефект. Правку v4.32.739 довели до поста и не довели до репоста.
 * `publishRepost` возвращает тот же `PublishFeedResult` с обязательным
 * `report` — четыре исхода, — а лента спрашивала у ответа ровно один вопрос:
 * `'queued' in result`. Четыре ответа сходились в два текста, и зелёное
 * «Репост опубликован» показывалось в трёх случаях из четырёх, включая
 * `stranded`: рассылка провалилась И очередь повторов запись не приняла.
 *
 * Цена. Очередь у репоста — единственный повтор; её отказ значит, что до
 * недоставленных контактов он не дойдёт уже никогда. Отказ этот не выдуман:
 * `updateQueue` бросает, когда запись очереди не прочиталась или не легла
 * (занятая база, нечитаемый ключ профиля), — а репост жмут как раз во время
 * прокрутки ленты. Свидетеля у беды нет, есть анти-свидетель: счётчик очереди
 * покажет ноль, потому что записи в очереди и нет, — то есть подтвердит
 * ложное «всё отправлено». Второй молчащий исход — `local-only`: адресатов не
 * было ни одного, а человек прочитал «опубликован» и больше к этому не
 * вернулся.
 *
 * Правка. У репоста свой разбор на четыре исхода, как у поста: тексты у них
 * разные, а число исходов одно. `stranded` уходит `showError`, потому что это
 * не успех; `local-only` — `showSuccess` с прямым «отправлять некому».
 *
 * Границы. Поведение проверяется на `publishOutcome.ts` — он чистый и
 * импортируется. То, что исход доходит до экрана, проверяется по исходнику:
 * FeedScreen — компонент React Native, а @testing-library/react-native в
 * сборке нет. Пиньоны стоят на том, что у каждого значения `PublishReport`
 * есть своё слово, а не на расположении строк.
 */

import fs from 'fs';
import path from 'path';

import { reportOf, type PublishReport } from '../publishOutcome';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', '..', ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const FEED = codeOnly(read('core', 'social', 'feedService.ts'));
const SCREEN = codeOnly(read('ui', 'screens', 'FeedScreen.tsx'));
const RU = JSON.parse(read('i18n', 'ru.json')) as { feed: Record<string, string> };

/** Исход рассылки → ключ текста, которым лента отвечает за репост. */
const WORDS: Record<PublishReport, string> = {
  delivered: 'feed.repostPublished',
  'local-only': 'feed.repostLocalOnly',
  queued: 'feed.repostQueued',
  stranded: 'feed.repostStranded',
};

/** Тело разбора исходов репоста. */
function announcer(): string {
  const at = SCREEN.indexOf('function announceRepostResult(');
  expect(at).toBeGreaterThan(0);
  const to = SCREEN.indexOf('\nfunction ', at + 10);
  expect(to).toBeGreaterThan(at);
  return SCREEN.slice(at, to);
}

describe('репост говорит то, что с ним случилось', () => {
  it('у каждого исхода есть своё слово, и все они разные', () => {
    const keys = Object.values(WORDS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(SCREEN).toContain(`'${key}'`);
      const short = key.slice('feed.'.length);
      expect(typeof RU.feed[short]).toBe('string');
      expect(RU.feed[short].length).toBeGreaterThan(0);
    }
    // Тексты тоже обязаны различаться: четыре ключа на две одинаковые фразы —
    // то же самое молчание, только в профиль.
    const texts = keys.map((k) => RU.feed[k.slice('feed.'.length)]);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('разбор перечисляет ровно те исходы, что есть в словаре', () => {
    const body = announcer();
    for (const report of Object.keys(WORDS) as PublishReport[]) {
      expect(body).toContain(`case '${report}':`);
      expect(body).toContain(`t('${WORDS[report]}')`);
    }
  });

  it('осиротевший репост не выдаётся за успех', () => {
    // Не `showSuccess`: до части контактов репост не дойдёт уже никогда, и
    // единственное, что человек может сделать, — повторить вручную.
    expect(announcer()).toContain("showError(t('feed.repostStranded'));");
    expect(RU.feed.repostStranded).not.toBe(RU.feed.repostPublished);
  });

  it('репост, которому некому уйти, не называется отправленным', () => {
    expect(announcer()).toContain("showSuccess(t('feed.repostLocalOnly'));");
    expect(RU.feed.repostLocalOnly).not.toBe(RU.feed.repostPublished);
  });

  it('прежней двузначной проверки не осталось', () => {
    // Четыре исхода через `'queued' in result` не проходят: это и был дефект.
    expect(SCREEN).not.toContain("'feed.repostQueued' : 'feed.repostPublished'");
    expect(SCREEN).toContain('announceRepostResult(result, t);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: словарь исходов работает', () => {
  it('непринятая очередь — это stranded, а принятая — queued', () => {
    expect(reportOf('partial', false)).toBe('stranded');
    expect(reportOf('partial', true)).toBe('queued');
    expect(reportOf('skipped-offline', false)).toBe('stranded');
  });

  it('дошло до всех и рассылать некому — разные слова', () => {
    expect(reportOf('complete', false)).toBe('delivered');
    expect(reportOf('no-recipients', false)).toBe('local-only');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('репост доносит исход до экрана во всех трёх успехах', () => {
    expect(FEED).toContain(
      'return { ok: true, cid: newPostId, queued: true, report: reportOf(attempt, true), ...dropped };'
    );
    expect(FEED.split('return { ok: true, cid: newPostId, report: reportOf(attempt, false), ...dropped };').length - 1)
      .toBe(2);
  });

  it('очередь и правда умеет отказать — ветка stranded достижима', () => {
    expect(FEED).toContain("if (current === null) throw new Error(QUEUE_UNAVAILABLE);");
    expect(FEED).toContain('if (!(await savePublishQueue(next))) throw new Error(QUEUE_UNAVAILABLE);');
    expect(FEED).toContain("log.warn('feed_repost_enqueue_failed'");
  });

  it('свидетеля у беды нет: повтор в этой ветке не назначается', () => {
    const at = FEED.indexOf("log.warn('feed_repost_enqueue_failed'");
    expect(at).toBeGreaterThan(0);
    const tail = FEED.slice(at, at + 260);
    expect(tail).not.toContain('scheduleFeedPublishRetry');
  });

  it('у поста этот разбор уже был — репост от него и отстал', () => {
    expect(SCREEN).toContain("showError(t('feed.publishedStranded'));");
    expect(SCREEN).toContain('function announcePublishResult(');
  });

  it('вызов на экране по-прежнему один', () => {
    expect(SCREEN.split('await publishRepost(pair, {').length - 1).toBe(1);
  });
});

describe('ГРАНИЦА: соседние ответы репоста не тронуты', () => {
  it('неудача остаётся неудачей', () => {
    expect(SCREEN).toContain("showError(t('feed.repostFailed'));");
  });

  it('потерянные снимки называются отдельно от исхода рассылки', () => {
    expect(SCREEN).toContain('if (result.mediaDropped && result.mediaDropped > 0) {');
    expect(SCREEN).toContain("t('feed.repostMediaDroppedDetail', { count: result.mediaDropped })");
  });
});
