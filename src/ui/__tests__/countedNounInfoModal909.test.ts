/**
 * «1 символов», «2 слов» в сведениях о сообщении (v4.32.909).
 *
 * Дефект. Оба окна «Сведения о сообщении» — личной переписки и группы —
 * показывают два счётчика столбиком: сверху число крупно, под ним подпись
 * мелко. Подпись была записана одной несклоняемой формой:
 *
 *     <Text …>{chars}</Text>
 *     <Text …>символов</Text>
 *
 * Столбик читается одной строкой, и на коротком сообщении выходило «1
 * символов» и «1 слов», а на двух-четырёх — «2 символов», «3 слов».
 *
 * Цена. Это окно открывают именно затем, чтобы посмотреть на числа, и
 * несогласованное число рядом с ними человек читает как ошибку приложения —
 * ровно то же рассуждение, что в v4.32.899 про «1 контактов» и «1 авт.».
 * Короткие сообщения в переписке — правило, а не исключение: «Да», «Ок»,
 * «+» дают 2, 2 и 1 символ, то есть неверную форму почти всегда.
 *
 * Правка. Обе подписи зовут `ruPlural` — правило в доме одно (core/text,
 * v4.32.421), и соседние счётчики этого же интерфейса уже через него идут.
 *
 * Окна в jest не поднимаются (react-native внутри), поэтому правило
 * проверяется по исходнику — как в countedNounPlural899.
 */
import fs from 'fs';
import path from 'path';

import { ruPlural } from '../../core/text/ruPlural';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');

/**
 * Исходник без пояснений. Пояснение к правке цитирует и старое выражение, и
 * новое, а записано оно внутри разметки — фигурными скобками вокруг обычного
 * блочного комментария, который построчный фильтр по `//` не снимает.
 */
const codeOnly = (rel: string): string =>
  read(rel)
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

const CHAT = 'components/modals/chat/ChatMessageInfoModal.tsx';
const GRP = 'components/modals/groups/GroupMessageInfoModal.tsx';

/** Все .ts/.tsx интерфейса, кроме самих проверок. */
function uiSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(UI, full));
    }
  };
  walk(UI);
  return out;
}

describe('число и слово под ним согласованы', () => {
  it('в личной переписке склоняются оба счётчика', () => {
    const body = codeOnly(CHAT);
    expect(body).toContain("{ruPlural(chars, ['символ', 'символа', 'символов'])}");
    expect(body).toContain("{ruPlural(words, ['слово', 'слова', 'слов'])}");
  });

  it('в группе склоняются оба счётчика', () => {
    const body = codeOnly(GRP);
    expect(body).toContain("{ruPlural(charCount, ['символ', 'символа', 'символов'])}");
    expect(body).toContain("{ruPlural(wordCount, ['слово', 'слова', 'слов'])}");
  });

  it('несклоняемой подписи не осталось ни в одном окне', () => {
    for (const rel of [CHAT, GRP]) {
      const body = codeOnly(rel);
      expect(body).not.toContain('>символов</Text>');
      expect(body).not.toContain('>слов</Text>');
    }
  });

  it('правило берётся из дома, а не переписано по месту', () => {
    for (const rel of [CHAT, GRP]) {
      expect(read(rel)).toContain("import { ruPlural } from '../../../utils/plural';");
      // Ни тернарника по числу, ни своей таблицы форм рядом с подписью.
      expect(codeOnly(rel)).not.toMatch(/=== 1 \? 'символ'/);
    }
  });

  it('несклоняемых подписей-счётчиков не осталось во всём интерфейсе', () => {
    const left = uiSources().filter((rel) => {
      const body = codeOnly(rel);
      return body.includes('>символов</Text>') || body.includes('>слов</Text>');
    });
    expect(left).toEqual([]);
  });
});

describe('до правки было верно и осталось верно', () => {
  it('ruPlural даёт те формы, ради которых правка', () => {
    const ch = ['символ', 'символа', 'символов'] as const;
    const wd = ['слово', 'слова', 'слов'] as const;
    expect(ruPlural(1, ch)).toBe('символ');
    expect(ruPlural(2, ch)).toBe('символа');
    expect(ruPlural(5, ch)).toBe('символов');
    expect(ruPlural(11, ch)).toBe('символов');
    expect(ruPlural(21, ch)).toBe('символ');
    expect(ruPlural(22, ch)).toBe('символа');
    expect(ruPlural(1, wd)).toBe('слово');
    expect(ruPlural(3, wd)).toBe('слова');
    expect(ruPlural(14, wd)).toBe('слов');
  });

  it('пустого счётчика правка не заводит: ноль по-прежнему «символов»', () => {
    // Оба окна показывают счётчики только при непустом тексте, но форма для
    // нуля всё равно должна быть правильной — она же стоит для 5 и больше.
    expect(ruPlural(0, ['символ', 'символа', 'символов'])).toBe('символов');
  });

  it('личная переписка считает так же, как считала', () => {
    const body = codeOnly(CHAT);
    expect(body).toContain('const words = t.split(/\\s+/).filter(Boolean).length;');
    expect(body).toContain('const chars = t.length;');
    expect(body).toContain('{chars}</Text>');
    expect(body).toContain('{words}</Text>');
  });

  it('группа по-прежнему прячет счётчики у опроса, голосового и документа', () => {
    const body = codeOnly(GRP);
    expect(body).toContain('const charCount = isPoll || isVoice || isDoc ? null : msg.text.trim().length;');
    expect(body).toContain('{charCount !== null && wordCount !== null ? (');
  });

  it('заголовок окна не тронут ни там, ни там', () => {
    for (const rel of [CHAT, GRP]) expect(read(rel)).toContain('Сведения о сообщении');
  });

  it('обход интерфейса не пустой', () => {
    const all = uiSources();
    expect(all.length).toBeGreaterThan(100);
    expect(all).toContain(CHAT);
    expect(all).toContain(GRP);
  });
});
