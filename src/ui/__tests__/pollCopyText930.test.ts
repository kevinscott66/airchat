/**
 * Результаты опроса в буфере обмена: один текст, а не два (v4.32.930).
 *
 * Дефект. Пузырь опроса написан дважды — в личной переписке и в группе, — и
 * это осознанно: разные права, разные источники голосов. Но текст, который
 * уезжает в буфер по кнопке «скопировать результаты», от переписки не зависит
 * вовсе, и он тоже был написан дважды, разным почерком: `map` + `join` в
 * личном пузыре, `forEach` + `push` в групповом. Вывод совпадал до байта.
 * Значок заголовка был выписан там же ещё четырежды: полной тройкой в двух
 * заголовках и жёстким «📊» в двух копиях текста.
 *
 * Цена. Совпадение до байта — не свойство кода, а состояние на сегодня. В
 * этой самой паре файлов расхождение случалось уже дважды: v4.32.250 («всего
 * голосов» в личном считало галочки, а не людей) и v4.32.254 (счёт по
 * вариантам в списке шёл по людям, а в «скопировать» — по строкам таблицы).
 * Оба раза чинили одну копию из двух. Жёсткое «📊» — след того же: викторина,
 * вставленная в заметки, оказывалась обычным опросом.
 *
 * Правка. `pollResultsText` и `pollIcon` в `ui/utils/pollResultsText`. Считать
 * голоса остаётся каждому пузырю — только у него они на руках; называть их
 * общий текст.
 *
 * Границы. Строка состояния под пузырём («Завершён», «🔒 Без имён») в буфер
 * не уезжает и не уезжала: это про то, что можно делать с опросом здесь.
 * Число в подвале остаётся значением при подписи — «Всего голосов: 12», а не
 * «12 голосов»: весь скопированный текст — столбец «подпись: значение», и
 * фраза посреди него выбивалась бы сильнее, чем согласуется (та же граница,
 * что проведена в v4.32.912 и применена в v4.32.928).
 */
import fs from 'fs';
import path from 'path';

import { pollIcon, pollResultsText } from '../utils/pollResultsText';
import { votesLabel } from '../utils/plural';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const DM = 'ui/screens/chat-components/DmPollBubble.tsx';
const GROUP = 'ui/screens/groups-components/PollBubble.tsx';

/** Как текст собирал личный пузырь до правки. */
function oldDmText(question: string, options: string[], counts: number[], total: number): string {
  const optCounts = options.map((opt, idx) => {
    const cnt = counts[idx];
    const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `${opt}: ${cnt} (${pct}%) ${bar}`;
  });
  return [`📊 ${question}`, '', ...optCounts, '', `Всего голосов: ${total}`].join('\n');
}

/** Как тот же текст собирал групповой пузырь до правки. */
function oldGroupText(question: string, options: string[], counts: number[], total: number): string {
  const lines: string[] = [`📊 ${question}`, ''];
  options.forEach((opt, idx) => {
    const cnt = counts[idx];
    const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    lines.push(`${opt}: ${cnt} (${pct}%) ${bar}`);
  });
  lines.push('', `Всего голосов: ${total}`);
  return lines.join('\n');
}

const PLAIN = {
  question: 'Куда идём?',
  options: ['В парк', 'В кино'],
  counts: [3, 1],
  total: 4,
  isQuiz: false,
  allowMultiple: false,
};

describe('значок опроса один на все четыре места', () => {
  it('викторина, несколько ответов, обычный опрос', () => {
    expect(pollIcon(false, false)).toBe('📊');
    expect(pollIcon(false, true)).toBe('☑️');
    expect(pollIcon(true, false)).toBe('🧠');
  });

  it('викторина остаётся викториной, даже если ответов несколько', () => {
    // Порядок веток — не случайность: «это викторина» важнее, чем «можно
    // выбрать несколько», и в заголовках пузырей он был именно такой.
    expect(pollIcon(true, true)).toBe('🧠');
  });

  it('заголовок в буфере называет опрос тем же значком, что и пузырь', () => {
    expect(pollResultsText({ ...PLAIN, isQuiz: true }).split('\n')[0]).toBe('🧠 Куда идём?');
    expect(pollResultsText({ ...PLAIN, allowMultiple: true }).split('\n')[0]).toBe('☑️ Куда идём?');
    expect(pollResultsText(PLAIN).split('\n')[0]).toBe('📊 Куда идём?');
  });
});

