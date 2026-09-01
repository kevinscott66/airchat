/**
 * Команда, которая ничего не сделала, не отчитывается об успехе (v4.32.514).
 *
 * Дефект №1 — сообщение о событии, которого не было. Приёмник конверта
 * op:'role' идемпотентен с самого начала:
 *
 *     case 'role': if (!target || target.role === env.role) return true;
 *
 * повтор он выбрасывает молча и правильно. Отправитель этого вопроса не
 * задавал. /promote на том, кто уже администратор, и /demote на обычном
 * участнике писали СВОЮ системную строку в СВОЮ историю, показывали тост об
 * успехе и рассылали конверт, который каждый получатель отбрасывал. Итог —
 * расхождение историй на ровном месте: строка есть у одного устройства из
 * всех, и появиться у остальных ей неоткуда, потому что повторной отправки у
 * конверта нет.
 *
 * Для /demote текст к тому же был ложью дважды: «X снят(а) с должности
 * администратора» о том, кто этой должности не занимал.
 *
 * Такую проверку из трёх команд имела ровно одна — /mute, и написана она была
 * прямо в обработчике. Кнопки в карточке участника («Назначить админом» /
 * «Ограничить») формально другую роль подставляют всегда, потому что считают
 * её от текущей, — но считают от списка в состоянии React: конверт, пришедший
 * между отрисовкой и нажатием, делает список несвежим, и «противоположная»
 * роль оказывается той же самой.
 *
 * Дефект №2 — отказ базы, о котором никто не узнаёт. Смена роли говорила о нём
 * с самого начала (`.catch(() => showError('Не удалось изменить роль'))`), а
 * исключение, бан и снятие бана — нет: у их цепочек `.catch` не было вовсе.
 * Не записалось — участник остаётся на месте, а на экране ни строки, ни тоста,
 * ни ошибки; вдобавок необработанный отказ обещания.
 */
import fs from 'fs';
import path from 'path';

import { roleChangeNoopText, roleChangeSysText, type AssignableRole } from '../groupRolePolicy';

const SRC = path.join(__dirname, '..', '..', '..');
const SCREEN = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');

describe('роль уже такая — говорим об этом, а не о смене', () => {
  it('повторное назначение администратором ничего не меняет', () => {
    expect(roleChangeNoopText('admin', 'admin', 'Петя')).toBe('Петя уже администратор.');
  });

  it('повторное ограничение — прежними словами, до буквы', () => {
    // Эта строка уже показывалась пользователю (/mute проверял роль сам).
    // Переезд правила в модуль не имеет права её переписать.
    expect(roleChangeNoopText('restricted', 'restricted', 'Петя')).toBe(
      'Петя уже ограничен(а) в отправке сообщений.'
    );
  });

  it('«разжаловать» обычного участника нечем — и это сказано без вранья', () => {
    const text = roleChangeNoopText('member', 'member', 'Петя');
    expect(text).toBe('Петя — обычный участник: ни прав администратора, ни ограничений.');
    // Ровно то, чем отвечал экран раньше: снятие должности, которой не было.
    expect(text).not.toContain('снят');
  });

  it('менять есть что — молчим и не мешаем', () => {
    const cases: Array<[AssignableRole, 'owner' | 'admin' | 'member' | 'restricted' | 'banned' | undefined]> = [
      ['admin', 'member'],
      ['admin', 'restricted'],
      ['admin', 'owner'],
      ['admin', undefined],
      ['member', 'admin'],
      ['member', 'restricted'],
      ['member', 'banned'],
      ['restricted', 'member'],
      ['restricted', 'admin'],
      ['restricted', undefined],
    ];
    for (const [next, role] of cases) {
      expect(roleChangeNoopText(next, role, 'Петя')).toBeNull();
    }
  });

  it('имя подставляется целиком, а не обрезком', () => {
    expect(roleChangeNoopText('admin', 'admin', 'Анна Каренина')).toContain('Анна Каренина');
  });

  it('ответ строго дополняет строку о смене: одна из двух и ровно одна', () => {
    // Вместе они покрывают все исходы: либо менять есть что и говорим о
    // смене, либо менять нечего и говорим об этом. Третьего экран не знает.
    const roles: AssignableRole[] = ['admin', 'member', 'restricted'];
    for (const next of roles) {
      for (const prev of [...roles, 'owner', 'banned', undefined] as const) {
        const noop = roleChangeNoopText(next, prev, 'Петя');
        if (prev === next) expect(typeof noop).toBe('string');
        else expect(noop).toBeNull();
      }
    }
  });
});

