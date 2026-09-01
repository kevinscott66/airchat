/**
 * Опрос от чужого клиента.
 *
 * До v4.32.240 разбор был слабее сборки: принимал опрос без вариантов (пузырь
 * без единой кнопки) и викторину с correctAnswer вне диапазона — в такой
 * викторине правильного ответа нет ни у кого, а переголосовать она не даёт.
 */

import {
  POLL_MAX_ENVELOPE,
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
  POLL_PREFIX,
  PollValidationError,
  isPollMessage,
  makePollText,
  parsePollText,
} from '../pollEnvelope';

/** Собирает сырой конверт в обход валидации отправки. */
const raw = (payload: unknown): string => `${POLL_PREFIX}${JSON.stringify(payload)}`;

describe('makePollText', () => {
  it('round-trip', () => {
    const t = makePollText('Пойдём?', ['Да', 'Нет']);
    expect(isPollMessage(t)).toBe(true);
    expect(parsePollText(t)).toEqual({ question: 'Пойдём?', options: ['Да', 'Нет'] });
  });

  it('флаги и правильный ответ доезжают', () => {
    expect(parsePollText(makePollText('2+2?', ['3', '4'], 1, true, true))).toEqual({
      question: '2+2?',
      options: ['3', '4'],
      correctAnswer: 1,
      anonymous: true,
      allowMultiple: true,
    });
  });

  it('отказывается собирать негодный опрос', () => {
    expect(() => makePollText('   ', ['Да', 'Нет'])).toThrow(PollValidationError);
    expect(() => makePollText('Вопрос', ['Да'])).toThrow(PollValidationError);
    expect(() => makePollText('Вопрос', ['Да', '  '])).toThrow(PollValidationError);
    expect(() => makePollText('и'.repeat(POLL_MAX_QUESTION_LENGTH + 1), ['Да', 'Нет'])).toThrow(PollValidationError);
    expect(() => makePollText('Вопрос', ['Да', 'и'.repeat(POLL_MAX_OPTION_LENGTH + 1)])).toThrow(PollValidationError);
    expect(() => makePollText('Вопрос', Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `в${i}`))).toThrow(PollValidationError);
  });

  it('правильный ответ вне диапазона просто не делает опрос викториной', () => {
    expect(parsePollText(makePollText('Вопрос', ['Да', 'Нет'], 5))?.correctAnswer).toBeUndefined();
    expect(parsePollText(makePollText('Вопрос', ['Да', 'Нет'], 1.5))?.correctAnswer).toBeUndefined();
  });

  it('управляющие символы вычищаются на отправке — иначе свой опрос выглядит иначе у собеседника', () => {
    const t = makePollText('Пойдём?\x07', ['Да\x00', 'Нет']);
    expect(parsePollText(t)).toEqual({ question: 'Пойдём?', options: ['Да', 'Нет'] });
  });
});

describe('parsePollText', () => {
  it('не опрос — null', () => {
    for (const t of ['', 'привет', '\x01voice:{}', POLL_PREFIX, `${POLL_PREFIX}не json`]) {
      expect(parsePollText(t)).toBeNull();
    }
  });

  it('мусор вместо объекта не доходит до пузыря', () => {
    for (const body of ['123', '"строка"', 'null', 'true', '[1,2]', '{}']) {
      expect(parsePollText(POLL_PREFIX + body)).toBeNull();
    }
  });

  it('опрос без вариантов отклоняется, а не рисуется пустым', () => {
    expect(parsePollText(raw({ question: 'Вопрос', options: [] }))).toBeNull();
    expect(parsePollText(raw({ question: 'Вопрос', options: ['Один'] }))).toBeNull();
  });

  it('вопрос обязан быть непустой строкой', () => {
    expect(parsePollText(raw({ question: '', options: ['Да', 'Нет'] }))).toBeNull();
    expect(parsePollText(raw({ question: '   ', options: ['Да', 'Нет'] }))).toBeNull();
    expect(parsePollText(raw({ question: 42, options: ['Да', 'Нет'] }))).toBeNull();
    expect(parsePollText(raw({ question: 'и'.repeat(POLL_MAX_QUESTION_LENGTH + 1), options: ['Да', 'Нет'] }))).toBeNull();
  });

  it('варианты: не массив, не строки, слишком длинные, слишком много, пустые', () => {
    expect(parsePollText(raw({ question: 'В', options: 'Да' }))).toBeNull();
    expect(parsePollText(raw({ question: 'В', options: ['Да', 7] }))).toBeNull();
    expect(parsePollText(raw({ question: 'В', options: ['Да', 'и'.repeat(POLL_MAX_OPTION_LENGTH + 1)] }))).toBeNull();
    expect(parsePollText(raw({ question: 'В', options: Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `в${i}`) }))).toBeNull();
    expect(parsePollText(raw({ question: 'В', options: ['Да', '   '] }))).toBeNull();
  });

  it('викторина без достижимого правильного ответа отклоняется', () => {
    // Раньше каждый участник получал «❌ Неверно» — и навсегда, потому что
    // переголосовать в викторине нельзя.
    for (const bad of [-1, 2, 1.5, 1e9, Number.NaN]) {
      expect(parsePollText(raw({ question: 'В', options: ['Да', 'Нет'], correctAnswer: bad }))).toBeNull();
    }
    expect(parsePollText(raw({ question: 'В', options: ['Да', 'Нет'], correctAnswer: '1' }))).toBeNull();
    expect(parsePollText(raw({ question: 'В', options: ['Да', 'Нет'], correctAnswer: 1 }))?.correctAnswer).toBe(1);
  });

  it('управляющие символы из сети не доезжают до экрана', () => {
    const p = parsePollText(raw({ question: 'Вопрос\x07', options: ['Да\x00', 'Нет'] }));
    expect(p).toEqual({ question: 'Вопрос', options: ['Да', 'Нет'] });
  });

  it('нелогические флаги игнорируются', () => {
    const p = parsePollText(raw({ question: 'В', options: ['Да', 'Нет'], anonymous: 'да', allowMultiple: 1 }));
    expect(p).toEqual({ question: 'В', options: ['Да', 'Нет'] });
  });
});

/**
 * v4.32.380. Потолка длины до JSON.parse у опроса не было — и он нужнее, чем
 * у остальных конвертов: parsePollText зовут не при приёме, а при ОТРИСОВКЕ
 * пузыря (PollBubble, DmPollBubble, FeedScreen). Чужая строка разбиралась
 * заново на каждом проходе списка, синхронно в JS-потоке.
 */
describe('потолок длины конверта', () => {
  it('самый большой законный опрос проходит с запасом', () => {
    const s = makePollText(
      'в'.repeat(POLL_MAX_QUESTION_LENGTH),
      Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => String(i) + 'о'.repeat(POLL_MAX_OPTION_LENGTH - 2))
    );
    expect(s.length).toBeLessThanOrEqual(POLL_MAX_ENVELOPE);
    expect(parsePollText(s)?.options).toHaveLength(POLL_MAX_OPTIONS);
  });

  it('строка длиннее потолка отвергается целиком', () => {
    const s = raw({ question: 'Пойдём?', options: ['Да', 'Нет'], junk: 'x'.repeat(POLL_MAX_ENVELOPE) });
    expect(s.length).toBeGreaterThan(POLL_MAX_ENVELOPE);
    expect(parsePollText(s)).toBeNull();
  });

  it('до JSON.parse дело не доходит', () => {
    const spy = jest.spyOn(JSON, 'parse');
    try {
      expect(parsePollText(POLL_PREFIX + 'x'.repeat(POLL_MAX_ENVELOPE))).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
