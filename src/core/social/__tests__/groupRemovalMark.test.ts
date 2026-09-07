/**
 * Исключённый из группы не возвращает себя сам (v4.32.618).
 *
 * op:'kick' удаляет строку из group_members — и вместе с ней всякую память о
 * том, что человек тут был. А op:'join' («я вступил по ссылке») прав не
 * спрашивает: представить можно только себя, решение принимает decideJoin по
 * нашей таблице участников, и незнакомая роль означает «новый».
 *
 * Пригласительный токен при этом есть только у администраторов — обычному
 * участнику decideInviteToken отдаёт 'unenforceable', и inviteTokenBlocks
 * такую ссылку пропускает (иначе группы, созданные до появления токенов,
 * никого бы не принимали). Значит исключённый, переслав себе старую ссылку,
 * возвращался к каждому, у кого токена нет, — то есть ко всем, кроме
 * администраторов: его сообщения проходили анти-спуф-фильтр у большинства
 * группы, а администраторы его не видели вовсе.
 */

const mockKv = new Map<string, string>();
let mockKvReadFails = false;
let mockKvWriteFails = false;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockKvReadFails ? null : { value: mockKv.get(k) ?? null }),
  kvSetChecked: async (k: string, v: string) => {
    if (mockKvWriteFails) throw new Error('диск');
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REMOVAL_MARK_PREFIX,
  clearGroupRemoval,
  markGroupRemoval,
  removalMarkKey,
  wasRemovedFromGroup,
} from '../groupRemovalMark';

const GID = 'g-1';
const PEER = 'исключённый-ключ==';
const OTHER = 'другой-ключ==';
const PID = 1;

beforeEach(() => {
  mockKv.clear();
  mockKvReadFails = false;
  mockKvWriteFails = false;
});

describe('отметка об исключении', () => {
  it('после kick человек помечен, до него — нет', async () => {
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(false);
    await markGroupRemoval(GID, PEER, PID, 1000);
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(true);
  });

  it('обратное действие администратора отметку снимает', async () => {
    await markGroupRemoval(GID, PEER, PID, 1000);
    await clearGroupRemoval(GID, PEER, PID);
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(false);
  });

  it('отметки не смешиваются между людьми, группами и профилями', async () => {
    await markGroupRemoval(GID, PEER, PID, 1000);
    expect(await wasRemovedFromGroup(GID, OTHER, PID)).toBe(false);
    expect(await wasRemovedFromGroup('g-2', PEER, PID)).toBe(false);
    expect(await wasRemovedFromGroup(GID, PEER, 2)).toBe(false);
  });

  it('ключ несёт номер профиля: kv общий на всё приложение', async () => {
    await markGroupRemoval(GID, PEER, 7, 1000);
    expect([...mockKv.keys()].every((k) => k.startsWith('p7:'))).toBe(true);
  });

  it('идентификатор группы стоит последним — иначе он подбирал бы чужой ключ', () => {
    // Кодек ограничивает groupId только длиной, двоеточие в нём допустимо, а
    // ключ участника — base64, двоеточий там не бывает.
    expect(removalMarkKey(PEER, GID).startsWith(REMOVAL_MARK_PREFIX)).toBe(true);
    expect(removalMarkKey(PEER, `x:${OTHER}`)).not.toBe(removalMarkKey(PEER, 'x') + `:${OTHER}`.slice(1));
    expect(removalMarkKey(PEER, GID)).not.toBe(removalMarkKey(OTHER, GID));
  });

  it('нечитаемая база не загоняет всех подряд в заявки', async () => {
    await markGroupRemoval(GID, PEER, PID, 1000);
    mockKvReadFails = true;
    expect(await wasRemovedFromGroup(GID, PEER, PID)).toBe(false);
  });

  it('неудачная запись отметки не роняет разбор конверта', async () => {
    mockKvWriteFails = true;
    await expect(markGroupRemoval(GID, PEER, PID, 1000)).resolves.toBeUndefined();
  });
});

/**
 * Форма исходников: отметка должна ставиться и сниматься там, где меняется
 * состав, — иначе модуль есть, а дыра остаётся.
 */
describe('обработчик конвертов пользуется отметкой', () => {
  const SRC = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
  const bodyOf = (head: string): string => {
    const at = SRC.indexOf(head);
    expect(at).toBeGreaterThan(0);
    return SRC.slice(at, SRC.indexOf('\n    }', at));
  };

  it('kick ставит отметку, add и unban её снимают', () => {
    expect(bodyOf("case 'kick': {")).toContain('markGroupRemoval(env.groupId, env.target, pid, env.ts)');
    expect(bodyOf("case 'add': {")).toContain('clearGroupRemoval(env.groupId, env.target, pid)');
    expect(bodyOf("case 'unban': {")).toContain('clearGroupRemoval(env.groupId, env.target, pid)');
  });

  it('join спрашивает отметку и передаёт ответ в decideJoin', () => {
    const at = SRC.indexOf('wasRemovedFromGroup(env.groupId, senderPubB64, pid)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(SRC.indexOf('const verdict = decideJoin({'));
    expect(SRC).toContain('      wasRemoved,\n');
  });

  it('вернувшийся в заявки доходит до фильтра «только контакты»', () => {
    // Иначе исключённый незнакомец попадал бы в список заявок мимо настройки
    // приватности — та спрашивается только вместе с joinRequestIntake.
    expect(SRC).toContain('(group.requireApproval || wasRemoved) && iAmAdmin ? await joinRequestIntake(');
  });

  it('упреждающий бан упирается в потолок чёрного списка', () => {
    const body = bodyOf("case 'ban': {");
    const cap = body.indexOf('countBanned(members) >= GROUP_BANLIST_MAX');
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(body.indexOf("role: 'banned', displayName"));
  });

  it('снятие блокировки сменой роли пересчитывает участников', () => {
    expect(bodyOf("case 'role': {")).toContain(
      'if (countsAsMember(prev) !== countsAsMember(env.role)) await recountGroupMembers(env.groupId, pid);'
    );
  });
});
