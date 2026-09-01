import { canModerate } from '../groupModerationPolicy';

describe('canModerate', () => {
  it('обычный участник модерировать не может', () => {
    expect(canModerate('member', 'member').allowed).toBe(false);
    expect(canModerate('restricted', 'member').allowed).toBe(false);
    expect(canModerate('banned', 'member').allowed).toBe(false);
    expect(canModerate(undefined, 'member').allowed).toBe(false);
  });

  it('владельца не трогает никто, включая другого владельца', () => {
    expect(canModerate('admin', 'owner').allowed).toBe(false);
    expect(canModerate('owner', 'owner').allowed).toBe(false);
  });

  it('другого администратора трогает только владелец', () => {
    expect(canModerate('admin', 'admin').allowed).toBe(false);
    expect(canModerate('owner', 'admin').allowed).toBe(true);
  });

  it('обычного участника модерируют и админ, и владелец', () => {
    expect(canModerate('admin', 'member').allowed).toBe(true);
    expect(canModerate('owner', 'member').allowed).toBe(true);
    expect(canModerate('admin', 'restricted').allowed).toBe(true);
    expect(canModerate('admin', 'banned').allowed).toBe(true);
  });

  it('неизвестная цель (новый участник) ограничена только ролью актора', () => {
    expect(canModerate('admin', undefined).allowed).toBe(true);
    expect(canModerate('member', undefined).allowed).toBe(false);
  });

  it('у отказа есть текст, который можно показать', () => {
    const v = canModerate('admin', 'admin');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason.length).toBeGreaterThan(10);
  });
});
