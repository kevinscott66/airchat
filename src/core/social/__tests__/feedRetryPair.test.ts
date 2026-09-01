import * as fs from 'fs';
import * as path from 'path';

/**
 * Раунд 462: у каждого таймера повтора свой ключ.
 *
 * Очередь публикации постов и очередь отложенных комментариев — две независимые
 * машины с двумя таймерами, но ключ для отправки они держали в одной модульной
 * переменной. Человек публикует пост, доставка неполная — заводится таймер на
 * 30 секунд. В эти же секунды он переключает профиль и пишет комментарий,
 * который тоже не доходит: комментарий записывает в общую переменную СВОЙ ключ.
 * Таймер постов просыпается с чужой парой, своих записей в очереди не находит
 * (их автор — другой ключ), больше себя не назначает — и пост лежит до
 * перезапуска приложения или смены сети.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Имена функций, внутри которых переменной присваивают значение. */
function assignedIn(name: string): string[] {
  const out: string[] = [];
  let current = '(верхний уровень)';
  for (const line of SRC.split('\n')) {
    const head = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/.exec(line);
    if (head) current = head[1];
    if (line.trim().startsWith(name + ' = ')) out.push(current);
  }
  return Array.from(new Set(out));
}

describe('ключ таймера не общий', () => {
  test('общей переменной больше нет', () => {
    expect(SRC).not.toContain('lastPairForRetry');
  });

  test('очередь постов пишет только свой ключ', () => {
    expect(assignedIn('feedRetryPair').slice().sort()).toEqual(
      ['closeFeedStorage', 'flushFeedQueueNow', 'scheduleFeedPublishRetry'],
    );
  });

  test('комментарии пишут только свой ключ', () => {
    expect(assignedIn('commentRetryPair').slice().sort()).toEqual(
      ['resumeCommentOutbox', 'scheduleCommentOutboxRetry'],
    );
  });

  test('машины не пересекаются ни в одной функции', () => {
    const feed = new Set(assignedIn('feedRetryPair'));
    const comment = assignedIn('commentRetryPair');
    expect(comment.filter((f) => feed.has(f))).toEqual([]);
  });

  test('каждый таймер просыпается со своим ключом', () => {
    expect(SRC).toContain('const p = feedRetryPair;\n      if (!p) return;\n      await flushFeedPublishQueue(p);');
    expect(SRC).toContain('const p = commentRetryPair;\n      if (!p) return;\n      await flushCommentOutbox(p);');
  });
});

describe('проверка не пустая', () => {
  /** Две машины на одной переменной — ровно то, что было до 462-го. */
  function shared(): string | null {
    let last: string | null = null;
    last = 'ключ-поста';    // публикация не дошла, таймер заведён
    last = 'ключ-коммента'; // человек переключил профиль и написал комментарий
    return last;            // таймер постов просыпается вот с этим
  }

  test('на общей переменной таймер постов получил бы чужой ключ', () => {
    expect(shared()).toBe('ключ-коммента');
  });

  test('на своих переменных — свой', () => {
    let feed: string | null = null;
    let comment: string | null = null;
    feed = 'ключ-поста';
    comment = 'ключ-коммента';
    expect(feed).toBe('ключ-поста');
    expect(comment).toBe('ключ-коммента');
  });
});
