/**
 * Канал, в который вошли по ссылке, остаётся каналом (v4.32.513).
 *
 * Дефект. Пригласительная ссылка несла всё, кроме одного: вида группы.
 * Обработчик deep link заводил группу литералом — `createGroup(payload.id,
 * pid, safeName, 'group', undefined, false)`, — и вошедший в КАНАЛ получал у
 * себя обычную группу.
 *
 * Само по себе это разошедшаяся строка в базе; беда в том, что чинить её было
 * потом нечем. `createGroup` — это INSERT OR IGNORE, ветка 'invite' на уже
 * известной группе выходит первой же строкой (`if (group) return true`), а
 * конверт 'meta' вида не несёт вовсе. То есть вид оставался неверным навсегда.
 *
 * Что из этого выходило. Право писать проверяется по СВОЕЙ строке группы — и у
 * отправителя, и у каждого получателя (canSendToGroup зовут обе стороны, это
 * прямо оговорено в groupSendPolicy). У подписчика вид 'group', у всех
 * остальных 'channel'. Значит:
 *
 *   • подписчик видел поле ввода «Сообщение» вместо неактивного «Новый
 *     пост…», писал — и его сообщение ложилось к нему в историю как
 *     отправленное, а на каждом чужом устройстве отбрасывалось с
 *     `group_msg_denied_drop`. Ни ошибки, ни повтора: со стороны это выглядит
 *     как «написал в канал, никто не ответил»;
 *   • правка и удаление своего старого сообщения — то же самое
 *     (canApplyGroupMessageOp зовёт canSendToGroup);
 *   • закрепление: canPinInGroup для канала отказывает подписчику всегда, а у
 *     него `adminOnlyPinning` по умолчанию выключен — закреплял он только у
 *     себя;
 *   • и весь экран называл канал группой: аватар, «N уч.» вместо «Канал»,
 *     «Нет сообщений» вместо «Нет постов», «Настройки группы», плюс два
 *     админских пункта меню, которые в канале не показываются.
 *
 * Дорога с одобрением была исправна: одобряющий администратор шлёт конверт
 * 'invite', и тот вид несёт (groupType). Ломалась ровно ссылка без одобрения.
 */
import fs from 'fs';
import path from 'path';

import { buildGroupInviteLink, parseGroupInviteLink, INVITE_LINK_PREFIX } from '../groupInviteLink';
import { canSendToGroup, canApplyGroupMessageOp, GROUP_TYPES, isGroupType } from '../groupSendPolicy';
import { canPinInGroup } from '../groupPinPolicy';

const pub = (seed: number) => Buffer.alloc(32, seed).toString('base64');

const ADMIN = pub(1);
const SUBSCRIBER = pub(2);

const channelLink = () =>
  buildGroupInviteLink({
    id: 'ch-1',
    name: 'Объявления',
    type: 'channel',
    adminPub: ADMIN,
    requireApproval: false,
    members: [{ peerPubB64: ADMIN, displayName: 'Хозяин' }],
  });

const encode = (o: unknown) => INVITE_LINK_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64');

