/**
 * Своя роль в группе — своя строка в group_members (v4.32.512).
 *
 * Колонку `groups.is_admin` писал ровно один createGroup, в момент появления
 * группы, и дальше её не менял никто: ни повышение, ни понижение, ни бан.
 * Роли при этом живут в group_members и меняются постоянно. Две записи об
 * одном разъезжались в обе стороны — и каждая сторона ломалась по-своему:
 * повышенный администратор оставался без прав, понижённый сохранял кнопки.
 *
 * Здесь проверяется само правило и его запасной ответ.
 */
import { isAdminRole, ownGroupRole, roleAfterCtl } from '../ownGroupRole';

const ME = 'M'.repeat(43);
const OTHER = 'O'.repeat(43);

describe('isAdminRole', () => {
  it('права даёт владелец и администратор', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
  });

  it('и никто больше — включая «нет такого участника»', () => {
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('restricted')).toBe(false);
    expect(isAdminRole('banned')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe('ownGroupRole', () => {
  it('берёт роль из своей строки участника', () => {
    const members = [
      { peerPubB64: ME, role: 'admin' },
      { peerPubB64: OTHER, role: 'owner' },
    ];
    expect(ownGroupRole(members, ME, false)).toBe('admin');
  });

  it('строка сильнее флага — понижение действует и на своём экране', () => {
    // Тот самый дефект: флаг остался с создания группы, роль давно другая.
    // Раньше отвечал флаг, и понизившийся видел у себя админские кнопки.
    expect(ownGroupRole([{ peerPubB64: ME, role: 'member' }], ME, true)).toBe('member');
    expect(ownGroupRole([{ peerPubB64: ME, role: 'restricted' }], ME, true)).toBe('restricted');
    expect(ownGroupRole([{ peerPubB64: ME, role: 'banned' }], ME, true)).toBe('banned');
  });

  it('строка сильнее флага и в обратную сторону — повышение действует сразу', () => {
    expect(ownGroupRole([{ peerPubB64: ME, role: 'admin' }], ME, false)).toBe('admin');
    expect(isAdminRole(ownGroupRole([{ peerPubB64: ME, role: 'admin' }], ME, false))).toBe(true);
  });

  it('владелец не сплющивается в администратора (v4.32.255)', () => {
    // Для права писать разницы нет, но модерация их различает: чужого
    // администратора вправе тронуть только владелец.
    expect(ownGroupRole([{ peerPubB64: ME, role: 'owner' }], ME, true)).toBe('owner');
  });

  it('без своей строки отвечает флаг — список ещё не прочитан', () => {
    expect(ownGroupRole([], ME, true)).toBe('admin');
    expect(ownGroupRole([], ME, false)).toBe('member');
    expect(ownGroupRole([{ peerPubB64: OTHER, role: 'owner' }], ME, false)).toBe('member');
  });

  it('без своего ключа — тоже флаг: спрашивать в таблице нечего', () => {
    expect(ownGroupRole([{ peerPubB64: ME, role: 'admin' }], null, false)).toBe('member');
    expect(ownGroupRole([{ peerPubB64: ME, role: 'member' }], undefined, true)).toBe('admin');
  });
});

describe('roleAfterCtl — какой станет роль адресата', () => {
  it('назначение роли отдаёт присланную роль', () => {
    expect(roleAfterCtl('role', 'admin')).toBe('admin');
    expect(roleAfterCtl('role', 'member')).toBe('member');
    expect(roleAfterCtl('role', 'restricted')).toBe('restricted');
  });

  it('бан, снятие бана и исключение говорят сами за себя', () => {
    expect(roleAfterCtl('ban')).toBe('banned');
    expect(roleAfterCtl('unban')).toBe('member');
    expect(roleAfterCtl('kick')).toBeNull();
  });

  it('прочие операции роли не меняют — и флаг трогать не нужно', () => {
    // undefined ≠ null: null означает «участника больше нет», а undefined —
    // «эта операция про роль ничего не говорит».
    expect(roleAfterCtl('add')).toBeUndefined();
    expect(roleAfterCtl('meta')).toBeUndefined();
    expect(roleAfterCtl('join')).toBeUndefined();
    expect(roleAfterCtl('pin')).toBeUndefined();
    expect(roleAfterCtl('role', null)).toBeUndefined();
  });

  it('исключение и бан снимают админские права, назначение — даёт', () => {
    expect(isAdminRole(roleAfterCtl('kick') ?? null)).toBe(false);
    expect(isAdminRole(roleAfterCtl('ban') ?? null)).toBe(false);
    expect(isAdminRole(roleAfterCtl('unban') ?? null)).toBe(false);
    expect(isAdminRole(roleAfterCtl('role', 'admin') ?? null)).toBe(true);
  });
});
