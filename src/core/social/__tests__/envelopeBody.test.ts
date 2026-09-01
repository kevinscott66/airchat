/**
 * Общее начало разбора конверта.
 *
 * Проверяется не столько сама функция (она в шесть строк), сколько ПОРЯДОК:
 * потолок длины обязан сработать ДО JSON.parse, иначе он не защищает ни от
 * чего — разбор мегабайтной строки к этому моменту уже случился. Ровно
 * поэтому здесь стоит слежка за самим JSON.parse, а не только проверка
 * возвращаемого null.
 */

import { readEnvelopeBody } from '../envelopeBody';

const P = 'p:';
const wrap = (payload: unknown): string => P + JSON.stringify(payload);

describe('readEnvelopeBody', () => {
  it('чужой префикс — не наш конверт', () => {
    expect(readEnvelopeBody('q:{}', P, 1024)).toBeNull();
    expect(readEnvelopeBody('', P, 1024)).toBeNull();
  });

  it('объект возвращается как есть', () => {
    expect(readEnvelopeBody(wrap({ a: 1, b: 'два' }), P, 1024)).toEqual({ a: 1, b: 'два' });
  });

  it('потолок меряется по всей строке, вместе с префиксом', () => {
    // Она и приходит из сети целиком: мерить одно тело значит недосчитать
    // ровно столько, сколько занимает префикс.
    const s = wrap({ a: 'я'.repeat(100) });
    expect(readEnvelopeBody(s, P, s.length)).not.toBeNull();
    expect(readEnvelopeBody(s, P, s.length - 1)).toBeNull();
  });

  it('слишком длинная строка не доходит до JSON.parse', () => {
    const spy = jest.spyOn(JSON, 'parse');
    try {
      expect(readEnvelopeBody(wrap({ a: 'я'.repeat(5000) }), P, 512)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('битый JSON — null, а не исключение', () => {
    expect(readEnvelopeBody(P + '{не json', P, 1024)).toBeNull();
    expect(readEnvelopeBody(P, P, 1024)).toBeNull();
  });

  it('не объект — null: массив, число, строка, null, true', () => {
    // typeof [] === 'object', и без отдельной проверки массив проходил дальше:
    // вызывающий читал с него свои поля и получал undefined вместо отказа.
    for (const v of [[], [1, 2], 42, 'строка', null, true]) {
      expect([JSON.stringify(v), readEnvelopeBody(wrap(v), P, 1024)]).toEqual([JSON.stringify(v), null]);
    }
  });

  it('приведение к типу происходит после проверки формы, а не вместо неё', () => {
    type Env = { ts: number };
    expect(readEnvelopeBody<Env>(wrap([1, 2]), P, 1024)).toBeNull();
    expect(readEnvelopeBody<Env>(wrap({ ts: 7 }), P, 1024)).toEqual({ ts: 7 });
  });
});
