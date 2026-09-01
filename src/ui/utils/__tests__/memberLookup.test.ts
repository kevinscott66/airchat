/**
 * Главное, что здесь проверяется, — что подставное имя не уводит команду
 * администратора на чужого участника. Остальное (регистр, @, хвост ключа)
 * вокруг этого.
 */
import { ambiguityMessage, memberLabel, resolveMember } from '../memberLookup';
import { shortIdentity } from '../../identity/shortId';

type M = { peerPubB64: string; displayName: string | null };

const anya: M = { peerPubB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAk3f9d2a1c', displayName: 'Аня' };
/** Тот самый, кто назвался похоже, чтобы перехватить чужую команду. */
const impostor: M = { peerPubB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb7c10099', displayName: 'Аня Петрова' };
const petr: M = { peerPubB64: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCf00dbeef', displayName: 'Пётр' };
const noName: M = { peerPubB64: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD12345678', displayName: null };

const all = [impostor, anya, petr, noName];

describe('resolveMember', () => {
  it('точное имя выигрывает у подстроки, даже если самозванец идёт первым', () => {
    // Старый .find(includes) вернул бы impostor — он раньше в списке.
    expect(resolveMember(all, 'Аня')).toEqual({ kind: 'found', member: anya });
  });

  it('два одинаковых имени — не «первый попавшийся», а ambiguous', () => {
    const twins = [
      { peerPubB64: 'K1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', displayName: 'Аня' },
      { peerPubB64: 'K2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', displayName: 'аня ' },
    ];
    const r = resolveMember(twins, 'Аня');
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates).toHaveLength(2);
  });

  it('неоднозначная подстрока не разрешается молча', () => {
    const r = resolveMember(all, 'ня');
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.peerPubB64)).toEqual([
      impostor.peerPubB64,
      anya.peerPubB64,
    ]);
  });

  it('префикс отрабатывает раньше подстроки', () => {
    // «Аня П» — префикс только у самозванца, подстрока тоже только у него.
    expect(resolveMember(all, 'Аня П')).toEqual({ kind: 'found', member: impostor });
  });

  it('хвост ключа разводит одинаковые имена', () => {
    expect(resolveMember(all, 'k3f9d2a1c')).toEqual({ kind: 'found', member: anya });
    expect(resolveMember(all, 'b7c10099')).toEqual({ kind: 'found', member: impostor });
  });

  it('полный ключ важнее любого имени', () => {
    expect(resolveMember(all, petr.peerPubB64)).toEqual({ kind: 'found', member: petr });
  });

  it('ключ ищется регистрозависимо — base64 различает регистр', () => {
    expect(resolveMember(all, 'K3F9D2A1C').kind).toBe('none');
  });

  it('короткий хвост ключом не считается', () => {
    // 5 символов < MIN_KEY_SUFFIX: это имя, а не ключ.
    expect(resolveMember(all, '45678').kind).toBe('none');
  });

  it('участник без имени находится по ключу', () => {
    expect(resolveMember(all, '12345678')).toEqual({ kind: 'found', member: noName });
  });

  it('@ и лишние пробелы снимаются', () => {
    expect(resolveMember(all, '  @Пётр ')).toEqual({ kind: 'found', member: petr });
  });

  it('регистр имени не важен', () => {
    expect(resolveMember(all, 'пЁтР')).toEqual({ kind: 'found', member: petr });
  });

  it('пустой запрос — none, а не «первый в списке»', () => {
    expect(resolveMember(all, '   ').kind).toBe('none');
    expect(resolveMember(all, '@').kind).toBe('none');
  });

  it('никого не нашли — none', () => {
    expect(resolveMember(all, 'Василий').kind).toBe('none');
  });

  it('пустой список участников', () => {
    expect(resolveMember([], 'Аня').kind).toBe('none');
  });
});

describe('memberLabel', () => {
  // v4.32.425: подпись здесь та же, что на экране, — оба конца ключа. Это не
  // косметика: админ указывает участника тем, что видит.
  it('имя плюс сокращённый ключ', () => {
    expect(memberLabel(anya)).toBe('Аня · AAAAAA…9d2a1c');
  });

  it('без имени — только ключ', () => {
    expect(memberLabel(noName)).toBe('DDDDDD…345678');
  });

  it('имя из пробелов считается отсутствующим', () => {
    expect(memberLabel({ peerPubB64: noName.peerPubB64, displayName: '   ' })).toBe('DDDDDD…345678');
  });

  it('подпись совпадает с той, что рисует интерфейс', () => {
    // Ссылочная проверка невозможна — сравниваем результат.
    expect(memberLabel(noName)).toBe(shortIdentity(noName.peerPubB64));
  });
});

describe('ambiguityMessage', () => {
  it('перечисляет кандидатов и подсказывает про ключ', () => {
    const msg = ambiguityMessage([anya, impostor]);
    expect(msg).toContain('Аня · ' + shortIdentity(anya.peerPubB64));
    expect(msg).toContain('Аня Петрова · ' + shortIdentity(impostor.peerPubB64));
    expect(msg).toContain('укажите ключ');
  });

  it('длинный список обрезается', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      peerPubB64: `KEY${String(i).padStart(8, '0')}`,
      displayName: `Аня ${i}`,
    }));
    const msg = ambiguityMessage(many);
    expect(msg).toContain('…и ещё 4');
    expect(msg).not.toContain('Аня 9 ·');
  });
});

describe('уточнение тем, что написано на экране (v4.32.425)', () => {
  // Подпись без имени перестала быть голым хвостом, и `endsWith` по ней не
  // совпал бы никогда — а именно её админ и скопирует.
  it('сокращённая подпись с многоточием находит участника', () => {
    expect(resolveMember(all, shortIdentity(noName.peerPubB64))).toEqual({
      kind: 'found',
      member: noName,
    });
  });

  it('она строже голого хвоста: голова тоже обязана совпасть', () => {
    const tail = noName.peerPubB64.slice(-6);
    // Хвост сам по себе находит.
    expect(resolveMember(all, tail).kind).toBe('found');
    // Тот же хвост с чужой головой — не находит никого.
    expect(resolveMember(all, `ZZZZZZ\u2026${tail}`).kind).toBe('none');
  });

  it('слишком короткий кусок не считается ключом', () => {
    // Иначе «A…c» совпало бы со всеми и увело бы команду наугад.
    expect(resolveMember(all, 'A\u2026c').kind).toBe('none');
  });

  it('полный ключ по-прежнему точен', () => {
    expect(resolveMember(all, anya.peerPubB64)).toEqual({ kind: 'found', member: anya });
  });
});
