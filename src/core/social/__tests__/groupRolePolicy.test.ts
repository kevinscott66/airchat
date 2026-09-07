import {
  GROUP_BANLIST_MAX,
  countBanned,
  countMembers,
  countsAsMember,
  isAssignableRole,
  roleChangeSysText,
  roleLabel,
  roleTone,
} from '../groupRolePolicy';
import { INVITE_MEMBERS_CAP } from '../groupInviteLink';
import type { MemberRole } from '../../storage/local';
import { darkColors, lightColors } from '../../../ui/theme';

const ALL_ROLES: MemberRole[] = ['owner', 'admin', 'member', 'restricted', 'banned'];

describe('groupRolePolicy', () => {
  it('назначить можно только admin/member/restricted', () => {
    for (const ok of ['admin', 'member', 'restricted']) expect(isAssignableRole(ok)).toBe(true);
    for (const bad of ['owner', 'banned', 'root', '', null, undefined, 1, {}]) {
      expect(isAssignableRole(bad)).toBe(false);
    }
  });

  it('подпись роли: у обычного участника её нет', () => {
    expect(roleLabel('owner')).toBe('Владелец');
    expect(roleLabel('admin')).toBe('Админ');
    expect(roleLabel('restricted')).toBe('Только чтение');
    expect(roleLabel('banned')).toBe('Заблокирован');
    expect(roleLabel('member')).toBe('');
    expect(roleLabel(undefined)).toBe('');
  });

  it('цвет роли: звание и взыскание — разные цвета', () => {
    // Раньше в списке участников подпись «Заблокирован» шла фирменным
    // акцентом — тем же цветом, что ссылки и «прочитано».
    expect(roleTone('owner')).toBe('warning');
    expect(roleTone('admin')).toBe('accent');
    expect(roleTone('restricted')).toBe('textSecondary');
    expect(roleTone('banned')).toBe('error');
    expect(roleTone('member')).toBeNull();
    expect(roleTone(undefined)).toBeNull();
  });

  it('цвет есть ровно у тех ролей, у которых есть подпись', () => {
    // Инвариант против главной причины этой правки: подпись и её внешний вид
    // жили в разных файлах и разъехались. Новая роль теперь не сможет получить
    // подпись без цвета (или наоборот) незаметно.
    for (const role of [...ALL_ROLES, undefined]) {
      expect([String(role), roleLabel(role) !== '']).toEqual([String(role), roleTone(role) !== null]);
    }
  });

  it('цвет роли — токен палитры, а не написанный руками цвет', () => {
    // '#f9a825' у владельца был мимо палитры: одинаковый в обеих темах и
    // невидимый для themeContrast.test.ts, который и проверяет пороги WCAG.
    for (const role of ALL_ROLES) {
      const tone = roleTone(role);
      if (!tone) continue;
      expect([role, typeof darkColors[tone], typeof lightColors[tone]]).toEqual([role, 'string', 'string']);
      expect([role, darkColors[tone] === lightColors[tone]]).toEqual([role, false]);
    }
  });

  it('назначение администратором', () => {
    expect(roleChangeSysText('admin', 'member', 'Аня', false)).toBe('Аня назначен(а) администратором');
    expect(roleChangeSysText('admin', 'member', 'Аня', true)).toBe('Вы назначены администратором');
  });

  it('ограничение отправки', () => {
    expect(roleChangeSysText('restricted', 'member', 'Аня', false)).toBe('Аня ограничен(а) в отправке сообщений');
    expect(roleChangeSysText('restricted', 'member', 'Аня', true)).toBe('Вам ограничена отправка сообщений');
  });

  it('member различает «снято ограничение» и «снят с админов»', () => {
    // Обе ситуации приходят одним и тем же конвертом role:'member' — различает
    // их только прежняя роль.
    expect(roleChangeSysText('member', 'restricted', 'Аня', false)).toBe('Аня снова может писать');
    expect(roleChangeSysText('member', 'restricted', 'Аня', true)).toBe('Ограничение снято, вы снова можете писать');
    expect(roleChangeSysText('member', 'admin', 'Аня', false)).toBe('Аня снят(а) с должности администратора');
    expect(roleChangeSysText('member', 'admin', 'Аня', true)).toBe('С вас сняты права администратора');
  });

  it('роль одна, поэтому переход admin↔restricted называет обе перемены', () => {
    // Ограничить администратора значит сперва его разжаловать: роль в строке
    // участника одна. Раньше строка сообщала только об ограничении, и потеря
    // админских прав оставалась незамеченной всеми, включая его самого.
    expect(roleChangeSysText('restricted', 'admin', 'Аня', false)).toBe(
      'Аня снят(а) с администраторов и ограничен(а) в отправке сообщений'
    );
    expect(roleChangeSysText('restricted', 'admin', 'Аня', true)).toBe(
      'С вас сняты права администратора, отправка сообщений ограничена'
    );
    expect(roleChangeSysText('admin', 'restricted', 'Аня', false)).toBe(
      'Аня: ограничение снято, назначен(а) администратором'
    );
    expect(roleChangeSysText('admin', 'restricted', 'Аня', true)).toBe(
      'Ограничение снято, вы назначены администратором'
    );
  });

  it('неизвестная прежняя роль не ломает текст', () => {
    expect(roleChangeSysText('member', undefined, 'Аня', false)).toBe('Аня снят(а) с должности администратора');
  });
});

