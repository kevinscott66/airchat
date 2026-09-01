/**
 * Непрочитанный пригласительный токен молча отменял отзыв ссылок (v4.32.601).
 *
 * `invite_token` читался в rowToGroup двумя состояниями: `decryptAtRestNullable`
 * отдаёт на неудаче пустую строку, а `isInviteToken('')` отвечает «токена нет».
 * «Токена нет» в decideInviteToken означает 'unenforceable' — «сверять нечем,
 * решаем без него». То есть на устройстве администратора, чей ключ данных
 * перестал открывать этот столбец, проверка не ломалась заметно, а тихо
 * исчезала: любая давно отозванная ссылка снова пускала в группу, и об этом не
 * узнавал никто.
 *
 * Второй вред — в кнопке «Пригласительная ссылка»: ensureGroupInviteToken
 * видел тот же ложный ответ «токена нет» и шёл в rotateGroupInviteToken,
 * необратимо затирая настоящий (всего лишь непрочитанный) токен — тот же
 * запрет, что у реакций в v4.32.544. Все уже разосланные ссылки переставали
 * пускать в группу, а администратор получал обычную свежую ссылку и не узнавал
 * ни о чём.
 *
 * Здесь и поведение нового вердикта, и форма кода: третье состояние доезжает
 * из строки БД до обоих гейтов, ни один из них не сравнивает вердикт с
 * 'revoked' напрямую, а кнопка отказывает вместо ротации.
 */
import fs from 'fs';
import path from 'path';

import {
  decideInviteToken,
  inviteTokenBlocks,
  isInviteToken,
  type InviteTokenVerdict,
} from '../groupInviteToken';

const readToken = () =>
  fs.readFileSync(path.join(__dirname, '..', 'groupInviteToken.ts'), 'utf8');
const readLocal = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
const readMessaging = () =>
  fs.readFileSync(path.join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
const readGroupsScreen = () =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf8'
  );

