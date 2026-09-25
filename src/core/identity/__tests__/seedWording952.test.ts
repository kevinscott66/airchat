/**
 * Секретные слова в третий раз назывались словом разработчика (v4.32.952).
 *
 * Дефект. Одну и ту же вещь — двенадцать слов, которыми человек возвращает
 * себе аккаунт, — приложение называет «секретными словами». Так их зовёт весь
 * онбординг (четырнадцать мест), так их зовут настройки (двенадцать). Но три
 * текста, которые человек тоже видит, звали их иначе:
 *
 *     profileManager.ts:615   «Нет сохранённой seed-фразы»
 *     cloudVault.ts:133       «Неверная привязка облачной копии к seed-фразе.»
 *     SettingsScreen:1108     «Копию нечего экспортировать: сид-фраза недоступна»
 *
 * Первые два — брошенные Error из ядра, и до экрана они доходят дословно:
 * userErrorText пускает наружу любой текст с кириллицей, ровно потому что
 * кириллица и есть его признак «это писали для человека». Правило работает как
 * задумано; беда в том, что писали-то не для человека.
 *
 * Цена. Человек, потерявший телефон, ищет в приложении то самое, что записал
 * на бумажке. Онбординг научил его словам «секретные слова». Ошибка отвечает
 * ему про «seed-фразу» — и это, насколько он знает, что-то другое. Хуже всего
 * в облачной копии: текст про «привязку к seed-фразе» не объясняет ни что
 * случилось, ни что делать.
 *
 * Правка. Одни слова везде. Заодно текст про облачную копию стал говорить о
 * деле: копия сделана под другие секретные слова, а не «неверно привязана».
 *
 * Границы. Правило про НАДПИСИ, а не про код: `mnemonic`, `normalizeMnemonic`,
 * `mnemonicCache` — имена, и они остаются. Пояснения в комментариях тоже
 * остаются: они написаны для того, кто читает исходник, и там «seed-фраза» —
 * точное слово. Проверяются только строковые литералы без комментариев.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { userErrorText } from '../../../ui/components/userErrorText';

const SRC = join(__dirname, '..', '..', '..');

/** Все исходники приложения, кроме самих проверок. */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Исходник без комментариев: в них слово разработчика уместно. */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const LITERAL = /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

/** Строковые литералы файла — то, что вообще может оказаться на экране. */
function literalsOf(code: string): string[] {
  const out: string[] = [];
  LITERAL.lastIndex = 0;
  for (let m = LITERAL.exec(code); m !== null; m = LITERAL.exec(code)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Слово разработчика для секретных слов, в любом падеже и написании. */
const DEV_WORD = /(seed[- ]?фраз|сид[- ]?фраз|мнемоническ|мнемо-?фраз)/i;

type Hit = { file: string; text: string };

const hits: Hit[] = [];
const files = collect(SRC);
let literalCount = 0;
for (const full of files) {
  const code = codeOnly(readFileSync(full, 'utf8'));
  const lits = literalsOf(code);
  literalCount += lits.length;
  for (const text of lits) {
    if (DEV_WORD.test(text)) hits.push({ file: relative(SRC, full), text });
  }
}

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход действительно читает надписи', () => {
  it('исходников набралось не меньше трёхсот', () => {
    expect(files.length).toBeGreaterThanOrEqual(300);
  });

  it('строковых литералов в них тысячи, а не десяток', () => {
    expect(literalCount).toBeGreaterThan(5000);
  });

  it('сам разборщик слово разработчика узнаёт', () => {
    expect(literalsOf("const a = 'нет сид-фразы';")).toEqual(['нет сид-фразы']);
    expect(DEV_WORD.test('нет сид-фразы')).toBe(true);
    expect(DEV_WORD.test('Нет сохранённой seed-фразы')).toBe(true);
    expect(DEV_WORD.test('секретные слова')).toBe(false);
  });
});

describe('одно слово на всё приложение', () => {
  it('ни одна надпись не зовёт секретные слова словом разработчика', () => {
    expect(hits.map((h) => `${h.file}: ${h.text}`)).toEqual([]);
  });

  it('три бывших места говорят домашними словами', () => {
    const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
    expect(read(join('core', 'identity', 'profileManager.ts'))).toContain(
      "throw new Error('На устройстве нет секретных слов.');",
    );
    expect(read(join('core', 'backup', 'cloudVault.ts'))).toContain(
      "throw new Error('Облачная копия сделана под другие секретные слова.');",
    );
    expect(read(join('ui', 'screens', 'SettingsScreen.tsx'))).toContain(
      "showError('Копию нечего экспортировать: секретные слова недоступны');",
    );
  });

  it('слова, которые остались, — те самые', () => {
    const settings = readFileSync(join(SRC, 'ui', 'screens', 'SettingsScreen.tsx'), 'utf8');
    expect(settings.split('секретны').length - 1).toBeGreaterThanOrEqual(10);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: текст из ядра по-прежнему доходит до экрана', () => {
  it('кириллический текст ошибки показывается как есть', () => {
    expect(userErrorText(new Error('На устройстве нет секретных слов.'), 'запасной')).toBe(
      'На устройстве нет секретных слов.',
    );
  });

  it('прежний текст дошёл бы точно так же — дело было в словах, не в дороге', () => {
    expect(userErrorText(new Error('Нет сохранённой seed-фразы'), 'запасной')).toBe(
      'Нет сохранённой seed-фразы',
    );
  });

  it('машинный опознаватель по-прежнему заменяется запасным текстом', () => {
    expect(userErrorText(new Error('feed_storage_profile_unset'), 'запасной')).toBe('запасной');
  });

  it('правило не превратилось в запрет слова в комментариях', () => {
    const src = readFileSync(join(SRC, 'core', 'identity', 'usernameRegistry.ts'), 'utf8');
    expect(src).toContain('seed-фразы');
    expect(literalsOf(codeOnly(src)).filter((t) => DEV_WORD.test(t))).toEqual([]);
  });
});
