/**
 * «Сбросить ссылку» отзывала ссылку только у администраторов (v4.32.1005).
 *
 * Дефект. Пригласительный токен есть только у администраторов — так задумано:
 * узнав токен, обычный участник собрал бы действующую ссылку сам. Но из «нет
 * токена» выходило и «нечем проверить»: `decideInviteToken` отвечал такому
 * участнику `'unenforceable'`, а на этот вердикт вход разрешает `decideJoin`.
 * Человек с ОТОЗВАННОЙ ссылкой получал отказ от администраторов — и вступление
 * от всех остальных.
 *
 * Цена. Ссылка несёт список участников (до двадцати), и вступающий
 * представляется каждому из них. Обычные участники записывали его себе в
 * состав (`upsertGroupMember`, role: 'member') и с этого мгновения рассылали
 * ему сообщения группы: отозванная ссылка продолжала читать переписку.
 * Администраторы его при этом не видели вовсе — ни в составе, ни в истории.
 * Кнопка при этом обещает «Все ранее разосланные ссылки перестанут пускать в
 * группу», и обещание было неправдой.
 *
 * Правка. У сброса появился второй адресат: остальным участникам уходит не
 * токен, а его односторонняя свёртка — `inviteTokenVerifier`. Сверить по ней
 * предъявленный токен можно, собрать по ней ссылку нельзя, значит раздать её
 * можно всем, не отдавая права приглашать. Свёртка живёт в profileScopedKv
 * (`groupInviteVerifierStore`), а `decideInviteToken` спрашивает её тогда и
 * только тогда, когда своего токена нет.
 *
 * Границы. Нет ни токена, ни отпечатка — вердикт прежний, `'unenforceable'`:
 * правка не смеет закрыть вход там, где он был открыт (группы, созданные до
 * v4.32.303, и участники, не заставшие ни одного сброса). Отпечаток устаревший
 * — вход отложится, но не пропадёт: администратор всё равно пересказывает
 * `'add'` всему составу.
 */
import { decideInviteToken, inviteTokenVerifier, isInviteVerifier, makeInviteToken } from '../groupInviteToken';
import { decodeGroupCtlEnvelope, encodeGroupCtlEnvelope } from '../groupControlEnvelope';

/** Записанное kv: ключ «pid|key» → значение. */
let mockKvStore: Record<string, string> = {};
/** Ложится ли запись на диск. */
let mockKvSetOk = true;
/** Отказ самого чтения — он отличим от «ключа нет». */
let mockKvReadFails = false;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvSetCheckedFor: jest.fn(async (pid: number, k: string, v: string) => {
    if (!mockKvSetOk) return false;
    mockKvStore[`${pid}|${k}`] = v;
    return true;
  }),
  scopedKvTryGetFor: jest.fn(async (pid: number, k: string) =>
    mockKvReadFails ? null : { value: mockKvStore[`${pid}|${k}`] ?? null }
  ),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

const MESSAGING = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
const SCREEN = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Настоящий токен — той же длины и того же алфавита, что раздаёт группа. */
function token(seed: number): string {
  let n = seed;
  return makeInviteToken((len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      out[i] = n & 0xff;
    }
    return out;
  });
}

/** Хранилище отпечатков — модуль новый, поэтому берётся на месте. */
async function store() {
  return import('../groupInviteVerifierStore');
}

beforeEach(() => {
  mockKvStore = {};
  mockKvSetOk = true;
  mockKvReadFails = false;
});

describe('отпечаток даёт сверку, но не право приглашать', () => {
  it('отпечаток — 43 символа base64url и он устойчив', () => {
    const t = token(1);
    expect(inviteTokenVerifier(t)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inviteTokenVerifier(t)).toBe(inviteTokenVerifier(t));
  });

  it('разным токенам — разные отпечатки, иначе сверка ничего не значит', () => {
    expect(inviteTokenVerifier(token(1))).not.toBe(inviteTokenVerifier(token(2)));
  });

  it('сам токен в отпечатке не лежит: по нему ссылку не собрать', () => {
    const t = token(3);
    expect(inviteTokenVerifier(t)).not.toContain(t);
    expect(t).not.toBe(inviteTokenVerifier(t));
  });

  it('форма отпечатка проверяется: он приезжает в конверте, то есть недоверен', () => {
    expect(isInviteVerifier(inviteTokenVerifier(token(4)))).toBe(true);
    expect(isInviteVerifier('короткий')).toBe(false);
    expect(isInviteVerifier(`${inviteTokenVerifier(token(4))}x`)).toBe(false);
    expect(isInviteVerifier(null)).toBe(false);
  });
});

