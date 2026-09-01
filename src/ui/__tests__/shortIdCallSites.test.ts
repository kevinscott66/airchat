/**
 * Храповик на сокращение личности.
 *
 * v4.32.425. Подпись «кто это, если имени нет» была записана двенадцатью
 * способами, и три из них врали. Чинить двенадцать копий бессмысленно, если
 * тринадцатую можно дописать завтра, — поэтому здесь запрещены сами формы, из
 * которых копия складывается: срез с головы И с хвоста в одной строке, и срез
 * идентификатора личности в экранном слое.
 *
 * Проверка нарочно узкая. Срез ключа в журнале (`postId.slice(0, 24)`) —
 * законное сокращение: журнал читает разработчик, а не собеседник, и там
 * важна не различимость людей, а длина строки. Поэтому правило действует
 * только на `src/ui` — слой, который рисует то, что человек прочитает как имя.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Единственное место, где личность вправе резать. */
const HOME = 'ui/identity/shortId.ts';

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

/** Строки файла без комментариев: упоминание в комментарии — не код. */
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

const FILES = collect(SRC).map((full) => ({
  key: relKey(full),
  lines: codeLines(readFileSync(full, 'utf8')),
}));

/** Голова и хвост в одной строке — это и есть «своё сокращение личности». */
function isHeadTail(line: string): boolean {
  return line.includes('.slice(0') && line.includes('.slice(-');
}

/**
 * Срез значения, чьё имя кончается на «did», «pub» или «key».
 *
 * Именно кончается: «candidates.slice(0, MAX)» содержит «did» внутри слова, а
 * режет список кандидатов, а не личность.
 */
const IDENTITY_SLICE = /[A-Za-z0-9_$.]*(?:[Dd]id|[Pp]ub(?:B64)?|[Pp]ublicKey|[Kk]ey)\.slice\(/;

describe('личность сокращается в одном месте', () => {
  it('файлы вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map((f) => f.key)).toContain(HOME);
  });

  it('никто, кроме shortId, не берёт голову и хвост одной строкой', () => {
    const offenders = FILES.filter((f) => f.key !== HOME && f.lines.some(isHeadTail)).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('экранный слой не режет идентификатор личности сам', () => {
    // testID исключён намеренно: это опора для теста, а не текст на экране,
    // и менять его — значит ломать поиск элемента, ничего не починив.
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f.key === HOME || !f.key.startsWith('ui/')) continue;
      for (const line of f.lines) {
        if (line.includes('testID')) continue;
        if (IDENTITY_SLICE.test(line)) offenders.push(`${f.key}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('запрещённые формы действительно опознаются', () => {
    // Невырожденность: без этого проверки выше зелены и на пустом правиле.
    expect(isHeadTail('return `${did.slice(0, 12)}…${did.slice(-6)}`;')).toBe(true);
    expect(IDENTITY_SLICE.test('const name = m.displayName ?? m.peerPubB64.slice(0, 8);')).toBe(true);
    expect(IDENTITY_SLICE.test('const short = did.slice(0, 16);')).toBe(true);
    expect(IDENTITY_SLICE.test('contactLabel(c.displayName, c.peerPublicKey.slice(0, 16))')).toBe(true);
  });

  it('законные срезы под правило не попадают', () => {
    // Обратная невырожденность: правило, ловящее всё подряд, пришлось бы
    // обвесить исключениями, и оно перестало бы что-либо значить.
    expect(isHeadTail("const preview = item.text.slice(0, 60) + '…';")).toBe(false);
    expect(IDENTITY_SLICE.test('const top = candidates.slice(0, MAX_CANDIDATES);')).toBe(false);
    expect(IDENTITY_SLICE.test('const head = keys.slice(0, 3);')).toBe(false);
    expect(IDENTITY_SLICE.test("const preview = item.text.slice(0, 60) + '…';")).toBe(false);
  });

  it('сокращение зовут отовсюду, где раньше было своё', () => {
    // Если завтра импорт останется в одном файле, значит копии вернулись
    // куда-то ещё — и предыдущие проверки об этом уже не расскажут.
    const users = FILES.filter((f) => f.lines.some((l) => l.includes("identity/shortId'"))).map((f) => f.key);
    expect(users.length).toBeGreaterThanOrEqual(15);
  });
});
