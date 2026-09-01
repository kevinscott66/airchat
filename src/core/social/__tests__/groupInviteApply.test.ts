/**
 * v4.32.463 — рэтчет: пригласительная ссылка заводит группу, но не переписывает
 * уже заведённую.
 *
 * Дефект: обработчик `airchat://join-group/…` применял ссылку безусловно.
 * `createGroup` при существующей группе — `INSERT OR IGNORE` (тихо ничего), а
 * следом шёл цикл `upsertGroupMember` с `DO UPDATE SET role = excluded.role`,
 * то есть роли из недоверенной ссылки ложились поверх своей таблицы. Владелец,
 * открывший собственное приглашение, понижался до `member` в своей группе;
 * участник, приславший ссылку с id чужой группы и своим `adminPub`, получал в
 * ней права администратора.
 *
 * Тест держит две вещи: таблицу решений (чистая функция) и место проверки в
 * App.tsx — она обязана стоять до первой записи в БД и до обеих дорог.
 *
 * v4.32.467: третье состояние — «идентификатор занят группой соседнего
 * профиля» — исчезло вместе с причиной: ключ `groups` стал составным, и
 * вопрос базе задаётся про свой аккаунт. Здесь это закреплено: правило то же,
 * состояний на одно меньше, и текста «откройте ссылку в другом профиле» в
 * модуле больше нет.
 */
import * as fs from 'fs';
import * as path from 'path';

import { decideInviteApply, inviteApplyProblem, type InviteApplyDecision } from '../groupInviteApply';
import type { GroupIdState } from '../../storage/local';

const APP = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');
const LOCAL = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');

/** Тело объявления: от строки заголовка до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '}') break;
  }
  return out.join('\n');
}

describe('decideInviteApply — таблица решений', () => {
  it('свободный идентификатор — единственный случай, когда пишем в БД', () => {
    expect(decideInviteApply({ kind: 'free' })).toEqual({ kind: 'apply' });
  });

  it('группа уже в этом профиле — не переписываем', () => {
    expect(decideInviteApply({ kind: 'taken' })).toEqual({ kind: 'already_here' });
  });

  it('база не ответила — отказ, а не разрешение', () => {
    expect(decideInviteApply({ kind: 'unknown' })).toEqual({ kind: 'unknown' });
  });

  it('пишем ровно при одном ответе базы из трёх', () => {
    const all: GroupIdState[] = [{ kind: 'free' }, { kind: 'taken' }, { kind: 'unknown' }];
    expect(all.filter((s) => decideInviteApply(s).kind === 'apply')).toEqual([{ kind: 'free' }]);
  });

  it('решение принимается только по ответу базы — других входов у функции нет', () => {
    // v4.32.467: номер профиля ушёл из решения в сам вопрос (groupIdState),
    // поэтому рассогласоваться «спросили про один профиль, решили про другой»
    // больше нечему.
    expect(decideInviteApply.length).toBe(1);
  });
});

describe('inviteApplyProblem — что скажут человеку', () => {
  const ALL: InviteApplyDecision[] = [
    { kind: 'apply' },
    { kind: 'already_here' },
    { kind: 'unknown' },
  ];

  it('молчит ровно при apply', () => {
    const silent = ALL.filter((d) => inviteApplyProblem(d, 'Двор') === null);
    expect(silent).toEqual([{ kind: 'apply' }]);
  });

  it('в отказе названа группа — человек открыл ссылку и должен понять, о какой речь', () => {
    for (const d of ALL) {
      const text = inviteApplyProblem(d, 'Двор');
      if (d.kind === 'apply') continue;
      expect(text).toContain('Двор');
      expect(text?.endsWith('.')).toBe(true);
    }
  });

  it('у каждого отказа свой текст: состояния разные, объяснения тоже', () => {
    const texts = ALL.filter((d) => d.kind !== 'apply').map((d) => inviteApplyProblem(d, 'Двор'));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('про «другой профиль» человеку больше не рассказывают: такого состояния нет', () => {
    // v4.32.467: составной ключ убрал сам случай — группа соседнего аккаунта
    // не занимает идентификатор, и отправлять человека «открыть ссылку в
    // другом профиле» стало не за чем.
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'groupInviteApply.ts'), 'utf8');
    expect(SRC).not.toContain('other_profile');
    expect(SRC).not.toContain('в другом профиле этого приложения');
  });
});

describe('BEFORE — как ломалось до правки', () => {
  /** Старое поведение: роли из ссылки кладутся поверх своих, что бы там ни было. */
  function applyLinkRoles(
    table: Record<string, string>,
    link: { members: { pub: string }[]; adminPub: string },
    myPub: string
  ): Record<string, string> {
    const next = { ...table };
    for (const m of link.members) next[m.pub] = m.pub === link.adminPub ? 'admin' : 'member';
    next[myPub] = 'member';
    return next;
  }

  const mine = { me: 'owner', bob: 'member' };
  const myOwnLink = { members: [{ pub: 'me' }, { pub: 'bob' }], adminPub: 'me' };
  const hostileLink = { members: [{ pub: 'me' }, { pub: 'bob' }], adminPub: 'bob' };

  it('собственная ссылка понижала владельца до участника', () => {
    expect(applyLinkRoles(mine, myOwnLink, 'me').me).toBe('member');
  });

  it('чужая ссылка делала приславшего администратором чужой группы', () => {
    const after = applyLinkRoles(mine, hostileLink, 'me');
    expect(after.bob).toBe('admin');
    expect(after.me).toBe('member');
  });

  it('после правки до этой записи дело не доходит: решение — не apply', () => {
    // Группа уже есть — значит и своя, и враждебная ссылка отвергаются раньше.
    expect(decideInviteApply({ kind: 'taken' }).kind).not.toBe('apply');
  });
});

