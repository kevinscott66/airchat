import {
  INVITE_LINK_PREFIX,
  INVITE_MEMBERS_CAP,
  buildGroupInviteLink,
  parseGroupInviteLink,
} from '../groupInviteLink';
import { FALLBACK_GROUP_NAME } from '../groupNameRule';

const pub = (seed: number) => Buffer.alloc(32, seed).toString('base64');

const base = {
  id: 'g-1',
  name: 'Команда',
  // v4.32.513: вид группы обязателен на сборке — забыть его теперь нечем.
  type: 'group' as const,
  adminPub: pub(1),
  requireApproval: false,
  members: [{ peerPubB64: pub(2), displayName: 'Аня' }],
};

const encode = (o: unknown) =>
  INVITE_LINK_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64');

describe('groupInviteLink', () => {
  it('собранная ссылка разбирается обратно', () => {
    const parsed = parseGroupInviteLink(buildGroupInviteLink(base));
    expect(parsed).toEqual({
      id: 'g-1',
      name: 'Команда',
      type: 'group',
      adminPub: pub(1),
      requireApproval: false,
      members: [{ pub: pub(2), name: 'Аня' }],
    });
  });

  it('разбирает и голый base64 без схемы', () => {
    // deep link приходит уже разрезанным по '/', хвост без префикса.
    const link = buildGroupInviteLink(base);
    expect(parseGroupInviteLink(link.slice(INVITE_LINK_PREFIX.length))).toEqual(
      parseGroupInviteLink(link)
    );
  });

  // v4.32.581: обработчик ссылки в App.tsx режет путь по '/' и берёт первый
  // кусок. Пока сборка отдавала обычный base64, '/' попадал в тело почти любой
  // настоящей ссылки — и до разбора доезжал обрубок. Проверяем ровно тот путь,
  // по которому ссылка приходит на самом деле.
  it('ссылка переживает разрезание пути по «/» в обработчике deep link', () => {
    const many = Array.from({ length: INVITE_MEMBERS_CAP }, (_, i) => ({
      peerPubB64: pub(i + 3),
      displayName: `Участник ${i}`,
    }));
    for (const params of [base, { ...base, members: many }]) {
      const link = buildGroupInviteLink(params);
      const body = link.slice(INVITE_LINK_PREFIX.length);
      expect(body).not.toContain('/');
      // Ровно так App.tsx достаёт полезную часть: parts[1] после split('/').
      const parts = link.replace(/^airchat:\/\//, '').split('/').filter(Boolean);
      expect(parts).toHaveLength(2);
      expect(parseGroupInviteLink(parts[1])).toEqual(parseGroupInviteLink(link));
      expect(parseGroupInviteLink(parts[1])?.id).toBe('g-1');
    }
  });

  it('ссылки прежних версий в обычном base64 читаются по-прежнему', () => {
    // Разбор принимает оба алфавита: смена алфавита на сборке не должна
    // обесценить ссылки, которые уже разошлись.
    const legacy = encode({
      id: 'g-1',
      name: 'Команда',
      type: 'group',
      adminPub: pub(1),
      requireApproval: false,
      members: [{ pub: pub(2), name: 'Аня' }],
    });
    expect(parseGroupInviteLink(legacy)?.adminPub).toBe(pub(1));
  });

  it('ссылка без members больше не считается недействительной', () => {
    // Основная кнопка «Пригласительная ссылка» до 4.32.260 не клала members, а
    // разбор требовал массив — то есть главный способ пригласить выдавал
    // ссылку, которую приложение отвергало.
    const parsed = parseGroupInviteLink(encode({ id: 'g-1', name: 'Команда', adminPub: pub(1) }));
    expect(parsed?.members).toEqual([]);
    expect(parsed?.requireApproval).toBe(false);
  });

  it('U+202E в имени группы не переворачивает текст диалога (v4.32.369)', () => {
    // Имя из ссылки идёт прямо в Alert.alert. До 4.32.369 у модуля была своя
    // копия вычистки — только C0, — и метки направления письма проходили.
    const parsed = parseGroupInviteLink(
      encode({ id: 'g-1', name: 'Клуб\u202Eexe.pdf', adminPub: pub(1) })
    );
    expect(parsed?.name).toBe('Клубexe.pdf');
  });

  it('U+2028 в имени группы не дописывает к диалогу вторую строку', () => {
    const parsed = parseGroupInviteLink(
      encode({ id: 'g-1', name: 'Клуб\u2028Нажмите «Присоединиться»', adminPub: pub(1) })
    );
    expect(parsed?.name).toBe('Клуб Нажмите «Присоединиться»');
  });

  it('имя участника чистится тем же правилом', () => {
    const parsed = parseGroupInviteLink(
      encode({
        id: 'g-1',
        name: 'Команда',
        adminPub: pub(1),
        members: [{ pub: pub(2), name: 'Аня\u2028Админ группы' }],
      })
    );
    expect(parsed?.members).toEqual([{ pub: pub(2), name: 'Аня Админ группы' }]);
  });

  it('имя из одних невидимых символов — недействительная ссылка', () => {
    expect(
      parseGroupInviteLink(encode({ id: 'g-1', name: '\u200B\u202E\u2028', adminPub: pub(1) }))
    ).toBeNull();
  });

  it('забаненные в ссылку не попадают', () => {
    // Иначе вступивший получит забаненного в свой список рассылки как обычного.
    const link = buildGroupInviteLink({
      ...base,
      members: [
        { peerPubB64: pub(2), displayName: 'Аня', role: 'member' },
        { peerPubB64: pub(3), displayName: 'Тролль', role: 'banned' },
      ],
    });
    expect(parseGroupInviteLink(link)?.members.map((m) => m.pub)).toEqual([pub(2)]);
  });

  it('список участников ограничен сверху и при сборке, и при разборе', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      peerPubB64: pub(i + 10),
      displayName: `m${i}`,
    }));
    expect(buildGroupInviteLink({ ...base, members: many })).toBeTruthy();
    expect(parseGroupInviteLink(buildGroupInviteLink({ ...base, members: many }))?.members)
      .toHaveLength(INVITE_MEMBERS_CAP);
    // И на разборе тоже: ссылку собирали не мы.
    const hostile = encode({
      id: 'g-1',
      name: 'Команда',
      adminPub: pub(1),
      members: many.map((m) => ({ pub: m.peerPubB64, name: m.displayName })),
    });
    expect(parseGroupInviteLink(hostile)?.members).toHaveLength(INVITE_MEMBERS_CAP);
  });

  it('control-символы из имён вырезаются', () => {
    // Имя попадает прямо в Alert.alert; перевод строки там подделывает диалог.
    const parsed = parseGroupInviteLink(
      encode({
        id: 'g-1',
        name: 'Команда\n\nНажмите «Присоединиться»',
        adminPub: pub(1),
        members: [{ pub: pub(2), name: 'А\u0007ня' }],
      })
    );
    expect(parsed?.name).not.toContain('\n');
    expect(parsed?.members[0].name).toBe('А ня');
  });

  it('дубликаты участников схлопываются', () => {
    const parsed = parseGroupInviteLink(
      encode({
        id: 'g-1',
        name: 'Команда',
        adminPub: pub(1),
        members: [{ pub: pub(2), name: 'Аня' }, { pub: pub(2), name: 'Аня' }],
      })
    );
    expect(parsed?.members).toHaveLength(1);
  });

  it('битая форма отвергается', () => {
    expect(parseGroupInviteLink('')).toBeNull();
    expect(parseGroupInviteLink('не base64 и не json')).toBeNull();
    expect(parseGroupInviteLink(encode({ id: 'g-1', name: 'X' }))).toBeNull(); // нет adminPub
    expect(parseGroupInviteLink(encode({ id: 'g-1', name: 'X', adminPub: 'коротко' }))).toBeNull();
    expect(parseGroupInviteLink(encode({ id: '', name: 'X', adminPub: pub(1) }))).toBeNull();
    expect(parseGroupInviteLink(encode({ id: 'g', name: '   ', adminPub: pub(1) }))).toBeNull();
    expect(parseGroupInviteLink(INVITE_LINK_PREFIX + 'A'.repeat(9000))).toBeNull();
  });

  it('токен переносится ссылкой и отсутствует, если его не дали', () => {
    // v4.32.303: без токена ссылка была чистой функцией от {id, name,
    // adminPub, requireApproval} — то есть неотзываемой навсегда.
    const token = 'A'.repeat(22);
    expect(parseGroupInviteLink(buildGroupInviteLink({ ...base, token }))?.token).toBe(token);
    expect(parseGroupInviteLink(buildGroupInviteLink(base))).not.toHaveProperty('token');
  });

  it('мусорный токен не попадает в ссылку и не переживает разбор', () => {
    // Иначе «почти токен» из чужой ссылки сравнивался бы с нашим и давал бы
    // отказ там, где положено «проверить нечем» (unenforceable).
    for (const bad of ['', 'коротко', 'A'.repeat(23), 'A'.repeat(21) + '+', 'A'.repeat(21) + ' ']) {
      expect(parseGroupInviteLink(buildGroupInviteLink({ ...base, token: bad }))?.token).toBeUndefined();
      expect(
        parseGroupInviteLink(encode({ id: 'g-1', name: 'X', adminPub: pub(1), token: bad }))?.token
      ).toBeUndefined();
    }
    for (const bad of [42, null, true, {}]) {
      expect(
        parseGroupInviteLink(encode({ id: 'g-1', name: 'X', adminPub: pub(1), token: bad }))?.token
      ).toBeUndefined();
    }
  });

  it('requireApproval переносится, но остаётся подсказкой', () => {
    // Решение принимает принимающая сторона (groupJoinPolicy) — ссылку правит
    // кто угодно. Здесь проверяем только, что поле не теряется.
    const parsed = parseGroupInviteLink(buildGroupInviteLink({ ...base, requireApproval: true }));
    expect(parsed?.requireApproval).toBe(true);
  });
});