describe('текст результатов собирается в одном месте', () => {
  it('строка варианта: счёт, доля и полоса', () => {
    expect(pollResultsText(PLAIN)).toBe(
      ['📊 Куда идём?', '', 'В парк: 3 (75%) ████████░░', 'В кино: 1 (25%) ███░░░░░░░', '', 'Всего голосов: 4'].join('\n')
    );
  });

  it('полоса всегда десять знаков — и на краях тоже', () => {
    const text = pollResultsText({ ...PLAIN, counts: [4, 0], total: 4 });
    expect(text).toContain('В парк: 4 (100%) ██████████');
    expect(text).toContain('В кино: 0 (0%) ░░░░░░░░░░');
    for (let cnt = 0; cnt <= 40; cnt += 1) {
      const line = pollResultsText({ ...PLAIN, counts: [cnt, 0], total: 40 }).split('\n')[2];
      const bar = line.slice(line.lastIndexOf(' ') + 1);
      expect(bar).toHaveLength(10);
      expect(bar).toMatch(/^█*░*$/);
    }
  });

  it('округление доли не переполняет полосу', () => {
    // 95% округляется до десятой как 10, а не как 9,5: без ограничения
    // «повторить −0 раз» бросило бы исключение прямо в буфер обмена.
    const line = pollResultsText({ ...PLAIN, counts: [19, 1], total: 20 }).split('\n')[2];
    expect(line).toBe('В парк: 19 (95%) ██████████');
  });

  it('пустой опрос не делит на ноль', () => {
    const text = pollResultsText({ ...PLAIN, counts: [0, 0], total: 0 });
    expect(text).toContain('В парк: 0 (0%) ░░░░░░░░░░');
    expect(text).toContain('Всего голосов: 0');
    expect(text).not.toContain('NaN');
  });

  it('вариант без счёта считается нулевым, а не NaN', () => {
    const text = pollResultsText({ ...PLAIN, options: ['А', 'Б', 'В'], counts: [2, 2], total: 4 });
    expect(text).toContain('В: 0 (0%)');
    expect(text).not.toContain('NaN');
  });
});

describe('оба пузыря зовут общий текст, своего не собирают', () => {
  for (const rel of [DM, GROUP]) {
    it(`${rel}: полоса и подвал не выписаны на месте`, () => {
      const src = codeOnly(rel);
      expect(src).not.toContain("'█'.repeat");
      expect(src).not.toContain('Всего голосов:');
      expect(src).not.toContain("'📊 '");
      expect(src).toContain('pollResultsText({');
      expect(src).toContain('{pollIcon(isQuiz, allowMultiple)} {poll.question}');
    });
  }

  it('полоса записана ровно в одном файле дома', () => {
    const homes: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name)) continue;
        if (fs.readFileSync(full, 'utf8').includes("'█'.repeat")) {
          homes.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(homes).toEqual(['ui/utils/pollResultsText.ts']);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подпись под пузырём осталась фразой', () => {
  it('на экране число голосов склоняется', () => {
    expect(votesLabel(1)).toBe('1 голос');
    expect(votesLabel(4)).toBe('4 голоса');
    expect(votesLabel(12)).toBe('12 голосов');
  });

  it('оба пузыря по-прежнему зовут её', () => {
    expect(codeOnly(DM)).toContain('votesLabel(total)');
    expect(codeOnly(GROUP)).toContain('votesLabel(totalVotes)');
  });

  it('а в буфере то же число остаётся значением при подписи', () => {
    const text = pollResultsText({ ...PLAIN, counts: [1, 0], total: 1 });
    expect(text).toContain('Всего голосов: 1');
    expect(text).not.toContain('1 голос\n');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('две прежние копии совпадали до байта — потому и не ловились', () => {
    const a = oldDmText(PLAIN.question, [...PLAIN.options], [...PLAIN.counts], PLAIN.total);
    const b = oldGroupText(PLAIN.question, [...PLAIN.options], [...PLAIN.counts], PLAIN.total);
    expect(a).toBe(b);
    // И обе совпадали с нынешним текстом на обычном опросе: правка ничего не
    // переписала, она лишь оставила одно место, которое можно переписать.
    expect(a).toBe(pollResultsText(PLAIN));
  });

  it('а на викторине прежние копии врали одинаково', () => {
    const old = oldDmText(PLAIN.question, [...PLAIN.options], [...PLAIN.counts], PLAIN.total);
    expect(old.split('\n')[0]).toBe('📊 Куда идём?');
    expect(pollResultsText({ ...PLAIN, isQuiz: true }).split('\n')[0]).toBe('🧠 Куда идём?');
  });
});
