import { readFileSync } from 'fs';
import { join } from 'path';

import { resolveMention } from '../mentionResolve';

type Row = { id: string; username?: string | null; displayName?: string | null };
const rows: Row[] = [
  { id: 'bob', username: 'bob', displayName: 'Боб' },
  { id: 'ivan', displayName: 'Иван Петров' },
  { id: 'ivan2', displayName: 'Иван' },
  { id: 'anna', username: 'anna_k', displayName: 'Аня' },
  { id: 'anna2', displayName: 'Аня' },
];

const ids = (raw: string, list: Row[] = rows): string[] => resolveMention(raw, list).map((r) => r.id);

describe('resolveMention', () => {
  it('канонический username побеждает и не зависит от регистра', () => {
    expect(ids('@Bob')).toEqual(['bob']);
    expect(ids('bob')).toEqual(['bob']);
    expect(ids('@anna_k')).toEqual(['anna']);
  });

  it('отображаемое имя — вторая попытка', () => {
    expect(ids('@Боб')).toEqual(['bob']);
  });

  it('одинаковые отображаемые имена возвращаются все — выбирать нельзя', () => {
    expect(ids('@Аня').sort()).toEqual(['anna', 'anna2']);
  });

  it('точное имя важнее первого слова составного', () => {
    expect(ids('@Иван')).toEqual(['ivan2']);
  });

  it('первое слово составного имени — последняя попытка', () => {
    const only = rows.filter((r) => r.id !== 'ivan2');
    expect(ids('@Иван', only)).toEqual(['ivan']);
  });

  it('пустое имя не находит никого', () => {
    expect(ids('@')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });

  it('неизвестное имя не находит никого', () => {
    expect(ids('@нетутакого')).toEqual([]);
  });

  it('username сравнивается по канону, а не по строке', () => {
    expect(ids('@BOB')).toEqual(['bob']);
    // Имя, которое не может быть username (кириллица), в первую попытку не идёт.
    expect(ids('@Боб')).toEqual(['bob']);
  });
});

/**
 * Главное свойство модуля: он НЕ выбирает за человека. `peerUsername` списан
 * с конверта профиля собеседника и с общим реестром не сверяется — значит
 * назваться чужим именем может любой принятый контакт (v4.32.615).
 */
describe('username не даёт права выбрать за человека', () => {
  const alice = { id: 'alice', username: 'alice', displayName: 'Алиса' };
  const mallory = { id: 'mallory', username: 'Alice', displayName: 'Не Алиса' };

  it('двое с одним username возвращаются оба', () => {
    expect(ids('@alice', [alice, mallory]).sort()).toEqual(['alice', 'mallory']);
  });

  it('регистр не спасает: канон сводит «Alice» и «alice» в одно имя', () => {
    expect(ids('@ALICE', [alice, mallory])).toHaveLength(2);
  });

  it('единственный носитель по-прежнему возвращается один', () => {
    expect(ids('@alice', [alice])).toEqual(['alice']);
  });

  it('совпадение по username не смешивается с совпадением по имени', () => {
    // «Не Алиса» подходит только по username, «Алиса» — и по нему, и по имени.
    // Возвращаются оба, но именно из первой попытки, а не из второй.
    const both = ids('@alice', [alice, mallory]);
    expect(both).toContain('mallory');
  });

  it('в исходнике не осталось усечения до первого совпадения', () => {
    const src = readFileSync(join(__dirname, '..', 'mentionResolve.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).toContain('if (byUsername.length > 0) return byUsername;');
    expect(src).not.toContain('byUsername.slice(');
  });
});
