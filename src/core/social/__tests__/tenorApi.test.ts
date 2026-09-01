/**
 * Подборщик GIF: адрес запроса, разбор ответа, причина отказа (v4.32.364).
 */

import {
  buildTenorUrl,
  classifyTenorStatus,
  mergeGifPages,
  parseTenorPayload,
  tenorFailureMessage,
  tenorKeyFrom,
  TENOR_BASE,
  type TenorGif,
} from '../tenorApi';

const GIF = 'https://media.tenor.com/abc/dancing.gif';
const GIF2 = 'https://media.tenor.com/def/cat.gif';

function result(id: string, formats: Record<string, string>): unknown {
  const media_formats: Record<string, { url: string }> = {};
  for (const [k, v] of Object.entries(formats)) media_formats[k] = { url: v };
  return { id, title: 'т', media_formats };
}

describe('tenorKeyFrom', () => {
  it('без конфига и без ключа — пусто', () => {
    expect(tenorKeyFrom(null)).toBe('');
    expect(tenorKeyFrom({})).toBe('');
    expect(tenorKeyFrom({ publicServices: {} })).toBe('');
  });

  it('пробелы вокруг ключа не считаются ключом', () => {
    // Вставленный из письма ключ часто приезжает с переводом строки.
    expect(tenorKeyFrom({ publicServices: { tenorKey: '  ' } })).toBe('');
    expect(tenorKeyFrom({ publicServices: { tenorKey: ' AIza-x \n' } })).toBe('AIza-x');
  });

  it('нестроковое значение из подсунутого конфига игнорируется', () => {
    expect(tenorKeyFrom({ publicServices: { tenorKey: 42 as unknown as string } })).toBe('');
  });
});

describe('buildTenorUrl', () => {
  it('пустой запрос идёт в featured, непустой — в search', () => {
    expect(buildTenorUrl('K', '   ')).toContain(`${TENOR_BASE}/featured?`);
    expect(buildTenorUrl('K', 'кот')).toContain(`${TENOR_BASE}/search?`);
  });

  it('запрос и ключ кодируются', () => {
    const u = buildTenorUrl('a&b', 'кот с бантом');
    expect(u).toContain('q=%D0%BA%D0%BE%D1%82%20%D1%81%20%D0%B1%D0%B0%D0%BD%D1%82%D0%BE%D0%BC');
    expect(u).toContain('key=a%26b');
  });

  it('курсор страницы кодируется — иначе «&» в нём оборвёт запрос', () => {
    const u = buildTenorUrl('K', 'кот', 'AB&limit=999');
    expect(u).toContain('pos=AB%26limit%3D999');
    expect(u.match(/limit=/g)).toHaveLength(1);
  });

  it('без курсора параметра pos нет', () => {
    expect(buildTenorUrl('K', 'кот')).not.toContain('pos=');
  });
});

describe('parseTenorPayload', () => {
  it('берёт gif, мелкий формат — для сетки', () => {
    const { gifs } = parseTenorPayload({
      results: [result('1', { gif: GIF, nanogif: GIF2 })],
      next: 'CUR',
    });
    expect(gifs).toEqual([{ id: '1', title: 'т', url: GIF, previewUrl: GIF2 }]);
  });

  it('без мелкого формата предпросмотр берёт основной адрес', () => {
    const { gifs } = parseTenorPayload({ results: [result('1', { gif: GIF })] });
    expect(gifs[0].previewUrl).toBe(GIF);
  });

  it('чужой хост отбрасывается целиком, а не отправляется собеседнику', () => {
    // Получатель такой адрес всё равно не откроет (gifEnvelope), так что
    // отправить его — значит послать заведомо пустой пузырь. И сетка не должна
    // сама ходить на чужой сервер.
    const { gifs } = parseTenorPayload({
      results: [
        result('1', { gif: 'https://zlo.example/t.gif' }),
        result('2', { gif: 'https://tenor.com.zlo.example/t.gif' }),
        result('3', { gif: 'http://media.tenor.com/t.gif' }),
        result('4', { gif: GIF }),
      ],
    });
    expect(gifs.map((g) => g.id)).toEqual(['4']);
  });

  it('чужой предпросмотр не тянет за собой всю запись', () => {
    const { gifs } = parseTenorPayload({
      results: [result('1', { gif: GIF, nanogif: 'https://zlo.example/p.gif' })],
    });
    expect(gifs[0].previewUrl).toBe(GIF);
  });

  it('мусор вместо ответа не роняет разбор', () => {
    expect(parseTenorPayload(null)).toEqual({ gifs: [], next: '' });
    expect(parseTenorPayload({ results: 'нет' })).toEqual({ gifs: [], next: '' });
    expect(parseTenorPayload({ results: [null, 5, {}] }).gifs).toEqual([]);
    expect(parseTenorPayload({ results: [], next: 7 }).next).toBe('');
  });

  it('запись без id пропускается — по нему живёт ключ списка', () => {
    expect(parseTenorPayload({ results: [result('', { gif: GIF })] }).gifs).toEqual([]);
  });

  it('длинный заголовок обрезается', () => {
    const long = { id: '1', title: 'я'.repeat(500), media_formats: { gif: { url: GIF } } };
    expect(parseTenorPayload({ results: [long] }).gifs[0].title).toHaveLength(128);
  });

  it('страница длиннее разумного обрезается', () => {
    const many = Array.from({ length: 200 }, (_, i) => result(String(i), { gif: GIF }));
    expect(parseTenorPayload({ results: many }).gifs.length).toBeLessThanOrEqual(60);
  });
});

describe('classifyTenorStatus / tenorFailureMessage', () => {
  it('отказ по ключу не выдаётся за проблему со связью', () => {
    // Ровно этим подборщик и был сломан: демо-ключ v1 в запросе к v2 даёт 400,
    // а человек читал «Проверьте подключение» и чинил Wi-Fi.
    for (const s of [400, 401, 403]) expect(classifyTenorStatus(s)).toBe('key');
    expect(tenorFailureMessage('key')).toContain('ключ');
    expect(tenorFailureMessage('key')).not.toContain('подключение');
  });

  it('перебор запросов и отказ сервера различаются', () => {
    expect(classifyTenorStatus(429)).toBe('rate');
    expect(classifyTenorStatus(500)).toBe('server');
    expect(classifyTenorStatus(503)).toBe('server');
  });

  it('остальное считается сетью', () => {
    expect(classifyTenorStatus(404)).toBe('network');
    expect(tenorFailureMessage('network')).toContain('подключение');
  });
});

describe('mergeGifPages', () => {
  const a: TenorGif = { id: '1', title: '', url: GIF, previewUrl: GIF };
  const b: TenorGif = { id: '2', title: '', url: GIF2, previewUrl: GIF2 };

  it('повтор на границе страниц не задваивается', () => {
    expect(mergeGifPages([a, b], [b]).map((g) => g.id)).toEqual(['1', '2']);
  });

  it('новое добавляется в конец', () => {
    expect(mergeGifPages([a], [b]).map((g) => g.id)).toEqual(['1', '2']);
  });

  it('исходный список не меняется', () => {
    const prev = [a];
    mergeGifPages(prev, [b]);
    expect(prev).toHaveLength(1);
  });
});