/** Кусок файла между двумя якорями: утверждение о теле одной функции. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBB';

describe('непрочитанный токен группы отличается от отсутствующего', () => {
  it('непрочитанный столбец даёт свой вердикт, а не «сверять нечем»', () => {
    expect(
      decideInviteToken({ knownToken: '', knownUnreadable: true, presented: TOKEN_A })
    ).toBe('unverifiable');
  });

  it('пустая строка без пометки по-прежнему значит «токена нет»', () => {
    expect(decideInviteToken({ knownToken: '', presented: TOKEN_A })).toBe('unenforceable');
  });

  it('непрочитанный столбец перевешивает даже совпадающий токен', () => {
    expect(
      decideInviteToken({ knownToken: TOKEN_A, knownUnreadable: true, presented: TOKEN_A })
    ).toBe('unverifiable');
  });

  it('непрочитанный столбец не пускает и при пустом предъявленном', () => {
    expect(
      decideInviteToken({ knownToken: null, knownUnreadable: true, presented: null })
    ).toBe('unverifiable');
  });

  it('knownUnreadable: false ничего не меняет', () => {
    expect(
      decideInviteToken({ knownToken: TOKEN_A, knownUnreadable: false, presented: TOKEN_A })
    ).toBe('ok');
    expect(
      decideInviteToken({ knownToken: TOKEN_A, knownUnreadable: false, presented: TOKEN_B })
    ).toBe('revoked');
  });

  it('пометка признаётся только строгим true — не любым истинным значением', () => {
    const params = { knownToken: TOKEN_A, presented: TOKEN_A } as const;
    expect(
      decideInviteToken({ ...params, knownUnreadable: undefined })
    ).toBe('ok');
    expect(
      decideInviteToken({ ...params, knownUnreadable: 1 as unknown as boolean })
    ).toBe('ok');
  });

  it('старые вердикты не изменились', () => {
    expect(decideInviteToken({ knownToken: TOKEN_A, presented: TOKEN_A })).toBe('ok');
    expect(decideInviteToken({ knownToken: TOKEN_A, presented: TOKEN_B })).toBe('revoked');
    expect(decideInviteToken({ knownToken: TOKEN_A, presented: null })).toBe('revoked');
    expect(decideInviteToken({ knownToken: null, presented: TOKEN_A })).toBe('unenforceable');
  });

  it('пустая строка не проходит проверку формы — из-за неё и была подмена', () => {
    expect(isInviteToken('')).toBe(false);
    expect(isInviteToken(TOKEN_A)).toBe(true);
  });
});

describe('inviteTokenBlocks закрывает вход на всех запрещающих вердиктах', () => {
  it('запрещают ровно revoked и unverifiable', () => {
    expect(inviteTokenBlocks('revoked')).toBe(true);
    expect(inviteTokenBlocks('unverifiable')).toBe(true);
    expect(inviteTokenBlocks('ok')).toBe(false);
    expect(inviteTokenBlocks('unenforceable')).toBe(false);
  });

  it('непрочитанный столбец закрывает вход через общий вопрос', () => {
    const verdict: InviteTokenVerdict = decideInviteToken({
      knownToken: TOKEN_A,
      knownUnreadable: true,
      presented: TOKEN_A,
    });
    expect(inviteTokenBlocks(verdict)).toBe(true);
  });
});

describe('третье состояние доезжает от строки БД до гейтов', () => {
  it('GroupRow несёт пометку рядом с самим токеном', () => {
    const row = slice(readLocal(), 'export type GroupRow = {', '\n};');
    expect(row).toMatch(/^ {2}inviteToken: string \| null;$/m);
    expect(row).toMatch(/^ {2}inviteTokenUnreadable\?: boolean;$/m);
  });

  it('токен читается тремя состояниями, а не decryptAtRestNullable', () => {
    const src = readLocal();
    expect(src).toContain('function readTokenCell(');
    expect(src).toContain('...readTokenCell((r.invite_token as string | null) ?? null, dek),');
    expect(src).not.toContain('decryptAtRestNullable((r.invite_token as string | null)');
  });

  it('readTokenCell отвечает через общие правила трёх состояний', () => {
    const body = slice(readLocal(), 'function readTokenCell(', '\n}\n');
    expect(body).toContain('readAtRestCell(stored, dek)');
    expect(body).toContain('cellTextOrNull(cell)');
    expect(body).toContain('unreadableFromCellState(cell.state)');
  });

  it('анти-спуф-фильтр заявок передаёт пометку и спрашивает inviteTokenBlocks', () => {
    const body = slice(
      readMessaging(),
      '      known === undefined &&',
      "      log.info('group_join_request_revoked_link'"
    );
    expect(body).toContain('inviteTokenBlocks(');
    expect(body).toContain('knownUnreadable: grp.inviteTokenUnreadable,');
  });

  it('гейт вступления передаёт пометку и спрашивает inviteTokenBlocks', () => {
    const body = slice(
      readMessaging(),
      '      const tokenVerdict = decideInviteToken({',
      'group_ctl_join_revoked_drop'
    );
    expect(body).toContain('knownUnreadable: group.inviteTokenUnreadable,');
    expect(body).toContain('if (inviteTokenBlocks(tokenVerdict)) {');
  });

  it('ни один вызов не сравнивает вердикт с revoked напрямую', () => {
    // Сузить до вердикта: env.status === 'revoked' — это поле провода, другое.
    const verdictLines = readMessaging()
      .split('\n')
      .filter((l) => l.includes('Verdict') || l.includes('decideInviteToken'));
    expect(verdictLines.length).toBeGreaterThan(0);
    expect(verdictLines.join('\n')).not.toMatch(/===\s*'revoked'/);
    // Строка импорта скобки не содержит — её проверяем отдельно.
    expect(readMessaging().split('inviteTokenBlocks(').length - 1).toBe(2);
    expect(readMessaging()).toMatch(
      /^import \{[^}]*\binviteTokenBlocks\b[^}]*\} from '\.\/groupInviteToken';$/m
    );
  });

  it('причина отказа попадает в журнал — иначе вердикты неразличимы', () => {
    const body = slice(
      readMessaging(),
      "        log.info('group_ctl_join_revoked_drop'",
      '\n      }'
    );
    expect(body).toContain('verdict: tokenVerdict,');
  });
});

describe('кнопка ссылки не затирает непрочитанный токен', () => {
  it('ensureGroupInviteToken отказывает до ротации', () => {
    const body = slice(
      readMessaging(),
      'export async function ensureGroupInviteToken(',
      '\n}\n'
    );
    const refuse = body.indexOf('if (fresh.inviteTokenUnreadable) {');
    const rotate = body.indexOf('return rotateGroupInviteToken(');
    expect(refuse).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(refuse);
    expect(body.slice(refuse, rotate)).toContain('return null;');
  });

  it('отказ виден в журнале отдельным событием', () => {
    const body = slice(
      readMessaging(),
      'export async function ensureGroupInviteToken(',
      '\n}\n'
    );
    expect(body).toContain("log.warn('group_invite_token_unreadable'");
    expect(body).toContain("log.warn('group_invite_token_group_unreadable'");
  });

  it('экран называет отказ так, чтобы он был правдой для обеих причин', () => {
    const src = readGroupsScreen();
    expect(src).not.toContain("showError('Не удалось прочитать группу')");
    expect(src.split("showError('Не удалось получить пригласительную ссылку')").length - 1).toBe(2);
  });
});

describe('модуль решения остался чистым', () => {
  it('в groupInviteToken нет ни RN, ни БД, ни сети', () => {
    const imports = readToken()
      .split('\n')
      .filter((l) => l.startsWith('import '))
      .join('\n');
    expect(imports).toBe('');
  });

  it('новый вердикт описан в типе, а не только в коде', () => {
    const src = readToken();
    expect(src).toMatch(/^ {2}\| 'unverifiable';$/m);
    expect(src).toContain('v4.32.601');
  });
});