describe('участник без токена сверяет ссылку отпечатком', () => {
  it('действующая ссылка впускает', () => {
    const t = token(10);
    expect(
      decideInviteToken({
        knownToken: null,
        knownUnreadable: false,
        knownVerifier: inviteTokenVerifier(t),
        presented: t,
      })
    ).toBe('ok');
  });

  it('отозванная ссылка больше не впускает — ровно то, что обещает кнопка', () => {
    const fresh = token(11);
    const revoked = token(12);
    expect(
      decideInviteToken({
        knownToken: null,
        knownUnreadable: false,
        knownVerifier: inviteTokenVerifier(fresh),
        presented: revoked,
      })
    ).toBe('revoked');
  });

  it('ссылки нет вовсе — тоже отказ, а не «нечем проверить»', () => {
    expect(
      decideInviteToken({
        knownToken: null,
        knownUnreadable: false,
        knownVerifier: inviteTokenVerifier(token(13)),
        presented: null,
      })
    ).toBe('revoked');
  });

  it('свой токен главнее отпечатка: он точнее, и он есть у администратора', () => {
    const t = token(14);
    expect(
      decideInviteToken({
        knownToken: t,
        knownUnreadable: false,
        knownVerifier: inviteTokenVerifier(token(15)),
        presented: t,
      })
    ).toBe('ok');
  });
});

describe('отпечаток хранится у профиля и переживает перезапуск', () => {
  it('что записали — то и прочли', async () => {
    const { saveInviteVerifier, readInviteVerifier } = await store();
    const v = inviteTokenVerifier(token(20));

    expect(await saveInviteVerifier('g-20', 1, v)).toBe(true);
    expect(await readInviteVerifier('g-20', 1)).toBe(v);
  });

  it('чужому профилю отпечаток не виден: право впускать не делится', async () => {
    const { saveInviteVerifier, readInviteVerifier } = await store();
    await saveInviteVerifier('g-21', 1, inviteTokenVerifier(token(21)));

    expect(await readInviteVerifier('g-21', 2)).toBeNull();
  });

  it('не легшая на диск запись отвечает словом, а не молчанием', async () => {
    const { saveInviteVerifier } = await store();
    mockKvSetOk = false;

    expect(await saveInviteVerifier('g-22', 1, inviteTokenVerifier(token(22)))).toBe(false);
  });

  it('мусор до диска не доходит: им нельзя отвергать ссылки своего же администратора', async () => {
    const { saveInviteVerifier } = await store();

    expect(await saveInviteVerifier('g-23', 1, 'не-отпечаток')).toBe(false);
    expect(Object.keys(mockKvStore)).toHaveLength(0);
  });

  it('отказ чтения даёт null — тот же, что «отпечатка нет», и это намеренно', async () => {
    const { saveInviteVerifier, readInviteVerifier } = await store();
    await saveInviteVerifier('g-24', 1, inviteTokenVerifier(token(24)));
    mockKvReadFails = true;

    // Оба безответных случая ведут к 'unenforceable'. Понять отказ базы как
    // «запрещено» значило бы закрыть вход по ДЕЙСТВУЮЩЕЙ ссылке.
    expect(await readInviteVerifier('g-24', 1)).toBeNull();
  });

  it('идентификатор группы идёт последним: двоеточие внутри него допустимо', async () => {
    const { inviteVerifierKey } = await store();

    expect(inviteVerifierKey('a:b:c')).toBe('grp_invite_vfy_v1:a:b:c');
  });
});

