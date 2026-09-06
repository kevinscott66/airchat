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
