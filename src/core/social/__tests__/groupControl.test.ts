/**
 * Unit tests for the group control envelope ('\x0egctl:').
 *
 * Only the pure encode/decode half is covered here — handleIncomingGroupControl
 * touches SQLite and the messaging singleton, so it belongs to integration
 * testing. The validator is the security-relevant part: everything it lets
 * through is written straight into group_members / groups.
 */

import {
  GROUP_CTL_PREFIX,
  encodeGroupCtlEnvelope,
  decodeGroupCtlEnvelope,
  type GroupCtlEnvelope,
} from '../groupControlEnvelope';

const PUB = 'A'.repeat(43);
/** Пригласительный токен: 16 случайных байт в base64url — ровно 22 символа. */
const TOKEN = 'A'.repeat(22);

function env(over: Partial<GroupCtlEnvelope> = {}): GroupCtlEnvelope {
  return { groupId: 'g1', ts: 1_700_000_000_000, op: 'ban', target: PUB, ...over } as GroupCtlEnvelope;
}

describe('group control envelope', () => {
  it('не пересекается с остальными префиксами протокола', () => {
    expect(GROUP_CTL_PREFIX).toBe('\x0egctl:');
    for (const other of ['\x01voice:', '\x02grp:', '\x03grpr:', '\x04poll:', '\x05contact:', '\x0agjr:', '\x0bsys:', '\x0cliveloc:']) {
      expect(GROUP_CTL_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(GROUP_CTL_PREFIX)).toBe(false);
    }
  });

  it('round-trip для каждой операции', () => {
    const cases: GroupCtlEnvelope[] = [
      env({ op: 'join', targetName: 'Новичок' }),
      env({ op: 'ban' }),
      env({ op: 'unban' }),
      env({ op: 'kick' }),
      env({ op: 'add', targetName: 'Боб' }),
      env({ op: 'role', role: 'admin' } as Partial<GroupCtlEnvelope>),
      { groupId: 'g1', ts: 1, op: 'meta', name: 'Новое имя', adminOnlyPosting: true, slowModeSeconds: 30 },
    ];
    for (const c of cases) {
      expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(c))).toEqual(c);
    }
  });

  it('чужой префикс — не наш конверт', () => {
    expect(decodeGroupCtlEnvelope('\x02grp:{}')).toBeNull();
    expect(decodeGroupCtlEnvelope('обычное сообщение')).toBeNull();
  });

  it('битый JSON не роняет парсер', () => {
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + '{не json')).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + 'null')).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + '"строка"')).toBeNull();
  });

  it('отбрасывает конверт больше 64 КБ до JSON.parse', () => {
    const huge = GROUP_CTL_PREFIX + JSON.stringify({ ...env(), pad: 'x'.repeat(70_000) });
    expect(decodeGroupCtlEnvelope(huge)).toBeNull();
  });

  it('неизвестная операция отбрасывается', () => {
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), op: 'drop_table' }))).toBeNull();
  });

  it('target обязан быть похож на base64 Ed25519-ключ', () => {
    for (const bad of ['', 'коротко', 'B'.repeat(200), 42, null]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), target: bad }))).toBeNull();
    }
  });

  it('role принимает admin/member/restricted — не owner и не banned', () => {
    for (const bad of ['owner', 'banned', 'root', '', null]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), op: 'role', role: bad }))).toBeNull();
    }
    for (const good of ['admin', 'member', 'restricted']) {
      const ok = decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), op: 'role', role: good }));
      expect(ok?.op).toBe('role');
      expect((ok as { role?: string } | null)?.role).toBe(good);
    }
  });

  it('обрезает недоверенные строки вместо того, чтобы их отбрасывать', () => {
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ ...env(), targetName: 'и'.repeat(500), actorName: 'а'.repeat(500) })
    );
    expect(d).not.toBeNull();
    expect((d as { targetName: string }).targetName).toHaveLength(64);
    expect(d?.actorName).toHaveLength(64);
  });

  it('meta: имя и описание обрезаются, slowmode зажимается в [0, 86400]', () => {
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', name: 'н'.repeat(500), description: 'о'.repeat(9000).slice(0, 4000), slowModeSeconds: 999_999 })
    );
    expect(d).not.toBeNull();
    const m = d as { name: string; description: string; slowModeSeconds: number };
    expect(m.name).toHaveLength(128);
    expect(m.description).toHaveLength(512);
    expect(m.slowModeSeconds).toBe(86400);

    const neg = decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', slowModeSeconds: -5 }));
    expect((neg as { slowModeSeconds: number }).slowModeSeconds).toBe(0);
  });

  it('meta: аватар — только настоящий CID или nb:-дескриптор', () => {
    const ok = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', avatarCid: 'Q'.repeat(46) })
    );
    expect((ok as { avatarCid: string }).avatarCid).toBe('Q'.repeat(46));

    const nb = 'nb:' + JSON.stringify({ u: 'https://ntfy.example/file/abc', k: 'a'.repeat(43) });
    expect(
      (decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', avatarCid: nb })) as { avatarCid: string }).avatarCid
    ).toBe(nb);

    // Маяк: подставленный адрес увёл бы загрузку аватара на чужой сервер и
    // выдал IP получателя при первой же отрисовке списка групп.
    for (const bad of ['../../evil.example/p.png', 'x/../../y', 'http://evil.example/p.png', '', 42, 'nb:{"k":"нет источника"}']) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', avatarCid: bad }))).toBeNull();
    }

    // Отсутствующий аватар — не ошибка: конверт meta несёт только изменённые поля.
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', avatarCid: null }))).not.toBeNull();
  });

  it('meta с нечисловым slowmode / нелогическим adminOnlyPosting отбрасывается', () => {
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', slowModeSeconds: 'много' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', adminOnlyPosting: 'yes' }))).toBeNull();
  });

  it('invite: round-trip со списком участников', () => {
    const inv: GroupCtlEnvelope = {
      groupId: 'g1', ts: 1, op: 'invite', groupName: 'Тестовая',
      groupType: 'group',
      members: [{ pub: PUB, name: 'Алиса' }, { pub: 'B'.repeat(44), name: null }],
      avatarCid: 'Q'.repeat(46),
      actorName: 'Алиса',
    };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(inv))).toEqual(inv);

    // Приглашение с подставленным «CID» отбрасывается целиком: аватар грузится
    // сам при первой же отрисовке списка групп.
    expect(
      decodeGroupCtlEnvelope(encodeGroupCtlEnvelope({ ...inv, avatarCid: '../../evil.example/p.png' }))
    ).toBeNull();
  });

  it('invite: без имени группы или со списком не-массивом отбрасывается', () => {
    const base = { groupId: 'g1', ts: 1, op: 'invite', members: [] };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...base, groupName: '' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...base, groupName: '   ' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...base, groupName: 42 }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'invite', groupName: 'Ok', members: 'все' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...base, groupName: 'Ok', groupType: 'admin' }))).toBeNull();
  });

  it('invite: мусорные участники выбрасываются, список режется до 200', () => {
    const members = [
      { pub: PUB, name: 'ок' },
      { pub: 'коротко' },
      null,
      'строка',
      { name: 'без ключа' },
      ...Array.from({ length: 400 }, () => ({ pub: 'C'.repeat(43) })),
    ];
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'invite', groupName: 'Ok', members })
    );
    expect(d).not.toBeNull();
    const list = (d as { members: { pub: string; name: string | null }[] }).members;
    // 200 первых записей, из них 4 мусорных отфильтрованы → 196.
    expect(list).toHaveLength(196);
    expect(list.every((m) => m.pub.length >= 43)).toBe(true);
  });

  it('invite: control-символы вычищаются из имён', () => {
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({
        groupId: 'g1', ts: 1, op: 'invite',
        groupName: 'Гру\u0007ппа\u0000',
        members: [{ pub: PUB, name: 'Бо\u001Fб' }],
      })
    );
    expect(d).not.toBeNull();
    const inv = d as { groupName: string; members: { name: string }[] };
    // v4.32.374: пробел вместо управляющего символа остаётся внутри имени, но
    // не по краям — тот, что был на конце, теперь срезается.
    expect(inv.groupName).toBe('Гру ппа');
    expect(inv.members[0].name).toBe('Бо б');
  });

  it('перевод строки в имени не подделывает вторую системную строку', () => {
    // Имя попадает в системную строку группы, а она рисуется серым по центру и
    // читается как сообщение от приложения. Без вычистки '\n' любое имя
    // дописывает к ней собственную строку от имени AirChat — причём для
    // op='join' на это не нужно вообще никаких прав.
    const forged = 'Иван\nВы заблокированы в этой группе';
    const join = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'join', target: PUB, targetName: forged })
    );
    expect((join as { targetName: string }).targetName).not.toContain('\n');

    const kick = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'kick', target: PUB, actorName: forged })
    );
    expect(kick?.actorName).not.toContain('\n');

    const meta = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', name: `Чат\r\n${'\x0b'}sys:группа удалена` })
    );
    const renamed = (meta as { name: string }).name;
    for (const c of ['\r', '\n', '\x0b']) expect(renamed).not.toContain(c);
    expect(renamed.startsWith('Чат')).toBe(true);
  });

  it('edit/del: round-trip и валидация msgId', () => {
    const ed = { groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1', text: 'исправлено' };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(ed))).toEqual(ed);
    const del = { groupId: 'g1', ts: 1, op: 'del', msgId: 'm1' };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(del))).toEqual(del);
    for (const bad of ['', 42, null, 'm'.repeat(200)]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...del, msgId: bad }))).toBeNull();
    }
  });

  it('edit: текст обязателен и живёт по общему потолку сообщения (v4.32.530)', () => {
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1', text: 42 }))).toBeNull();
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1', text: 'я'.repeat(9000) })
    );
    expect((d as { text: string }).text).toHaveLength(9000);
  });

  it('pin: round-trip и обязательный boolean on', () => {
    const pin = { groupId: 'g1', ts: 1, op: 'pin', msgId: 'm1', on: true };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(pin))).toEqual(pin);
    const unpin = { groupId: 'g1', ts: 1, op: 'pin', msgId: 'm1', on: false };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(unpin))).toEqual(unpin);
    for (const bad of [undefined, null, 1, 0, 'true', '']) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...pin, on: bad }))).toBeNull();
    }
    for (const bad of ['', 42, null, 'm'.repeat(200)]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...pin, msgId: bad }))).toBeNull();
    }
  });

  it('pin: текст баннера через конверт не протаскивается', () => {
    // Получатель обязан взять текст из своей строки group_messages — иначе
    // закрепление стало бы способом показать группе произвольный текст.
    const d = decodeGroupCtlEnvelope(
      GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'pin', msgId: 'm1', on: true, text: 'подделка' })
    );
    expect(d?.op).toBe('pin');
    expect((d as unknown as { text?: string }).text).toBeUndefined();
  });

  it('meta: adminOnlyPinning — только boolean', () => {
    const m = { groupId: 'g1', ts: 1, op: 'meta', adminOnlyPinning: false };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toEqual(m);
    for (const bad of [1, 'да', {}]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, adminOnlyPinning: bad }))).toBeNull();
    }
  });

  it('meta: requireApproval — только boolean', () => {
    const m = { groupId: 'g1', ts: 1, op: 'meta', requireApproval: true };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toEqual(m);
    for (const bad of [1, 'да', {}]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, requireApproval: bad }))).toBeNull();
    }
  });

  it('meta: anonymousPosting — только boolean', () => {
    const m = { groupId: 'g1', ts: 1, op: 'meta', anonymousPosting: false };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toEqual(m);
    for (const bad of [1, 'нет', []]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, anonymousPosting: bad }))).toBeNull();
    }
  });

  it('meta: обе настройки переживают кодирование вместе с остальными', () => {
    const m = {
      groupId: 'g1',
      ts: 7,
      op: 'meta' as const,
      adminOnlyPosting: true,
      requireApproval: true,
      anonymousPosting: true,
    };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(m))).toEqual(m);
  });

  it('meta: disappearMs — общий таймер группы', () => {
    for (const ms of [0, 60_000, 86_400_000, 365 * 24 * 60 * 60 * 1000]) {
      const m = { groupId: 'g1', ts: 1, op: 'meta', disappearMs: ms };
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toEqual(m);
    }
  });

  it('meta: дистанционное уничтожение истории группы невозможно', () => {
    // Таймер короче минуты означал бы «сотри всё сейчас» у каждого участника,
    // поэтому конверт отбрасывается целиком, а не зажимается до границы.
    const m = { groupId: 'g1', ts: 1, op: 'meta' };
    for (const bad of [1, 100, 59_999, -60_000, 366 * 24 * 60 * 60 * 1000]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, disappearMs: bad }))).toBeNull();
    }
    for (const bad of ['60000', 60_000.5, true, {}]) {
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, disappearMs: bad }))).toBeNull();
    }
    // null/отсутствие поля — «настройка не менялась», как и у остальных полей meta.
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, disappearMs: null }))).toEqual({ ...m, disappearMs: null });
  });

  it('join: пригласительный токен переживает кодирование', () => {
    // v4.32.303: ссылка перестала быть чистой функцией от публичных данных —
    // в ней едет токен, и только он отличает действующую ссылку от отозванной.
    const m = { groupId: 'g1', ts: 1, op: 'join' as const, target: PUB, targetName: 'Новичок', inviteToken: TOKEN };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(m))).toEqual(m);
  });

  it('join: мусорный токен выбрасывается, а заявка остаётся', () => {
    // Отбросить конверт целиком нельзя: старые сборки токена не шлют вовсе, а
    // решение «пускать или нет» принимает приёмник, а не кодек.
    for (const bad of ['', 'коротко', 'A'.repeat(23), 'A'.repeat(21) + '+', 42, true, {}]) {
      const d = decodeGroupCtlEnvelope(
        GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'join', target: PUB, inviteToken: bad })
      );
      expect(d?.op).toBe('join');
      expect((d as unknown as { inviteToken?: string }).inviteToken).toBeUndefined();
    }
  });

  it('meta: токен рассылается только админам и обязан быть настоящим', () => {
    const ok = { groupId: 'g1', ts: 1, op: 'meta' as const, inviteToken: TOKEN };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(ok))).toEqual(ok);

    // Здесь, в отличие от join, конверт отбрасывается целиком: полу-принятый
    // meta записал бы в groups.invite_token мусор и запер бы группу от всех.
    for (const bad of ['', 'коротко', 'A'.repeat(23), 42, true, {}]) {
      expect(
        decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1, op: 'meta', inviteToken: bad }))
      ).toBeNull();
    }
  });

  it('joinres: ответ на заявку переживает кодирование', () => {
    for (const status of ['pending', 'rejected', 'revoked'] as const) {
      const m = { groupId: 'g1', ts: 5, op: 'joinres' as const, target: PUB, status };
      expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(m))).toEqual(m);
    }
  });

  it('joinres: чужой status отбрасывается целиком', () => {
    // Статус решает, что человек прочитает о своей заявке; неизвестное
    // значение не должно проваливаться в ветку «отказано» по умолчанию.
    for (const bad of ['approved', '', 'PENDING', 1, true, null, undefined]) {
      const m = { groupId: 'g1', ts: 5, op: 'joinres', target: PUB, status: bad };
      expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toBeNull();
    }
  });

  it('joinres: адресат обязан быть ключом', () => {
    const m = { groupId: 'g1', ts: 5, op: 'joinres', status: 'pending' };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, target: 'x' }))).toBeNull();
  });

  it('leave: выход из группы переживает кодирование', () => {
    const m = { groupId: 'g1', ts: 5, op: 'leave' as const, target: PUB, targetName: 'Аня' };
    expect(decodeGroupCtlEnvelope(encodeGroupCtlEnvelope(m))).toEqual(m);
  });

  it('leave: адресат обязан быть ключом', () => {
    // Выйти можно только самому — совпадение target с отправителем проверяет
    // приёмник, но форму ключа обязан отсеять кодек.
    const m = { groupId: 'g1', ts: 5, op: 'leave' };
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify(m))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, target: 'x' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...m, target: null }))).toBeNull();
  });

  it('groupId и ts обязательны', () => {
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), groupId: '' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), groupId: 'g'.repeat(200) }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), ts: 'вчера' }))).toBeNull();
    expect(decodeGroupCtlEnvelope(GROUP_CTL_PREFIX + JSON.stringify({ ...env(), ts: NaN }))).toBeNull();
  });
});
