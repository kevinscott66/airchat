/**
 * Круг 4.32.652 — «опрос не должен врать о том, чего он не прочитал».
 *
 * Три места превращали неизвестность в утверждение:
 *  1) оба пузыря опроса читали голоса без try/catch, и отказ чтения
 *     выглядел как «голосов нет, вы ещё не отвечали»;
 *  2) отметка «завершён» читалась через scopedKvGetFor, который склеивает
 *     «ключа нет» и «прочитать не удалось» в один null;
 *  3) в форме викторины удаление варианта перенумеровывало список, но не
 *     отметку верного ответа, и она молча переезжала на соседний вариант.
 */

import fs from 'fs';
import path from 'path';

import {
  mayCastPollVote,
  POLL_UNREADABLE_TEXT,
  readPollSnapshot,
} from '../../../core/social/pollRead';
import {
  correctAnswerAfterRemove,
  NO_CORRECT_ANSWER,
} from '../../../core/social/pollCorrectAnswer';
import { getPollVotes } from '../../../core/storage/local';
import { scopedKvTryGetFor } from '../../../core/storage/profileScopedKv';

jest.mock('../../../core/storage/local', () => ({
  getPollVotes: jest.fn(),
}));
jest.mock('../../../core/storage/profileScopedKv', () => ({
  scopedKvTryGetFor: jest.fn(),
}));
jest.mock('../../../core/storage/kvKeys', () => ({
  pollClosedKey: (id: string) => `poll_closed_v1:${id}`,
}));
jest.mock('../../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockedVotes = getPollVotes as jest.MockedFunction<typeof getPollVotes>;
const mockedCell = scopedKvTryGetFor as jest.MockedFunction<typeof scopedKvTryGetFor>;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const GROUP_BUBBLE = (): string => read('ui/screens/groups-components/PollBubble.tsx');
const DM_BUBBLE = (): string => read('ui/screens/chat-components/DmPollBubble.tsx');
const CREATOR = (): string => read('ui/components/modals/groups/GroupPollCreatorModal.tsx');
const LOCAL = (): string => read('core/storage/local.ts');
const SCOPED = (): string => read('core/storage/profileScopedKv.ts');

/**
 * Убирает строки комментариев: собственные пояснения на русском цитируют
 * старый код, и без этого not.toContain ловил бы комментарий, а не код.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i + from.length);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('повод для правки жив', () => {
  it('getPollVotes по-прежнему падает вместе с db(), а не возвращает пустой список', () => {
    const body = slice(LOCAL(), 'export async function getPollVotes(', '\n}\n');
    expect(body).toContain('await db()');
    expect(body).not.toContain('try {');
    expect(body).not.toContain('catch');
  });

  it('scopedKvGetFor по-прежнему склеивает «нет ключа» и «не прочиталось»', () => {
    const body = slice(SCOPED(), 'export async function scopedKvGetFor(', '\n}\n');
    expect(body).toContain('?.value ?? null');
  });

  it('scopedKvTryGetFor по-прежнему различает их: null — это сбой', () => {
    const body = slice(SCOPED(), 'export async function scopedKvTryGetFor(', '\n}\n');
    expect(body).toContain('if (own === null) return null;');
  });

  it('голос по-прежнему уходит наружу — переголосование не локально', () => {
    expect(codeOnly(GROUP_BUBBLE())).toContain('castAndSyncPollVote({');
    expect(codeOnly(DM_BUBBLE())).toContain('castAndSyncPollVote({');
  });

  it('correctAnswer в форме по-прежнему индекс строки options', () => {
    const code = codeOnly(CREATOR());
    expect(code).toContain('kept.indexOf(correctAnswer)');
    expect(code).toContain('correctAnswer === i');
  });
});

describe('mayCastPollVote — непрочитанное состояние это запрет', () => {
  it('pending запрещает голос', () => {
    expect(mayCastPollVote('pending', false, false, false)).toBe(false);
  });

  it('failed запрещает голос', () => {
    expect(mayCastPollVote('failed', false, false, false)).toBe(false);
  });

  it('завершённый опрос запрещает голос', () => {
    expect(mayCastPollVote('ok', true, false, false)).toBe(false);
  });

  it('в викторине после ответа голосовать нельзя', () => {
    expect(mayCastPollVote('ok', false, true, true)).toBe(false);
  });

  it('в викторине без ответа — можно', () => {
    expect(mayCastPollVote('ok', false, true, false)).toBe(true);
  });

  it('в обычном опросе голос можно переставить', () => {
    expect(mayCastPollVote('ok', false, false, true)).toBe(true);
  });
});

describe('readPollSnapshot — сбой отличается от пустоты', () => {
  beforeEach(() => {
    mockedVotes.mockReset();
    mockedCell.mockReset();
  });

  it('пустой опрос читается как прочитанный', async () => {
    mockedVotes.mockResolvedValue([]);
    mockedCell.mockResolvedValue({ value: null });
    await expect(readPollSnapshot('m1', 1)).resolves.toEqual({ votes: [], closed: false });
  });

  it('голоса и отметка завершения возвращаются вместе', async () => {
    mockedVotes.mockResolvedValue([{ voterPubB64: 'a', optionIndex: 1 }]);
    mockedCell.mockResolvedValue({ value: '1' });
    await expect(readPollSnapshot('m1', 1)).resolves.toEqual({
      votes: [{ voterPubB64: 'a', optionIndex: 1 }],
      closed: true,
    });
  });

  it('падение getPollVotes даёт null, а не пустой список', async () => {
    mockedVotes.mockRejectedValue(new Error('db closed'));
    mockedCell.mockResolvedValue({ value: null });
    await expect(readPollSnapshot('m1', 1)).resolves.toBeNull();
  });

  it('нечитаемая отметка завершения даёт null, а не «опрос открыт»', async () => {
    mockedVotes.mockResolvedValue([]);
    mockedCell.mockResolvedValue(null);
    await expect(readPollSnapshot('m1', 1)).resolves.toBeNull();
  });
});

describe('correctAnswerAfterRemove — отметка едет вместе со списком', () => {
  it('удаление варианта выше сдвигает отметку', () => {
    expect(correctAnswerAfterRemove(1, 0)).toBe(0);
    expect(correctAnswerAfterRemove(2, 0)).toBe(1);
  });

  it('удаление варианта ниже отметку не трогает', () => {
    expect(correctAnswerAfterRemove(1, 2)).toBe(1);
  });

  it('удаление самого отмеченного варианта снимает отметку', () => {
    expect(correctAnswerAfterRemove(1, 1)).toBe(NO_CORRECT_ANSWER);
    expect(NO_CORRECT_ANSWER).toBeLessThan(0);
  });

  it('снятая отметка остаётся снятой', () => {
    expect(correctAnswerAfterRemove(NO_CORRECT_ANSWER, 0)).toBe(NO_CORRECT_ANSWER);
  });
});

describe('пузыри опроса читают через общий модуль', () => {
  it.each([
    ['группа', GROUP_BUBBLE],
    ['личка', DM_BUBBLE],
  ])('%s: прежнее прямое чтение убрано', (_name, src) => {
    const code = codeOnly(src());
    expect(code).not.toContain('getPollVotes(');
    expect(code).not.toContain('scopedKvGetFor(');
    expect(code).toContain('readPollSnapshot(messageId, pid)');
  });

  it.each([
    ['группа', GROUP_BUBBLE],
    ['личка', DM_BUBBLE],
  ])('%s: отказ чтения — отдельное состояние', (_name, src) => {
    const code = codeOnly(src());
    expect(code).toContain("setReadPhase('failed')");
    expect(code).toContain("setReadPhase('ok')");
    expect(code).toContain("setReadPhase('pending')");
  });

  it.each([
    ['группа', GROUP_BUBBLE],
    ['личка', DM_BUBBLE],
  ])('%s: и кнопка, и обработчик спрашивают одно правило', (_name, src) => {
    const code = codeOnly(src());
    expect(code).toContain('mayCastPollVote(readPhase, isClosed, isQuiz, hasVoted)');
    expect(code).toContain('disabled={!canVote}');
    expect(code).toContain('if (!canVote) return;');
    // Прежние два независимых условия должны исчезнуть, иначе непрочитанное
    // состояние снова стало бы разрешением.
    expect(code).not.toContain('disabled={(isQuiz && hasVoted) || isClosed}');
    expect(code).not.toContain('disabled={(hasVoted && isQuiz) || isClosed}');
  });

  it.each([
    ['группа', GROUP_BUBBLE],
    ['личка', DM_BUBBLE],
  ])('%s: сбой чтения проговаривается на экране', (_name, src) => {
    expect(codeOnly(src())).toContain('{POLL_UNREADABLE_TEXT}');
  });

  it.each([
    ['группа', GROUP_BUBBLE],
    ['личка', DM_BUBBLE],
  ])('%s: переработка ячейки сбрасывает и фазу чтения', (_name, src) => {
    const body = slice(codeOnly(src()), 'if (shownId !== messageId) {', '\n  }');
    expect(body).toContain("setReadPhase('pending')");
  });

  it('отправка голоса больше не висит необработанным промисом', () => {
    expect(codeOnly(GROUP_BUBBLE())).toContain('void castVote(idx).catch(');
    expect(codeOnly(DM_BUBBLE())).toContain('}).catch((e) => showError(userErrorText(e,');
  });
});

describe('форма викторины не переносит верный ответ на чужой вариант', () => {
  it('удаление варианта пересчитывает отметку', () => {
    const body = slice(codeOnly(CREATOR()), 'const removeOption =', '\n  const updateOption');
    expect(body).toContain('correctAnswerAfterRemove(prev, i)');
  });

  it('снятая отметка ловится отдельным сообщением, до проверки на пустоту', () => {
    const code = codeOnly(CREATOR());
    const iNone = code.indexOf('correctAnswer === NO_CORRECT_ANSWER');
    const iEmpty = code.indexOf('kept.indexOf(correctAnswer)');
    expect(iNone).toBeGreaterThanOrEqual(0);
    expect(iEmpty).toBeGreaterThan(iNone);
    expect(code).toContain("showError('Отметьте верный вариант ответа')");
  });
});

describe('проверка не пустая', () => {
  it('все разбираемые файлы прочитались', () => {
    for (const src of [GROUP_BUBBLE, DM_BUBBLE, CREATOR, LOCAL, SCOPED]) {
      expect(src().length).toBeGreaterThan(500);
    }
  });

  it('codeOnly убирает комментарии и оставляет код', () => {
    expect(codeOnly('// абв\nconst a = 1;\n')).toBe('const a = 1;\n');
  });

  it('текст про нечитаемые голоса не пустой', () => {
    expect(POLL_UNREADABLE_TEXT.length).toBeGreaterThan(10);
  });
});