describe('число участников', () => {
  it('забаненный числится в таблице, но не в участниках', () => {
    // Строка с role='banned' — это чёрный список группы, а не участник: тот же
    // критерий, по которому список на экране их прячет.
    for (const role of ['owner', 'admin', 'member', 'restricted'] as const) {
      expect(countsAsMember(role)).toBe(true);
    }
    expect(countsAsMember('banned')).toBe(false);
  });

  it('роль без значения считается участником', () => {
    // Строки старых версий БД могли остаться без роли — потерять из-за этого
    // человека из счётчика хуже, чем посчитать лишнего.
    expect(countsAsMember(undefined)).toBe(true);
    expect(countsAsMember(null)).toBe(true);
  });

  it('считает список из group_members', () => {
    expect(countMembers([])).toBe(0);
    expect(
      countMembers([
        { role: 'owner' },
        { role: 'admin' },
        { role: 'member' },
        { role: 'restricted' },
        { role: 'banned' },
        { role: 'banned' },
      ])
    ).toBe(4);
  });

  it('повторный бан не меняет числа', () => {
    // Ровно та ошибка, из-за которой счётчик уезжал: раньше её считали
    // арифметикой ±1, и второй такой же конверт вычитал ещё раз.
    const before = [{ role: 'owner' as const }, { role: 'member' as const }, { role: 'member' as const }];
    const afterBan = [{ role: 'owner' as const }, { role: 'member' as const }, { role: 'banned' as const }];
    expect(countMembers(before)).toBe(3);
    expect(countMembers(afterBan)).toBe(2);
    expect(countMembers(afterBan)).toBe(countMembers(afterBan));
  });
});

/**
 * Смена роли по заблокированному (v4.32.618).
 *
 * Конверт op:'role' по забаненному проходит: canModerate придирается только к
 * владельцу и чужому админу. Прежняя роль 'banned' в тексте не разбиралась
 * вовсе, и снятие блокировки объявлялось как «снят(а) с должности
 * администратора» — неправда в обе стороны.
 */
describe('снятие блокировки через смену роли называется своим именем', () => {
  it('никакой текст не путает блокировку с должностью', () => {
    for (const next of ['member', 'admin', 'restricted'] as const) {
      const them = roleChangeSysText(next, 'banned', 'Рита', false);
      const me = roleChangeSysText(next, 'banned', 'Рита', true);
      for (const line of [them, me]) {
        expect(line).toMatch(/блокиров/i);
        expect(line).not.toContain('снят(а) с должности администратора');
        expect(line).not.toContain('С вас сняты права администратора');
      }
      expect(them).toContain('Рита');
      expect(me).not.toContain('Рита');
    }
  });

  it('снятие блокировки без новой роли звучит как обычный разбан', () => {
    // Тот же текст, что пишет ветка op:'unban': для человека это одно событие.
    expect(roleChangeSysText('member', 'banned', 'Рита', false)).toBe('Рита разблокирован(а)');
    expect(roleChangeSysText('member', 'banned', 'Рита', true)).toBe('Блокировка снята');
  });

  it('проверка не пустая: прежние ветки не задеты', () => {
    expect(roleChangeSysText('member', 'admin', 'Рита', false)).toBe('Рита снят(а) с должности администратора');
    expect(roleChangeSysText('member', 'restricted', 'Рита', false)).toBe('Рита снова может писать');
    expect(roleChangeSysText('admin', 'member', 'Рита', false)).toBe('Рита назначен(а) администратором');
    expect(roleChangeSysText('restricted', 'admin', 'Рита', false)).toBe(
      'Рита снят(а) с администраторов и ограничен(а) в отправке сообщений'
    );
  });
});

/**
 * Потолок чёрного списка (v4.32.618). Забаненный не виден нигде: ни в «N
 * участников», ни в списке участников, — а забанить можно и того, кого в
 * группе никогда не было. Роста таблицы это ничем не ограничивало.
 */
describe('чёрный список группы считается и ограничен', () => {
  it('считаются только забаненные', () => {
    const rows = [
      { role: 'owner' as const },
      { role: 'member' as const },
      { role: 'banned' as const },
      { role: 'restricted' as const },
      { role: 'banned' as const },
    ];
    expect(countBanned(rows)).toBe(2);
    expect(countMembers(rows)).toBe(3);
    expect(countBanned([])).toBe(0);
  });

  it('потолок есть и он выше любого честного списка приглашения', () => {
    expect(Number.isInteger(GROUP_BANLIST_MAX)).toBe(true);
    expect(GROUP_BANLIST_MAX).toBeGreaterThan(INVITE_MEMBERS_CAP);
    expect(GROUP_BANLIST_MAX).toBeLessThanOrEqual(4096);
  });
});
