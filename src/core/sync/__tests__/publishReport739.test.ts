/**
 * v4.32.739: «Публикация отправлена» перестала говориться зря.
 *
 * Дефект. Разбор исхода публикации отвечал на вопрос «что делать дальше»
 * (`PublishDisposition`), и этого ответа было достаточно ленте, но не человеку.
 * Три разных исхода приходили на экран одним `{ ok: true, cid }`:
 *
 *  1. Дошло до всех — правда.
 *  2. Адресатов нет вовсе. Ровно этот случай docblock `publishOutcome.ts`
 *     запрещал показывать как «отправлено» с самого своего появления, но запрет
 *     остался словами: `isDelivered` не звали ниоткуда, кроме её же теста.
 *  3. Дошло не до всех, и очередь повторов запись не приняла. Очередь у
 *     публикации единственная — её отказ значит, что до недоставленных пост не
 *     дойдёт уже никогда. Отказ уходил в `log.warn`, а наружу шло «отправлено».
 *
 * Отдельно: опрос в ленте вызывал `publishFeedPost(...).then(() => …)` и ответ
 * выбрасывал целиком. `publishFeedPost` на неудаче не бросает — возвращает
 * `{ ok: false }`, — и оптимистичный опрос просто исчезал с экрана: ни «слишком
 * большой», ни «не ушло никому» человек не видел.
 *
 * Поведение проверяется на `publishOutcome.ts` — он чистый и импортируется. То,
 * что исход доходит до ленты и до экрана, проверяется по исходнику: feedService
 * тянет транспорт, а FeedScreen — React Native.
 */

import fs from 'fs';
import path from 'path';

import {
  isDelivered,
  needsRetryQueue,
  reportOf,
  type BroadcastAttempt,
  type PublishReport,
} from '../publishOutcome';

const ATTEMPTS: BroadcastAttempt[] = [
  'skipped-offline',
  'no-recipients',
  // v4.32.752: «адресатов выяснить не удалось» — отдельный исход, не пустой
  // список. Судьба у него как у «нет сети»: повторять.
  'unknown-recipients',
  'failed',
  'partial',
  'complete',
];

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

describe('исход называется словом, которое можно показать человеку', () => {
  it('«некому» — отдельный ответ, а не доставка', () => {
    expect(reportOf('no-recipients', false)).toBe<PublishReport>('local-only');
    expect(reportOf('no-recipients', true)).toBe<PublishReport>('local-only');
    // Тот самый запрет из docblock модуля, теперь исполнимый.
    expect(isDelivered('no-recipients')).toBe(false);
  });

  it('дошло до всех — и только это «отправлено»', () => {
    expect(reportOf('complete', false)).toBe<PublishReport>('delivered');
    expect(ATTEMPTS.filter((a) => reportOf(a, true) === 'delivered')).toEqual(['complete']);
  });

  it('отказ очереди отличается от принятой очереди', () => {
    for (const a of ATTEMPTS.filter(needsRetryQueue)) {
      expect(reportOf(a, true)).toBe<PublishReport>('queued');
      expect(reportOf(a, false)).toBe<PublishReport>('stranded');
    }
  });

  it('«в очереди» не может выйти там, где очереди нет', () => {
    for (const a of ATTEMPTS.filter((x) => !needsRetryQueue(x))) {
      expect(reportOf(a, true)).not.toBe<PublishReport>('queued');
      expect(reportOf(a, true)).not.toBe<PublishReport>('stranded');
    }
  });
});

