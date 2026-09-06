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
