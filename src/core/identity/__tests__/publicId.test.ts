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

  it('называет причину для пустого и для запрещённых символов', () => {
    expect(checkUsernameClaim('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkUsernameClaim('кевин')).toEqual({ ok: false, reason: 'charset' });
    expect(checkUsernameClaim('a'.repeat(33))).toEqual({ ok: false, reason: 'too_long' });
  });
});
