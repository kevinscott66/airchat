import { publicIdFor, publicIdKind, readPublicId } from '../publicId';
import { checkUsernameClaim, isReservedUsername, USERNAME_MIN_SELF_SERVICE } from '../reservedUsernames';

describe('publicId', () => {
  it('выводится только из ключа и не меняется между вызовами', () => {
    const a = publicIdFor('account', 'AenzvKnNpF0=');
    expect(a).toBe(publicIdFor('account', 'AenzvKnNpF0='));
    expect(a).toMatch(/^AC-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it('различает группу и канал с одним uuid', () => {
    const uuid = '2f1a5f4c-9f1e-4d2a-8b6b-0d4a7c9e1f33';
    expect(publicIdFor('group', uuid)).not.toBe(publicIdFor('channel', uuid));
  });

  it('пустой seed идентификатора не имеет', () => {
    expect(publicIdFor('account', '')).toBe('');
    expect(publicIdFor('group', null)).toBe('');
  });

  it('читает набранное с пробелами, в нижнем регистре и с путаницей O/0', () => {
    const id = publicIdFor('group', 'g-1');
    const typed = id.toLowerCase().replace(/-/g, ' ');
    expect(readPublicId(typed)).toBe(id);
    expect(publicIdKind(id)).toBe('group');
    expect(readPublicId('не идентификатор')).toBeNull();
  });

  it('в теле нет символов, которые путают на слух', () => {
    for (let i = 0; i < 200; i++) {
      const body = publicIdFor('account', `seed-${i}`).slice(3).replace('-', '');
      expect(body).not.toMatch(/[ILOU]/);
    }
  });
});

describe('checkUsernameClaim', () => {
  it('короткое имя отбивается по длине, а не по занятости', () => {
    expect(checkUsernameClaim('nft')).toEqual({ ok: false, reason: 'too_short' });
    expect(USERNAME_MIN_SELF_SERVICE).toBeGreaterThan(3);
  });

  it('служебные имена не занять', () => {
    expect(checkUsernameClaim('owner')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkUsernameClaim('@Founder')).toEqual({ ok: false, reason: 'reserved' });
    expect(isReservedUsername('support')).toBe(true);
  });

  it('обычное имя проходит и нормализуется', () => {
    expect(checkUsernameClaim('  @Kevin_Scott ')).toEqual({ ok: true, username: 'kevin_scott' });
  });

  // v4.32.547: имя из ПРОВЕРЕННОЙ бумаги на галочку открывает ровно себя.
  // Второй параметр — не то, что человек набрал в поле, а то, что вернул
  // readGrant; спутать эти два источника значит отдать `founder` любому.
  it('выданное имя открывается, и только оно', () => {
    expect(checkUsernameClaim('founder', 'founder')).toEqual({ ok: true, username: 'founder' });
    // Бумага на founder не открывает support — ни как служебное имя…
    expect(checkUsernameClaim('support', 'founder')).toEqual({ ok: false, reason: 'reserved' });
    // …ни как слишком короткое.
    expect(checkUsernameClaim('nft', 'founder')).toEqual({ ok: false, reason: 'too_short' });
    // Регистр и «собака» не мешают: сверяются нормализованные имена.
    expect(checkUsernameClaim('@Founder', ' FOUNDER ')).toEqual({ ok: true, username: 'founder' });
  });

  it('выдача не отменяет границы формата', () => {
    expect(checkUsernameClaim('кевин', 'кевин')).toEqual({ ok: false, reason: 'charset' });
    expect(checkUsernameClaim('a'.repeat(33), 'a'.repeat(33))).toEqual({ ok: false, reason: 'too_long' });
  });

  // v4.32.594: рядом с юзернеймами ходят числовые идентификаторы, и `@12345`
  // от них не отличить. Такое имя не выдаётся и по бумаге — иначе граница
  // держалась бы только на поле ввода.
  it('имя из одних цифр не занимается — ни своей рукой, ни по бумаге', () => {
    expect(checkUsernameClaim('12345')).toEqual({ ok: false, reason: 'digits_only' });
    expect(checkUsernameClaim('@0007')).toEqual({ ok: false, reason: 'digits_only' });
    expect(checkUsernameClaim('123456', '123456')).toEqual({ ok: false, reason: 'digits_only' });
    // Отказ идёт раньше длины: иначе `@12` объяснялся бы короткостью, и
    // человек дописывал бы цифры, упираясь в ту же дверь.
    expect(checkUsernameClaim('12')).toEqual({ ok: false, reason: 'digits_only' });
  });

  it('цифры внутри имени по-прежнему разрешены', () => {
    expect(checkUsernameClaim('kevin66')).toEqual({ ok: true, username: 'kevin66' });
    expect(checkUsernameClaim('_1234')).toEqual({ ok: true, username: '_1234' });
  });

  it('называет причину для пустого и для запрещённых символов', () => {
    expect(checkUsernameClaim('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkUsernameClaim('кевин')).toEqual({ ok: false, reason: 'charset' });
    expect(checkUsernameClaim('a'.repeat(33))).toEqual({ ok: false, reason: 'too_long' });
  });
});
