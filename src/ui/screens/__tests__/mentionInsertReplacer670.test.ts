import fs from 'fs';
import path from 'path';

const FEED = () =>
  fs.readFileSync(path.join(__dirname, '..', 'FeedScreen.tsx'), 'utf8');

/** Убирает строки-комментарии, чтобы русские пояснения не подменяли собой код. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

function countOf(src: string, needle: string): number {
  let n = 0;
  let i = src.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = src.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('подстановка упоминания в ленте не толкует имя как шаблон замены', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: исходник экрана читается', () => {
    const code = codeOnly(FEED());
    expect(code.length).toBeGreaterThan(100000);
    expect(code).toContain('mentionSuggestions.map(({ name, did, insert }) => (');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: в подсказку попадает произвольное имя собеседника', () => {
    const code = codeOnly(FEED());
    expect(code).toContain(
      "insert: normalizeUsername(c.peerUsername) ?? c.displayName ?? ''"
    );
  });

  it('замена задана функцией, а не строкой', () => {
    const code = codeOnly(FEED());
    expect(code).toContain(
      'draft.replace(/@([a-zа-яё0-9_.]*)$/i, () => `@${insert} `)'
    );
    // Подстановка имени в ленте ровно одна.
    expect(countOf(code, '@${insert}')).toBe(1);
    // Всего в композере три замены черновика: тег, эмодзи и упоминание.
    expect(countOf(code, 'draft.replace(/')).toBe(3);
  });

  it('поведение: строка-замена толкует $-последовательности, функция — нет', () => {
    const draft = 'привет @sa';
    const re = /@([a-zа-яё0-9_.]*)$/i;
    const insert = '$&$`';

    const asString = draft.replace(re, `@${insert} `);
    const asFunction = draft.replace(re, () => `@${insert} `);

    expect(asFunction).toBe('привет @$&$` ');
    expect(asString).not.toBe(asFunction);
  });
});