describe('вид группы переживает пригласительную ссылку', () => {
  it('канал разбирается каналом', () => {
    expect(parseGroupInviteLink(channelLink())?.type).toBe('channel');
  });

  it('и супергруппа, и обычная группа — тоже собой', () => {
    for (const type of GROUP_TYPES) {
      const link = buildGroupInviteLink({
        id: 'g-1',
        name: 'Двор',
        type,
        adminPub: ADMIN,
        requireApproval: false,
        members: [],
      });
      expect(parseGroupInviteLink(link)?.type).toBe(type);
    }
  });

  it('ссылка прежней версии без вида читается как группа', () => {
    // Совместимость: до v4.32.513 поля не было ни в одной выданной ссылке, и
    // ответ для них обязан остаться тем же, что и был.
    const parsed = parseGroupInviteLink(
      encode({ id: 'g-1', name: 'Двор', adminPub: ADMIN, requireApproval: false, members: [] })
    );
    expect(parsed?.type).toBe('group');
  });

  it('мусор в поле вида не отвергает ссылку целиком', () => {
    // То же решение, что у token: разобрать можно всё остальное, а отказ здесь
    // означал бы «Недействительная ссылка приглашения» на живой ссылке.
    for (const bad of ['supergroup ', 'Channel', '', 42, null, {}, ['channel']]) {
      const parsed = parseGroupInviteLink(
        encode({ id: 'g-1', name: 'Двор', type: bad, adminPub: ADMIN, requireApproval: false, members: [] })
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('group');
    }
  });

  it('вид не теряется при повторной сборке из разобранного', () => {
    const once = channelLink();
    const parsed = parseGroupInviteLink(once)!;
    const twice = buildGroupInviteLink({
      id: parsed.id,
      name: parsed.name,
      type: parsed.type,
      adminPub: parsed.adminPub,
      requireApproval: parsed.requireApproval,
      members: parsed.members.map((m) => ({ peerPubB64: m.pub, displayName: m.name })),
    });
    expect(twice).toBe(once);
  });
});

describe('вошедший по ссылке судит о своих правах так же, как остальные', () => {
  /** Вердикт устройства, у которого строка группы вида `type`. */
  const verdictAt = (type: 'group' | 'channel' | 'supergroup') =>
    canSendToGroup({ role: 'member', type, adminOnlyPosting: false }).allowed;

  it('подписчик канала не пишет — и знает об этом до отправки', () => {
    const joined = parseGroupInviteLink(channelLink())!;
    expect(verdictAt(joined.type)).toBe(false);
    expect(canSendToGroup({ role: 'member', type: joined.type, adminOnlyPosting: false })).toEqual({
      allowed: false,
      code: 'channel_admin_only',
      reason: 'В канале публикуют только администраторы',
    });
  });

  it('его вердикт совпадает с вердиктом каждого чужого устройства', () => {
    // Единственное, что вообще нужно от вида: обе стороны обязаны ответить
    // одинаково. Разойдясь, они дают сообщение, отправленное у себя и
    // отброшенное у всех.
    const mine = parseGroupInviteLink(channelLink())!.type;
    const theirs = 'channel' as const;
    expect(verdictAt(mine)).toBe(verdictAt(theirs));
  });

  it('правка старого сообщения запрещена той же проверкой', () => {
    const joined = parseGroupInviteLink(channelLink())!;
    expect(
      canApplyGroupMessageOp({
        op: 'edit',
        role: 'member',
        isAuthor: true,
        type: joined.type,
        adminOnlyPosting: false,
      }).allowed
    ).toBe(false);
  });

  it('и закрепление — тоже', () => {
    const joined = parseGroupInviteLink(channelLink())!;
    expect(canPinInGroup({ role: 'member', adminOnlyPinning: false, type: joined.type })).toBe(false);
  });

  it('в обычной группе вошедший по ссылке пишет как прежде', () => {
    // Правка не отбирает ничего у той дороги, которая работала.
    const link = buildGroupInviteLink({
      id: 'g-1',
      name: 'Двор',
      type: 'group',
      adminPub: ADMIN,
      requireApproval: false,
      members: [{ peerPubB64: SUBSCRIBER, displayName: 'Гость' }],
    });
    const joined = parseGroupInviteLink(link)!;
    expect(verdictAt(joined.type)).toBe(true);
  });
});

describe('BEFORE — чем отвечал прежний вопрос', () => {
  it('литеральный «group» расходился с чужими устройствами на канале', () => {
    // Ровно то, что стояло в App.tsx: вид не спрашивали у ссылки, а вписывали.
    const asBefore = 'group' as const;
    const link = parseGroupInviteLink(channelLink())!;
    expect(link.type).toBe('channel');
    expect(canSendToGroup({ role: 'member', type: asBefore, adminOnlyPosting: false }).allowed).toBe(true);
    expect(canSendToGroup({ role: 'member', type: link.type, adminOnlyPosting: false }).allowed).toBe(false);
  });

  it('и весь экран звал канал группой — по той же строке в базе', () => {
    // Экран нигде не спрашивает про вид отдельно: и «Канал» в шапке, и
    // «Новый пост…», и «Нет постов», и скрытые в канале пункты меню читают
    // ровно `group.type`. Значит, неверная строка в базе переименовывала
    // канал в группу по всему экрану сразу — и та же строка, став верной,
    // чинит всё это без единой правки в UI.
    const screen = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
      'utf8'
    );
    expect(screen.split("group.type === 'channel'").length - 1).toBeGreaterThanOrEqual(5);
    expect(screen).toContain("group.type !== 'channel'");
  });
});

/**
 * Рэтчет формы. Вид группы обязан приезжать из полезной нагрузки ссылки, а не
 * вписываться литералом рядом с ней.
 */
describe('форма исходников', () => {
  const SRC = path.join(__dirname, '..', '..', '..');

  it('обработчик ссылки не подставляет вид сам (v4.32.513)', () => {
    const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('createGroup(payload.id, pid, safeName, payload.type, undefined, false)');
    expect(app).not.toContain("createGroup(payload.id, pid, safeName, 'group'");
  });

  it('все сборщики ссылки передают вид', () => {
    const screen = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
    const builds = screen.split('buildGroupInviteLink({').slice(1);
    expect(builds.length).toBe(3);
    for (const tail of builds) expect(tail.slice(0, 400)).toMatch(/\btype: g(roup)?\.type,/);
  });

  it('перечень видов группы не переписан литералами в третий раз', () => {
    // Разбор конверта 'invite' и разбор ссылки спрашивают одно и то же
    // правило; вторая копия — это копия, которая разойдётся.
    const env = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupControlEnvelope.ts'), 'utf8');
    const invite = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupInviteLink.ts'), 'utf8');
    for (const src of [env, invite]) {
      expect(src).toContain('isGroupType(');
      expect(src).not.toMatch(/!== 'channel' && .* !== 'supergroup'/);
    }
  });

  it('сам страж узнаёт ровно три вида', () => {
    for (const t of GROUP_TYPES) expect(isGroupType(t)).toBe(true);
    for (const t of ['', 'chanel', 'GROUP', ' group', 'post', 0, null, undefined, ['group']]) {
      expect(isGroupType(t)).toBe(false);
    }
    expect(GROUP_TYPES).toEqual(['group', 'channel', 'supergroup']);
  });
});
