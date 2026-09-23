/**
 * Занятая база больше не выдаёт себя за пустую группу (v4.32.762).
 *
 * Дефект. `listGroupMembers` на отказе чтения отдаёт пустой список — это её
 * задокументированное свойство, ради него в v4.32.648 и завели различающую
 * `listGroupMembersRead`. Но семь мест, где состав нужен для ДЕЙСТВИЯ, а не
 * для справки, так и читали сплющивающей обёрткой, и каждое делало из отказа
 * базы утверждение, которого база не делала:
 *
 *   • приглашение (`sendGroupInvite`): владелец не находился в пустом составе,
 *     и конверт уходил БЕЗ ownerPub — ровно таким, каким был до v4.32.615: у
 *     приглашённого владельца группы не существует, он лежит рядовым
 *     участником, и выгнать его вправе любой администратор. Повторной отправки
 *     у приглашения нет, второго конверта не будет никогда, а пригласивший
 *     видит «отправлено»;
 *   • одобрение заявки: проверка бана шла по пустому списку и проходила
 *     вхолостую — забаненный возвращался в группу одним нажатием, то есть
 *     открывалась та самая дыра, что закрыта в v4.32.230;
 *   • обе кнопки пригласительной ссылки: наружу уходила ссылка с пустым
 *     составом, и вошедший по ней заводил группу, в которой кроме него и
 *     админа нет никого. Ссылку пересылают и открывают неделями;
 *   • `/unban`: отказ базы отвечал «заблокированный участник не найден» —
 *     администратор верил и переставал искать;
 *   • выход из группы: владелец не находился в пустом составе и читал мягкий
 *     текст для рядового участника — перед необратимым действием, после
 *     которого группа остаётся без владельца навсегда;
 *   • состав в карточке и подсказки @-упоминаний: пустой список стирал с
 *     экрана и участников, и чёрный список.
 *
 * Правка. Все семь читают `listGroupMembersRead`. Действие отказывает одним
 * текстом на весь экран (`MEMBERS_UNREADABLE`, слово в слово как у опроса и
 * реакции), справка молча оставляет прежнее значение.
 */

/** Состав группы. `null` — не прочитался, как у настоящей listGroupMembersRead. */
let mockRoster: { peerPubB64: string; role: string }[] | null = null;
/** Что ответит чтение строки группы: 'found' | 'failed'. */
let mockGroupState: 'found' | 'failed' = 'found';
/** Разосланные конверты: операция и полезная нагрузка. */
const mockSent: { op: string; payload: string }[] = [];

jest.mock('../../storage/local', () => ({
  // Сплющивающая обёртка на месте: прогон ДО правки должен идти по настоящему
  // коду, а не спотыкаться об отсутствующее имя.
  listGroupMembers: jest.fn(async () => mockRoster ?? []),
  listGroupMembersRead: jest.fn(async () => mockRoster),
  getGroup: jest.fn(async () => (mockGroupState === 'found' ? { avatarCid: mockAvatarCid } : null)),
  getGroupRead: jest.fn(async () =>
    mockGroupState === 'found'
      ? { state: 'found', value: { avatarCid: mockAvatarCid } }
      : { state: 'failed' }
  ),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 1, name: 'Личный' }),
    getActiveIdentity: () => ({ pid: 1, myPubB64: 'M'.repeat(43) }),
  },
}));

jest.mock('../controlFanout', () => ({
  activeRecipients: (members: { peerPubB64: string }[], self: string) =>
    members.filter((m) => m.peerPubB64 !== self).map((m) => m.peerPubB64),
  fanoutControlEnvelope: jest.fn(async (op: string, payload: string) => {
    mockSent.push({ op, payload });
    return { sent: true, recipients: 1 };
  }),
}));

