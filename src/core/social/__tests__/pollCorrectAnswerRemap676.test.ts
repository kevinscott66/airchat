/**
 * Круг 4.32.676 — «отметка верного ответа не переезжает на чужой вариант».
 *
 * correctAnswer — это НОМЕР строки в списке вариантов. Список по дороге к
 * конверту фильтруется дважды: makePollText выбрасывает пустые строки, а
 * потом ещё и те, от которых после вычистки управляющих символов ничего не
 * осталось. Обе чистки перенумеровывают варианты, а отметка оставалась на
 * старом номере — и уходила викторина с чужим правильным ответом. Если же
 * номер выпадал за границы, поле просто не писалось: викторина молча
 * становилась обычным опросом.
 *
 * В группе это закрыли в 4.32.622/652 на стороне формы. До лички правка не
 * доехала, а сам кодек продолжал молча терять отметку у любого вызывающего.
 */

import fs from 'fs';
import path from 'path';

import { makePollText, parsePollText, PollValidationError } from '../pollEnvelope';
import { NO_CORRECT_ANSWER } from '../pollCorrectAnswer';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const DM_CREATOR = (): string => read('ui/components/modals/chat/ChatPollCreatorModal.tsx');
const CHAT_SCREEN = (): string => read('ui/screens/ChatScreen.tsx');

/** Убирает строки комментариев: пояснения на русском цитируют старый код. */
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

const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

describe('повод для правки жив', () => {
  it('makePollText по-прежнему выбрасывает пустой вариант — значит перенумеровывает', () => {
    const p = parsePollText(makePollText('Вопрос', ['А', '', 'Б'], 0));
    expect(p?.options).toEqual(['А', 'Б']);
  });

  it('и по-прежнему выбрасывает вариант из одних управляющих символов', () => {
    const p = parsePollText(makePollText('Вопрос', ['А', '\x07', 'Б'], 0));
    expect(p?.options).toEqual(['А', 'Б']);
  });

  it('в форме лички отметка по-прежнему хранится как номер строки options', () => {
    expect(codeOnly(DM_CREATOR())).toContain('correctAnswer === i');
  });
});

describe('makePollText — отметка едет вместе со списком', () => {
  it('пустой вариант выше сдвигает отметку', () => {
    const p = parsePollText(makePollText('Вопрос', ['А', '', 'Б'], 2));
    expect(p?.options).toEqual(['А', 'Б']);
    expect(p?.correctAnswer).toBe(1);
  });

  it('вариант из управляющих символов выше сдвигает отметку так же', () => {
    const p = parsePollText(makePollText('Вопрос', ['А', '\x07', 'Б', 'В'], 2));
    expect(p?.options).toEqual(['А', 'Б', 'В']);
    expect(p?.correctAnswer).toBe(1);
  });

  it('несколько выпавших вариантов считаются вместе', () => {
    const p = parsePollText(makePollText('Вопрос', ['', 'А', '  ', 'Б', 'В'], 4));
    expect(p?.options).toEqual(['А', 'Б', 'В']);
    expect(p?.correctAnswer).toBe(2);
  });

  it('вариант ниже отметки её не трогает', () => {
    const p = parsePollText(makePollText('Вопрос', ['А', 'Б', '', 'В'], 0));
    expect(p?.correctAnswer).toBe(0);
  });

  it('когда чистить нечего, номер остаётся прежним', () => {
    expect(parsePollText(makePollText('Вопрос', ['А', 'Б', 'В'], 2))?.correctAnswer).toBe(2);
  });
});

describe('makePollText — отмеченного варианта не стало', () => {
  it('отметка на пустой строке — отказ', () => {
    expect(() => makePollText('Вопрос', ['А', '', 'Б'], 1)).toThrow(PollValidationError);
  });

  it('отметка на строке из управляющих символов — отказ', () => {
    expect(() => makePollText('Вопрос', ['А', '\x07', 'Б'], 1)).toThrow(PollValidationError);
  });

  it('снятая отметка не проходит молча', () => {
    expect(() => makePollText('Вопрос', ['А', 'Б'], NO_CORRECT_ANSWER)).toThrow(PollValidationError);
  });

  it('обычный опрос без отметки собирается как раньше', () => {
    expect(parsePollText(makePollText('Вопрос', ['А', '', 'Б']))?.correctAnswer).toBeUndefined();
  });
});

describe('форма лички считает отметку по отправляемому списку', () => {
  it('удаление варианта пересчитывает отметку', () => {
    const code = codeOnly(DM_CREATOR());
    expect(code).toContain('correctAnswerAfterRemove(prev, i)');
    expect(code).toContain('onPress={() => removeOption(i)}');
    // Прежний обработчик удалял строку прямо в кнопке, мимо пересчёта. Такое
    // выражение теперь встречается ровно один раз — внутри removeOption.
    expect(countOf(code, 'prev.filter((_, j) => j !== i)')).toBe(1);
  });

  it('снятая отметка ловится отдельным сообщением, до проверки на пустоту', () => {
    const code = codeOnly(DM_CREATOR());
    const iNone = code.indexOf('correctAnswer === NO_CORRECT_ANSWER');
    const iEmpty = code.indexOf('kept.indexOf(correctAnswer)');
    expect(iNone).toBeGreaterThanOrEqual(0);
    expect(iEmpty).toBeGreaterThan(iNone);
  });

  it('в кодек уходит пересчитанный номер, а не номер строки формы', () => {
    const body = slice(codeOnly(DM_CREATOR()), 'const submit = () => {', '\n  };');
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('isQuiz ? answer : undefined');
    expect(body).not.toContain('isQuiz ? correctAnswer : undefined');
  });

  it('отказ оставляет набранное в форме', () => {
    const body = slice(codeOnly(DM_CREATOR()), 'const submit = () => {', '\n  };');
    const iGuard = body.indexOf('if (!onCreate(');
    const iReset = body.indexOf('reset();');
    expect(iGuard).toBeGreaterThanOrEqual(0);
    expect(iReset).toBeGreaterThan(iGuard);
  });

  it('экран переписки отвечает форме, приняла ли она опрос', () => {
    const body = slice(codeOnly(CHAT_SCREEN()), '<DmPollCreatorModal', '\n      />');
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain('return false;');
    expect(body).toContain('return true;');
    expect(body).not.toContain('if (!peerB64) return;');
  });
});

describe('проверка не пустая', () => {
  it('оба разбираемых файла прочитались', () => {
    expect(DM_CREATOR().length).toBeGreaterThan(2_000);
    expect(CHAT_SCREEN().length).toBeGreaterThan(50_000);
  });

  it('codeOnly убирает комментарии и оставляет код', () => {
    expect(codeOnly('// абв\nconst a = 1;\n')).toBe('const a = 1;\n');
  });

  it('обычный опрос по-прежнему собирается и разбирается', () => {
    expect(parsePollText(makePollText('Пойдём?', ['Да', 'Нет']))).toEqual({
      question: 'Пойдём?',
      options: ['Да', 'Нет'],
    });
  });
});
