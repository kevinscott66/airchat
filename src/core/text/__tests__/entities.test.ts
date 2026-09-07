import { collectHashtags, collectUrls, findEntities, hashtagNameOf, mentionNameOf } from '../entities';

const kinds = (s: string): string[] => findEntities(s).map((e) => `${e.kind}:${e.text}`);

describe('findEntities: ссылки', () => {
  it('точка в конце предложения не входит в адрес', () => {
    expect(kinds('зайди на https://example.com.')).toEqual(['url:https://example.com']);
  });

  it('запятая и восклицательный знак тоже остаются снаружи', () => {
    expect(kinds('https://a.io, и https://b.io!')).toEqual(['url:https://a.io', 'url:https://b.io']);
  });

  it('парная скобка внутри адреса сохраняется', () => {
    expect(kinds('https://ru.wikipedia.org/wiki/Ключ_(криптография)'))
      .toEqual(['url:https://ru.wikipedia.org/wiki/Ключ_(криптография)']);
  });

  it('лишняя закрывающая скобка отрезается', () => {
    expect(kinds('(см. https://example.com/x)')).toEqual(['url:https://example.com/x']);
  });

  it('отрезанный хвост остаётся в тексте', () => {
    const [e] = findEntities('см. https://example.com.');
    expect(e.end).toBe('см. https://example.com'.length);
  });

  it('схема без хоста не ссылка', () => {
    expect(kinds('https:// пусто')).toEqual([]);
  });

  it('адрес, приклеенный к слову, ссылкой не считается', () => {
    // Та же граница слова, что защищает `alice@bob.com` от разбора в
    // упоминание: сущность начинается там, где кончилось предыдущее слово.
    expect(kinds('xhttps://example.com')).toEqual([]);
    expect(kinds('ссылка:https://example.com')).toEqual(['url:https://example.com']);
  });
});

describe('findEntities: упоминания', () => {
  it('точка после имени не часть имени', () => {
    expect(kinds('спроси у @bob.')).toEqual(['mention:@bob']);
  });

  it('почтовый адрес упоминанием не считается', () => {
    expect(kinds('alice@bob.com')).toEqual([]);
  });

  it('кириллическое имя разбирается', () => {
    expect(kinds('привет @Аня')).toEqual(['mention:@Аня']);
  });

  it('подчёркивание — часть имени', () => {
    expect(kinds('@bob_smith привет')).toEqual(['mention:@bob_smith']);
  });
});

describe('findEntities: теги', () => {
  it('тег и хвостовой дефис', () => {
    expect(kinds('#новости- дальше')).toEqual(['hashtag:#новости']);
  });

  it('решётка внутри слова не тег', () => {
    expect(kinds('C#5 и #ре')).toEqual(['hashtag:#ре']);
  });
});

describe('findEntities: порядок и пересечения', () => {
  it('сущности не пересекаются и идут по возрастанию', () => {
    const found = findEntities('#a https://x.io @b #c');
    let prev = -1;
    for (const e of found) {
      expect(e.start).toBeGreaterThanOrEqual(prev);
      expect(e.end).toBeGreaterThan(e.start);
      prev = e.end;
    }
    expect(found.map((e) => e.kind)).toEqual(['hashtag', 'url', 'mention', 'hashtag']);
  });

  it('срез по start/end совпадает с text', () => {
    const raw = 'тег #дом, ссылка https://a.io/b) и @аня.';
    for (const e of findEntities(raw)) expect(raw.slice(e.start, e.end)).toBe(e.text);
  });
});

describe('имена', () => {
  it('снимают приставку', () => {
    expect(mentionNameOf('@bob')).toBe('bob');
    expect(hashtagNameOf('#дом')).toBe('дом');
  });
});

describe('сборщики списков', () => {
  it('тег в списке тот же, что нарисован в тексте', () => {
    expect(collectHashtags('#Новости-дня и #спорт, а #тег- с дефисом на конце')).toEqual([
      '#новости-дня',
      '#спорт',
      '#тег',
    ]);
  });

  it('адрес в списке тот же, что открывается по нажатию', () => {
    expect(collectUrls('см. https://example.com. и (https://a.io/x)')).toEqual([
      'https://example.com',
      'https://a.io/x',
    ]);
  });

  it('в тексте без сущностей списки пустые', () => {
    expect(collectHashtags('просто текст')).toEqual([]);
    expect(collectUrls('просто текст')).toEqual([]);
  });
});

/**
 * Прежний, наивный отрез хвоста: на каждый снятый знак баланс скобок считался
 * заново по всему остатку. Держим его в тесте как образец смысла — новый
 * линейный отрез обязан давать ровно тот же ответ.
 */
function trimUrlEndNaive(url: string): string {
  const TRAILING = new Set([...'.,;:!?…«»„“”‘’\'"*_~<>']);
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (ch === undefined) break;
    if (TRAILING.has(ch)) { end -= 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const head = url.slice(0, end);
      let depth = 0;
      for (const c of head) {
        if (c === open) depth += 1;
        else if (c === ch) depth -= 1;
      }
      if (depth < 0) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

describe('хвост адреса отрезается за один проход', () => {
  /** Простой детерминированный генератор — тест не должен зависеть от Math.random. */
  const rnd = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  it('ответ совпадает с наивным отрезом на всех формах хвоста', () => {
    const next = rnd(20250907);
    const alphabet = [...'()[]{}.,;:!?abc/'];
    const cases: string[] = [
      'https://a.io/x',
      'https://a.io/x)',
      'https://a.io/x(y)',
      'https://a.io/x(y))',
      'https://a.io/(a[b]c)',
      'https://a.io/x].',
      'https://a.io/}}}',
      'https://a.io/[x](y).,!',
    ];
    for (let i = 0; i < 400; i += 1) {
      let tail = '';
      const len = 1 + Math.floor(next() * 12);
      for (let j = 0; j < len; j += 1) tail += alphabet[Math.floor(next() * alphabet.length)];
      cases.push(`https://a.io/${tail}`);
    }
    for (const url of cases) {
      const [e] = findEntities(url);
      const expected = trimUrlEndNaive(url);
      // Слишком короткий остаток сущностью не считается — образец тоже это учитывает.
      if (expected.length < 2) expect(e).toBeUndefined();
      else expect(e?.text).toBe(expected);
    }
  });

  it('разбор длинного хвоста скобок не квадратичен', () => {
    // Отправитель волен прислать что угодно в пределах MAX_MESSAGE_TEXT = 64 000.
    // Наивный отрез съедал на этом 11,6 с на V8; линейный укладывается в
    // единицы миллисекунд, и запас до предела ниже — на три порядка.
    const text = `https://a.io/${')'.repeat(60_000)}`;
    const started = Date.now();
    expect(collectUrls(text)).toEqual(['https://a.io/']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