describe('App.tsx — проверка стоит до записи', () => {
  const branch = APP.slice(APP.indexOf("parts[0] === 'join-group'"), APP.indexOf("if (parts[0] !== 'tab'"));

  it('ветка ссылки найдена целиком', () => {
    expect(branch.length).toBeGreaterThan(500);
    expect(branch).toContain('upsertGroupMember(');
    expect(branch).toContain('createGroup(');
  });

  it('решение спрашивается ровно один раз — на обе дороги сразу', () => {
    expect(branch.split('decideInviteApply(').length - 1).toBe(1);
    expect(branch.split('await groupIdState(').length - 1).toBe(1);
  });

  it('проверка предшествует и заявке, и созданию группы, и записи участников', () => {
    const gate = branch.indexOf('const applyProblem = inviteApplyProblem(');
    expect(gate).toBeGreaterThan(-1);
    for (const write of ['sendGroupJoinRequest(', 'createGroup(', 'upsertGroupMember(']) {
      expect(branch.indexOf(write)).toBeGreaterThan(gate);
    }
  });

  it('отказ прекращает обработку, а не только показывает текст', () => {
    const after = branch.slice(branch.indexOf('if (applyProblem) {'));
    expect(after.slice(0, after.indexOf('}'))).toContain('return;');
  });

  it('спрашивается свой номер профиля, а не поле из ссылки', () => {
    expect(branch).toContain('decideInviteApply(await groupIdState(payload.id, pid))');
  });
});

describe('groupIdState — вопрос про свой профиль', () => {
  const body = bodyOf(LOCAL, 'export async function groupIdState(');

  it('идентификатор ищется с отбором по профилю: ключ составной с v4.32.467', () => {
    expect(body).toContain('FROM groups WHERE id = ? AND owner_profile_id = ?');
  });

  it('профиль — обязательный параметр, а не «текущий» из глобального состояния', () => {
    expect(body).toContain('groupIdState(id: string, ownerProfileId: number)');
    expect(body).not.toContain('getActiveProfile');
  });

  it('ошибка базы не выдаётся за свободный идентификатор', () => {
    const cat = body.slice(body.indexOf('} catch'));
    expect(cat).toContain("kind: 'unknown'");
    expect(cat).not.toContain("kind: 'free'");
  });
});