describe('исход доходит до вызывающего', () => {
  it('тип ответа требует назвать его у каждого успеха', () => {
    expect(FEED).toContain('| { ok: true; cid: string; report: PublishReport; mediaDropped?: number }');
    expect(FEED).toContain("| { ok: true; queued: true; report: 'queued'; mediaDropped?: number }");
    // Прежние формы успеха без исхода.
    expect(FEED).not.toContain('| { ok: true; cid: string; mediaDropped?: number }');
    expect(FEED).not.toContain('| { ok: true; queued: true; mediaDropped?: number }');
  });

  it('внутренний результат раздвоен: где есть postId, там обязан быть исход', () => {
    expect(FEED).toContain(
      '| { postId: string; tooLarge?: false; report: PublishReport; mediaDropped?: number };'
    );
    expect(FEED).not.toContain('  postId: string | null;');
  });

  it('отказ очереди перестал быть только строкой в журнале', () => {
    const at = FEED.indexOf("log.info('feed_publish_partial'");
    expect(at).toBeGreaterThan(-1);
    const branch = FEED.slice(at, at + 1400);
    expect(branch).toContain('let queueAccepted = false;');
    // Отметка ставится ПОСЛЕ записи в очередь — до неё она ничего не значит.
    expect(branch.indexOf('await enqueuePendingFeedPost(')).toBeLessThan(
      branch.indexOf('queueAccepted = true;')
    );
    expect(branch).toContain('return { postId, report: reportOf(attempt, queueAccepted), mediaDropped };');
  });

  it('«контактов нет» больше не уходит наружу как обычный успех', () => {
    const at = FEED.indexOf("log.info('feed_publish_local_only'");
    expect(at).toBeGreaterThan(-1);
    expect(FEED.slice(at, at + 260)).toContain('report: reportOf(attempt, false)');
  });

  it('репост отвечает тем же словарём', () => {
    expect(FEED).toContain(
      'return { ok: true, cid: newPostId, queued: true, report: reportOf(attempt, true), ...dropped };'
    );
    expect(FEED).toContain('return { ok: true, cid: newPostId, report: reportOf(attempt, false), ...dropped };');
    expect(FEED).not.toContain('return { ok: true, cid: newPostId, ...dropped };');
    expect(FEED).not.toContain('return { ok: true, cid: newPostId, queued: true, ...dropped };');
  });
});

describe('экран говорит то, что произошло', () => {
  it('у каждого исхода свои слова', () => {
    expect(SCREEN).toContain('function announcePublishResult(');
    const at = SCREEN.indexOf('function announcePublishResult(');
    const body = SCREEN.slice(at, SCREEN.indexOf('\nfunction FeedScreenImpl', at));
    expect(body).toContain("case 'delivered':");
    expect(body).toContain("case 'local-only':");
    expect(body).toContain("case 'queued':");
    expect(body).toContain("case 'stranded':");
    expect(body).toContain("showSuccess(t('feed.publishedLocalOnly'));");
    expect(body).toContain("showError(t('feed.publishedStranded'));");
    expect(body).toContain("'cid' in result ? t('feed.publishedPartialQueued') : t('feed.publishedQueued')");
  });

  it('пост и опрос проходят через один разбор', () => {
    expect(SCREEN.split('announcePublishResult(result, t);').length - 1).toBe(2);
  });

  it('опрос читает ответ, а не выбрасывает его', () => {
    const at = SCREEN.indexOf('void publishFeedPost(pair, { text: pollText })');
    expect(at).toBeGreaterThan(-1);
    const branch = SCREEN.slice(at, at + 900);
    expect(branch).toContain('.then((result) => {');
    expect(branch).toContain('if (result.ok) {');
    expect(branch).toContain("showError(t('feed.publishFailed'));");
    // Прежняя форма: ответ не принимался вовсе.
    expect(branch).not.toContain('.then(() => {');
  });

  it('все четыре текста есть и различаются', () => {
    const keys = ['published', 'publishedQueued', 'publishedPartialQueued', 'publishedLocalOnly', 'publishedStranded'];
    for (const k of keys) expect(typeof RU.feed[k]).toBe('string');
    expect(new Set(keys.map((k) => RU.feed[k])).size).toBe(keys.length);
    // «Отправлено» не должно звучать там, где отправлять было некому.
    expect(RU.feed.publishedLocalOnly).not.toContain('отправлена');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитаны, словарь исходов на месте', () => {
    // Всё здесь — то, чего правка не касалась: обязано проходить и до неё.
    expect(FEED.length).toBeGreaterThan(10000);
    expect(SCREEN.length).toBeGreaterThan(10000);
    expect(ATTEMPTS).toHaveLength(6);
    expect(needsRetryQueue('partial')).toBe(true);
    expect(needsRetryQueue('no-recipients')).toBe(false);
    expect(RU.feed.published).toBe('Публикация отправлена');
  });
});
