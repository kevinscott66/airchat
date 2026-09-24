/**
 * Исключающий администратор тоже помнит, кого исключил (v4.32.851).
 *
 * Дефект. Отметку `markGroupRemoval` писала ровно одна ветка — разбор
 * ВХОДЯЩЕГО конверта op:'kick'. У того, кто кик и затеял, её не писал никто:
 * экран групп звал `removeGroupMember` напрямую, а свой собственный конверт
 * назад не приходит. Оба места исключения в интерфейсе — команда /kick и
 * кнопка в карточке участника — делали это одинаково.
 *
 * Цена. Защита из groupRemovalMark.ts переставала работать ровно у
 * администратора. Исключённый пересылает себе старую ссылку (у обычного
 * участника пригласительного токена нет никогда, и `inviteTokenBlocks` такую
 * ссылку пропускает); его op:'join' упирается в `wasRemovedFromGroup` у всех,
 * кроме исключившего, — а у исключившего проходит как вступление незнакомца и
 * возвращает человека в состав. Дальше администратор своим же конвертом
 * op:'add' рассказывает об этом остальным, и `clearGroupRemoval` в ветке 'add'
 * снимает отметку у всей группы. Чем выше права у обманутого, тем полнее
 * возврат: исключение отменяется у всех, и сделал это тот, кто исключал.
 *
 * Правка. Пара «отметка + состав» съехала в ядро одним вызовом
 * `kickGroupMemberLocally`, и оба места в экране зовут его. Порядок тот же,
 * что во входящей ветке: сначала отметка, потом удаление строки.
 */

const mockKv = new Map<string, string>();
let mockKvWriteFails = false;
/** След вызовов по порядку: проверяется не только что, но и в какой черёд. */
const calls: string[] = [];

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => ({ value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    if (mockKvWriteFails) throw new Error('диск');
    calls.push(`mark:${k}`);
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
  removeGroupMember: async (gid: string, peer: string) => {
    calls.push(`remove:${gid}:${peer}`);
  },
  recountGroupMembers: async (gid: string) => {
    calls.push(`recount:${gid}`);
    return 0;
  },
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { kickGroupMemberLocally, removalMarkKey, wasRemovedFromGroup } from '../groupRemovalMark';

const GID = 'g-1';
const PEER = 'исключённый-ключ==';
const PID = 1;

const SRC = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

beforeEach(() => {
  mockKv.clear();
  mockKvWriteFails = false;
  calls.length = 0;
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: возврат по старой ссылке решает отметка', () => {
  it('без отметки «исключали ли отсюда» отвечает «нет»', async () => {
    // Ровно то, что видел исключивший администратор до этой версии: состав
    // очищен, памяти об исключении нет.
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(false);
  });

  it('решение о возврате читает именно её', () => {
    const msg = codeOnly(read('core/social/groupMessaging.ts'));
    // `wasRemoved` — единственное, что отличает исключённого от незнакомца:
    // роли в составе у него уже нет.
    expect(msg).toContain('knownRole === undefined && (await wasRemovedFromGroup(env.groupId, senderPubB64, pid))');
    expect(msg).toContain('wasRemoved,');
  });

  it('свой конверт назад не приходит — входящая ветка администратору не поможет', () => {
    const msg = codeOnly(read('core/social/groupMessaging.ts'));
    // Отправитель исключается из списка адресатов рассылки: `activeRecipients`
    // получает свой ключ именно затем, чтобы себе не слать.
    expect(msg).toContain('const recipients = new Set(activeRecipients(members, senderPubB64));');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: отметка и состав по-прежнему на месте', () => {
  it('ключ отметки не менялся', () => {
    expect(removalMarkKey(PEER, GID)).toBe(`grp_removed_v1:${PEER}:${GID}`);
  });

  it('входящая ветка кика отметку писала и пишет', () => {
    // Правка добавляет второе место, а не переносит единственное: у того, кому
    // кик пришёл конвертом, всё должно остаться как было.
    const msg = codeOnly(read('core/social/groupMessaging.ts'));
    expect(msg).toContain('if (!(await markGroupRemoval(env.groupId, env.target, pid, env.ts))) {');
    expect(msg).toContain('await clearGroupRemoval(env.groupId, env.target, pid);');
  });
});

describe('исключение у себя пишет отметку', () => {
  it('после исключения человек считается исключённым', async () => {
    await kickGroupMemberLocally(GID, PEER, PID, 1000);
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(true);
  });

  it('состав при этом снимается и пересчитывается', async () => {
    await kickGroupMemberLocally(GID, PEER, PID, 1000);
    expect(calls).toContain(`remove:${GID}:${PEER}`);
    expect(calls).toContain(`recount:${GID}`);
  });

  it('отметка встаёт ДО удаления строки', async () => {
    await kickGroupMemberLocally(GID, PEER, PID, 1000);
    const mark = calls.findIndex((c) => c.startsWith('mark:'));
    const remove = calls.findIndex((c) => c.startsWith('remove:'));
    expect(mark).toBeGreaterThanOrEqual(0);
    // Обратный порядок оставил бы исключённого без отметки при обрыве между
    // двумя действиями — это и есть закрываемая дыра. Прямой оставляет отметку
    // на ещё состоящем участнике: он пойдёт в заявки, а не войдёт молча.
    expect(mark).toBeLessThan(remove);
  });

  it('отказ базы исключение не отменяет, но отвечает словом', async () => {
    mockKvWriteFails = true;
    expect(await kickGroupMemberLocally(GID, PEER, PID, 1000)).toBe(false);
    // Человек нажал кнопку — оставлять исключённого в группе хуже.
    expect(calls).toContain(`remove:${GID}:${PEER}`);
  });

  it('удачная запись отвечает согласием', async () => {
    expect(await kickGroupMemberLocally(GID, PEER, PID, 1000)).toBe(true);
  });
});

describe('оба места исключения в экране зовут общий вызов', () => {
  const screen = codeOnly(read('ui/screens/GroupsScreen.tsx'));

  it('прямых вызовов removeGroupMember в экране не осталось', () => {
    // Иначе третье место исключения снова завело бы свою половину пары.
    expect(screen).not.toContain('removeGroupMember(');
  });

  it('и команда, и кнопка карточки зовут kickGroupMemberLocally', () => {
    expect(screen.split('kickGroupMemberLocally(').length - 1).toBe(2);
  });

  it('о несохранившейся отметке говорят вслух — оба раза', () => {
    const said = screen.split('отметка').length - 1;
    expect(said).toBeGreaterThanOrEqual(2);
    expect(screen).toContain('по старой ссылке без вашего одобрения');
  });
});

describe('ядро: пара живёт в одном месте', () => {
  const src = read('core/social/groupRemovalMark.ts');

  it('вызов делает ровно две вещи и в правильном порядке', () => {
    const from = src.indexOf('export async function kickGroupMemberLocally(');
    expect(from).toBeGreaterThan(0);
    const body = src.slice(from, src.indexOf('/** Снять отметку', from));
    const mark = body.indexOf('await markGroupRemoval(');
    const remove = body.indexOf('await removeGroupMember(');
    expect(mark).toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(mark);
    expect(body).toContain('await recountGroupMembers(');
  });
});