jest.mock('../messaging', () => ({ getMessagingService: () => null }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { sendGroupInvite } from '../groupMessaging';
import { decodeGroupCtlEnvelope } from '../groupControlEnvelope';

/** CID аватара: 46 знаков — форма, которую пропускает isSafeMediaCid. */
const mockAvatarCid = 'Qm' + 'a'.repeat(44);

const ME = 'M'.repeat(43);
const OWNER = 'O'.repeat(43);
const PEER = 'P'.repeat(43);
const GID = 'g-invite-762';

/** Приглашение с одним и тем же набором доводов — меняется только состав базы. */
const invite = () =>
  sendGroupInvite(GID, 'Двор', 'group', [{ pub: PEER, name: 'Пётр' }], [PEER], 'Я');

/** Разобранное содержимое единственного ушедшего конверта. */
function sentEnvelope(): Record<string, unknown> {
  expect(mockSent).toHaveLength(1);
  const env = decodeGroupCtlEnvelope(mockSent[0].payload);
  expect(env).not.toBeNull();
  return env as unknown as Record<string, unknown>;
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

const MEMBERS_UNREADABLE = 'Не удалось прочитать состав группы. Попробуйте ещё раз.';

beforeEach(() => {
  mockRoster = [
    { peerPubB64: OWNER, role: 'owner' },
    { peerPubB64: ME, role: 'admin' },
    { peerPubB64: PEER, role: 'member' },
  ];
  mockGroupState = 'found';
  mockSent.length = 0;
});

describe('приглашение: нечитаемый состав — не группа без владельца', () => {
  it('состав не прочитался — приглашение не уходит вовсе', async () => {
    mockRoster = null;
    const res = await invite();
    expect(res).toEqual({ op: 'invite', sent: false, reason: 'members_unreadable' });
    // Главное: молчание. Ушедший конверт без владельца уже не догнать.
    expect(mockSent).toEqual([]);
  });

  it('база освободилась — то же приглашение уходит с владельцем', async () => {
    mockRoster = null;
    await invite();
    mockRoster = [{ peerPubB64: OWNER, role: 'owner' }];
    const res = await invite();
    expect(res).toEqual({ op: 'invite', sent: true, recipients: 1 });
    expect(sentEnvelope().ownerPub).toBe(OWNER);
  });

  it('причина названа тем же словом, что и у остальной рассылки', () => {
    // 'members_unreadable' — член FanoutUndelivered (v4.32.737), и фраза для
    // него уже написана. Отдельной причины «только для приглашения» быть не
    // должно: экран печатает её через общий groupControlProblem.
    const fanout = read('core/social/controlFanout.ts');
    expect(fanout).toContain("| 'members_unreadable'");
    expect(fanout).toContain('состав группы не прочитан');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отказ, который лечится повтором, человек повторит — а вот приглашение,
 * отменённое зря, он повторять не станет: он уже увидел «отправлено». Поэтому
 * терпимое обязано остаться терпимым: группа без владельца бывает настоящей
 * (её создали до v4.32.615), а аватар не стоит отменённого приглашения.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: терпимое осталось терпимым', () => {
  it('в составе правда нет владельца — приглашение уходит без ownerPub', async () => {
    mockRoster = [
      { peerPubB64: ME, role: 'admin' },
      { peerPubB64: PEER, role: 'member' },
    ];
    const res = await invite();
    expect(res.sent).toBe(true);
    expect(sentEnvelope().ownerPub).toBeUndefined();
  });

  it('строка группы не прочиталась — приглашение уходит без аватара', async () => {
    mockGroupState = 'failed';
    const res = await invite();
    expect(res.sent).toBe(true);
    const env = sentEnvelope();
    expect(env.avatarCid).toBeUndefined();
    // Владелец при этом на месте: отказ одного чтения не отменяет другого.
    expect(env.ownerPub).toBe(OWNER);
  });

  it('исправная база — уходит и владелец, и аватар', async () => {
    const res = await invite();
    expect(res).toEqual({ op: 'invite', sent: true, recipients: 1 });
    const env = sentEnvelope();
    expect(env.ownerPub).toBe(OWNER);
    expect(env.avatarCid).toBe(mockAvatarCid);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Сплющивающая обёртка никуда не делась — она нужна там, где пустой список
 * действительно ответ. Проверяем, что на путях ДЕЙСТВИЯ её больше нет: вернуть
 * её обратно значит вернуть и все шесть последствий разом.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('приглашение читает состав различающей обёрткой', () => {
    const body = codeOnly(read('core/social/groupMessaging.ts'));
    expect(body).toContain('await listGroupMembersRead(groupId, pid)');
    expect(body).toContain("return { op: 'invite', sent: false, reason: 'members_unreadable' };");
    expect(body).not.toContain('listGroupMembers(groupId, pid)');
  });

  it('экран групп не читает состав сплющивающей обёрткой нигде', () => {
    const body = codeOnly(read('ui/screens/GroupsScreen.tsx'));
    expect(body).not.toContain('listGroupMembers(');
    // Шесть мест: упоминания, /unban, ссылка из карточки, состав карточки,
    // одобрение заявки, выход, ссылка из строки списка.
    expect(body.split('listGroupMembersRead(').length - 1).toBe(7);
  });

  it('действие отказывает, а справка молчит', () => {
    const body = codeOnly(read('ui/screens/GroupsScreen.tsx'));
    // Отказ — один и тот же текст на весь экран, объявленный один раз.
    expect(body).toContain(`const MEMBERS_UNREADABLE = '${MEMBERS_UNREADABLE}';`);
    expect(body).toContain('if (all === null) { showError(MEMBERS_UNREADABLE); return; }');
    expect(body).toContain('if (roster === null) { showError(MEMBERS_UNREADABLE); return; }');
    expect(body).toContain('Alert.alert(\'AirChat\', MEMBERS_UNREADABLE);');
    // Справка прежнее значение не стирает.
    expect(body).toContain('if (ms === null) return;');
  });

  it('текст отказа — общий с опросом и реакцией, а не свой у каждого места', () => {
    const screen = read('ui/screens/GroupsScreen.tsx');
    const reaction = read('core/social/reactionSync.ts');
    expect(reaction).toContain(`= '${MEMBERS_UNREADABLE}';`);
    expect(screen).toContain(`= '${MEMBERS_UNREADABLE}';`);
    // Ровно одно объявление на файл: копия разъедется при первой же правке.
    expect(screen.split(`'${MEMBERS_UNREADABLE}'`).length - 1).toBe(1);
  });
});