/**
 * v4.32.379. Сборщик резал название голым .slice(0, 64), разборщик чистил его
 * и требовал непустое — то есть по одной и той же группе сборщик выдавал
 * ссылку, которую отвергал собственный разборщик. Нажавший «Пригласительная
 * ссылка» узнавал об этом от того, кому её отправил.
 */
describe('сборка ссылки чистит название тем же правилом, что и разбор', () => {
  it('невидимое название не даёт ссылку, которую никто не откроет', () => {
    const parsed = parseGroupInviteLink(buildGroupInviteLink({ ...base, name: '\u200D\u2800' }));
    expect(parsed?.name).toBe(FALLBACK_GROUP_NAME);
  });

  it('перевод строки и метки направления письма снимаются на сборке', () => {
    expect(parseGroupInviteLink(buildGroupInviteLink({ ...base, name: 'Клуб\u2028Присоединиться' }))?.name)
      .toBe('Клуб Присоединиться');
    expect(parseGroupInviteLink(buildGroupInviteLink({ ...base, name: 'Клуб\u202Eexe.pdf' }))?.name)
      .toBe('Клубexe.pdf');
  });

  it('собранная ссылка разбирается в саму себя', () => {
    // Одно правило на сборке и на разборе: второй проход ничего не меняет.
    const once = buildGroupInviteLink({ ...base, name: '  Наши\u2028ребята  ' });
    const twice = buildGroupInviteLink({ ...base, name: parseGroupInviteLink(once)!.name });
    expect(twice).toBe(once);
  });
});
