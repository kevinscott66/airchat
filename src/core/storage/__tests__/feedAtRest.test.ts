/**
 * Лента в шифрованном виде (v4.32.305).
 *
 * Проверяется ровно две вещи, и обе — про молчаливые потери. Первая: перечень
 * колонок. До этой версии база ленты была открытым текстом целиком, и забыть
 * колонку здесь значит вернуть ровно то состояние, только незаметно. Вторая:
 * разбор JSON-колонок. Он теперь стоит ПОСЛЕ расшифровки, а не расшифровавшееся
 * значение приходит пустой строкой — то есть в разбор попадает не «{}», а «».
 */
import {
  FEED_AT_REST_COLUMNS,
  parseJsonColumn,
  parseStringArrayColumn,
} from '../feedAtRest';
import { isSafeSqlIdentifier } from '../atRestColumns';

function columnsOf(table: string): readonly string[] {
  return FEED_AT_REST_COLUMNS.find((s) => s.table === table)?.columns ?? [];
}

describe('перечень шифруемых колонок ленты', () => {
  it('пост: текст, имя автора, имя автора оригинала, вложения, документы, реакции', () => {
    expect([...columnsOf('feed')].sort()).toEqual([
      'author_name',
      'documents',
      'media_cids',
      'reactions',
      'repost_author_name',
      'text',
    ]);
  });

  it('комментарий: текст, имя автора, реакции', () => {
    expect([...columnsOf('feed_comments')].sort()).toEqual(['author_name', 'reactions', 'text']);
  });

  it('просмотры: имя просмотревшего', () => {
    // Тот же список, что stories.viewed_by и group_messages.seen_by: кто молча
    // прочитал. did просмотревшего остаётся открытым — он и так ключ, который
    // виден в базе повсюду; новое здесь именно имя рядом с постом.
    expect([...columnsOf('feed_post_views')]).toEqual(['viewer_name']);
  });

  it('идентификаторы: имена подставляются в SQL напрямую', () => {
    for (const spec of FEED_AT_REST_COLUMNS) {
      expect(isSafeSqlIdentifier(spec.table)).toBe(true);
      expect(spec.columns.length).toBeGreaterThan(0);
      for (const column of spec.columns) expect(isSafeSqlIdentifier(column)).toBe(true);
    }
  });

  it('таблица названа один раз, колонки внутри не повторяются', () => {
    const tables = FEED_AT_REST_COLUMNS.map((s) => s.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const spec of FEED_AT_REST_COLUMNS) {
      expect(new Set(spec.columns).size).toBe(spec.columns.length);
    }
  });
});

describe('разбор JSON-колонок', () => {
  it('массив строк проходит, не массив — нет', () => {
    expect(parseStringArrayColumn('["a","b"]')).toEqual(['a', 'b']);
    expect(parseStringArrayColumn('{"a":1}')).toBeNull();
    expect(parseStringArrayColumn('42')).toBeNull();
  });

  it('пустая строка — это не расшифровавшееся значение, а не пустой список', () => {
    // decryptAtRestString при сбое возвращает ''. JSON.parse('') бросил бы
    // исключение прямо в отрисовке ленты.
    expect(parseStringArrayColumn('')).toBeNull();
    expect(parseStringArrayColumn(null)).toBeNull();
    expect(parseJsonColumn('')).toBeNull();
    expect(parseJsonColumn(null)).toBeNull();
  });

  it('мусор в колонке не роняет чтение', () => {
    expect(parseStringArrayColumn('enc2:zzz')).toBeNull();
    expect(parseJsonColumn('enc2:zzz')).toBeNull();
    expect(parseJsonColumn('{')).toBeNull();
  });

  it('объект и массив объектов проходят: реакции и метаданные документов', () => {
    expect(parseJsonColumn<Record<string, string[]>>('{"👍":["did:a"]}')).toEqual({ '👍': ['did:a'] });
    expect(parseJsonColumn<Array<{ name: string }>>('[{"name":"a.pdf"}]')).toEqual([{ name: 'a.pdf' }]);
  });

  it('литеральный null не превращается в объект', () => {
    // JSON.parse('null') возвращает null — без явной проверки он ушёл бы
    // наружу как «значение есть», и вызывающий получил бы null там, где
    // ожидал Record.
    expect(parseJsonColumn('null')).toBeNull();
  });
});