describe('BEFORE — что уходило в историю без этой проверки', () => {
  it('/demote на обычном участнике писал снятие несуществующей должности', () => {
    expect(roleChangeSysText('member', 'member', 'Петя', false)).toBe(
      'Петя снят(а) с должности администратора'
    );
  });

  it('и эта строка оставалась у одного устройства из всех', () => {
    // Приёмник конверта отбрасывает повтор молча — это правильно и это
    // именно то, что делает отправителя без проверки источником расхождения:
    // строка написана, тост показан, а применять её некому.
    const messaging = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupMessaging.ts'), 'utf8');
    expect(messaging).toContain('if (!target || target.role === env.role) return true;');
  });

  it('повторное назначение администратором писало о повышении уже повышенного', () => {
    expect(roleChangeSysText('admin', 'admin', 'Петя', false)).toBe('Петя назначен(а) администратором');
  });
});

/**
 * Рэтчет формы. Оба правила — «сперва спроси, есть ли что менять» и «скажи,
 * если не записалось» — живут в исходнике экрана и проверяются по нему.
 */
describe('форма исходников', () => {
  /**
   * Начала цепочек, меняющих участника в базе, вместе с закрывающей строкой
   * `})…` на том же отступе: дом форматируется так, поэтому конец цепочки
   * находится однозначно и без разбора скобок.
   */
  const chains = () => {
    const lines = SCREEN.split('\n');
    const start = /^(\s*)void (removeGroupMember|updateGroupMemberRole)\(/;
    const out: Array<{ line: number; name: string; close: string | null }> = [];
    lines.forEach((ln, i) => {
      const m = ln.match(start);
      if (!m) return;
      let close: string | null = null;
      for (let j = i + 1; j < Math.min(i + 120, lines.length); j += 1) {
        if (lines[j].startsWith(`${m[1]}})`)) {
          close = lines[j];
          break;
        }
      }
      out.push({ line: i + 1, name: m[2], close });
    });
    return out;
  };

  it('исходник вообще меняет участников — иначе проверка ниже пуста', () => {
    expect(chains().length).toBeGreaterThanOrEqual(7);
  });

  it('каждая запись участника в базу договаривает, если не записалась', () => {
    for (const c of chains()) {
      expect(`${c.line}: ${c.name} → ${c.close ?? 'конца цепочки не нашлось'}`).toContain('.catch(');
    }
  });

  it('немой отказ базы сообщается словами, а не молчанием', () => {
    for (const text of [
      'Не удалось изменить роль',
      'Не удалось исключить участника',
      'Не удалось заблокировать участника',
      'Не удалось разблокировать участника',
    ]) {
      expect(SCREEN).toContain(`showError('${text}')`);
    }
  });

  it('вопрос «есть ли что менять» задают все четыре места, а не одно', () => {
    // /promote, /demote, /mute и переключатели в карточке участника.
    // /unmute не в счёт: он ищет цель среди role === 'restricted', так что
    // пустой сменой не бывает по построению.
    expect(SCREEN.split('roleChangeNoopText(').length - 1).toBe(4);
  });

  it('своей копии правила у /mute больше нет', () => {
    expect(SCREEN).not.toContain("target.role === 'restricted') { Alert.alert(");
  });

  it('проверка стоит до диалога подтверждения, а не после', () => {
    // Иначе экран спросит «Назначить администратором?», получит «да» и
    // ничего не сделает — худший из возможных ответов.
    const promote = SCREEN.slice(SCREEN.indexOf("if (cmd === '/promote'"));
    const guard = promote.indexOf('roleChangeNoopText(');
    const dialog = promote.indexOf('Назначить администратором?');
    expect(guard).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dialog);
  });
});
