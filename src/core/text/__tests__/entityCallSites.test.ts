/**
 * Храповик на разбор текста.
 *
 * v4.32.605. Ссылку, тег и упоминание искали семь мест: лента, личные чаты,
 * группы, «О себе» в профиле, карточка предпросмотра и обе вкладки «Ссылки» в
 * общих файлах. Выражения разошлись — и расхождение было видно пользователю:
 * подчёркнуто `https://example.com`, а карточка ходила за `https://example.com.`
 * и в списке ссылок лежал тот же адрес с точкой. Тег `#новости-дня` рисовался
 * целиком, а в «в тренде» попадал как `#новости`.
 *
 * Поэтому здесь правило о правиле: искать сущности в тексте умеет ровно один
 * файл — `core/text/entities`. Остальные его зовут.
 *
 * Что НЕ запрещено: выражения, привязанные к концу строки (`$`). Это не поиск
 * по тексту, а хвост того, что человек прямо сейчас печатает, — подсказка в
 * поле ввода. Она смотрит на курсор, а не на сообщение.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');

/** Единственный файл, которому позволено искать сущности в тексте. */
const THE_TOKENIZER = 'core/text/entities.ts';

/** Все .ts/.tsx под src, кроме тестов. */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Строки файла без комментариев: выражение в комментарии — не разбор. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

/** Строка, где есть разбор, не привязанный ни к началу, ни к концу строки. */
function anchored(line: string): boolean {
  return line.includes('^https?') || line.includes('$/');
}

describe('ссылки, теги и имена разбирает один файл', () => {
  const files = collect(SRC).map((f) => ({ key: relKey(f), lines: codeLines(readFileSync(f, 'utf8')) }));

  it('жадный поиск адреса — только в общем разборе', () => {
    // Именно ЖАДНАЯ форма `https?://[^…]+`: она и забирала точку в конце
    // предложения. Проверка «это вообще адрес?» с якорем — не поиск.
    const offenders = files
      .filter((f) => f.key !== THE_TOKENIZER)
      .filter((f) => f.lines.some((l) => l.includes('https?:\\/\\/[^') && !anchored(l)))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('поиск тега и имени — только в общем разборе', () => {
    // Хвост поля ввода (`…$/`) разрешён: это курсор, а не текст сообщения.
    const scanner = /[#@](?:\[|\((?:\?:)?\[)[^\]]*(?:a-z|A-Z|\\w|\\u04)/;
    const offenders = files
      .filter((f) => f.key !== THE_TOKENIZER)
      .filter((f) => f.lines.some((l) => scanner.test(l) && !l.includes('$/')))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('всё, что рисует или собирает текст, зовёт общий разбор', () => {
    // Список — не украшение: если экран выпал отсюда, значит он снова разбирает
    // текст сам, и подчёркнутое на нём разойдётся с тем, что откроется.
    const CALLERS = [
      'ui/components/RichText.tsx',
      'ui/screens/chat-utils/parseText.ts',
      'ui/screens/groups-utils/parseText.ts',
      'ui/screens/ProfileScreen.tsx',
      'ui/screens/chat-components/LinkPreview.tsx',
      'ui/components/modals/chat/ChatSharedMediaModal.tsx',
      'ui/components/modals/groups/GroupSharedMediaModal.tsx',
      'ui/screens/FeedScreen.tsx',
      'ui/screens/GroupsScreen.tsx',
    ];
    const missing = CALLERS.filter((key) => {
      const f = files.find((x) => x.key === key);
      if (!f) return true;
      return !f.lines.some((l) => l.includes("core/text/entities'"));
    });
    expect(missing).toEqual([]);
  });
});