describe('отпечаток доезжает до участника', () => {
  it('конверт его несёт и проверяет по форме', () => {
    const v = inviteTokenVerifier(token(30));
    const good = decodeGroupCtlEnvelope(
      encodeGroupCtlEnvelope({ op: 'meta', groupId: 'g-30', ts: 1, inviteVerifier: v })
    );
    expect(good && good.op === 'meta' ? good.inviteVerifier : null).toBe(v);

    const bad = decodeGroupCtlEnvelope(
      encodeGroupCtlEnvelope({ op: 'meta', groupId: 'g-30', ts: 1, inviteVerifier: 'мусор' })
    );
    expect(bad).toBeNull();
  });

  it('сброс шлёт отпечаток тем, кому не шлёт токен', () => {
    const body = codeOnly(MESSAGING.slice(MESSAGING.indexOf('export async function rotateGroupInviteToken(')));
    expect(body).toContain("!admins.includes(m.peerPubB64)");
    expect(body).toContain("{ op: 'meta', inviteVerifier: inviteTokenVerifier(token) },");
  });

  it('приём кладёт отпечаток на диск и откладывает кадр, если не лёг', () => {
    const code = codeOnly(MESSAGING);
    expect(code).toContain("if (!(await saveInviteVerifier(env.groupId, pid, env.inviteVerifier))) {");
    const guard = code.indexOf("if (!(await saveInviteVerifier(env.groupId, pid, env.inviteVerifier))) {");
    expect(code.slice(guard, guard + 300)).toContain("return 'deferred';");
  });

  it('вход сверяется отпечатком только когда своего токена нет', () => {
    const code = codeOnly(MESSAGING);
    expect(code).toContain(
      'knownVerifier: isInviteToken(group.inviteToken) ? null : await readInviteVerifier(env.groupId, pid),'
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: свой токен решает по-прежнему', () => {
  it('совпал — впускаем', () => {
    const t = token(40);
    expect(decideInviteToken({ knownToken: t, knownUnreadable: false, presented: t })).toBe('ok');
  });

  it('не совпал — отказ', () => {
    expect(
      decideInviteToken({ knownToken: token(41), knownUnreadable: false, presented: token(43) })
    ).toBe('revoked');
  });

  it('свой токен не прочитался — по-прежнему «сверить нечем»', () => {
    expect(
      decideInviteToken({ knownToken: null, knownUnreadable: true, presented: token(44) })
    ).toBe('unverifiable');
  });
});

describe('ГРАНИЦА: без отпечатка вход остаётся открытым', () => {
  it('ни токена, ни отпечатка — прежний вердикт, вход решает политика группы', () => {
    expect(
      decideInviteToken({ knownToken: null, knownUnreadable: false, presented: token(50) })
    ).toBe('unenforceable');
    expect(
      decideInviteToken({
        knownToken: null,
        knownUnreadable: false,
        knownVerifier: null,
        presented: token(50),
      })
    ).toBe('unenforceable');
  });

  it('отпечаток не той формы — тоже прежний вердикт, а не отказ всем подряд', () => {
    // Мусор, записанный себе, отвергал бы ссылки собственного администратора
    // до следующего сброса. Пусть лучше сверка не состоится вовсе.
    expect(
      decideInviteToken({
        knownToken: null,
        knownUnreadable: false,
        knownVerifier: 'не-отпечаток',
        presented: token(51),
      })
    ).toBe('unenforceable');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('обычный участник и правда записывает вошедшего себе в состав', () => {
    // Не будь этого, отозванная ссылка не давала бы ни переписки, ни состава,
    // и вся правка была бы про текст на кнопке.
    const join = MESSAGING.indexOf("if (env.op === 'join') {");
    const adminGuard = MESSAGING.indexOf("if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {");
    expect(join).toBeGreaterThan(-1);
    expect(adminGuard).toBeGreaterThan(join);
    const body = codeOnly(MESSAGING.slice(join, adminGuard));
    expect(body).toContain('await upsertGroupMember({');
    expect(body).toContain("role: 'member',");
  });

  it('кнопка по-прежнему обещает отзыв всем, а не «кроме администраторов»', () => {
    expect(SCREEN).toContain('Все ранее разосланные ссылки перестанут пускать в группу.');
  });
});
