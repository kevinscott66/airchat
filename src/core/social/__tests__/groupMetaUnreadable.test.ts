/**
 * Ложное «Группа переименована» на нечитаемом названии (v4.32.577).
 *
 * Дефект. Разбор meta-конверта сравнивал присланное название со своим
 * (`env.name !== group.name`) и на расхождение писал в переписку системную
 * строку. Своё название читалось через decryptAtRestString, а он на неудачной
 * расшифровке отдаёт пустую строку. Значит, стоило ключу данных перестать
 * открывать строку группы — и первый же служебный конверт от администратора
 * (name едет в нём всегда, даже когда меняли настройку) печатал в истории
 * событие, которого не было. Строка оставалась навсегда и выглядела как
 * действие администратора; настоящая причина — что своя копия не читается —
 * не называлась нигде. То же с аватаром: «Аватар группы обновлён» на ровном
 * месте.
 *
 * Что проверяется. Правило из groupMetaEvents на всех состояниях поля, и что
 * строка группы теперь доносит до него признак «не открылось».
 */
import * as fs from 'fs';
import * as path from 'path';
import { decideMetaField } from '../groupMetaEvents';

const SRC = path.join(__dirname, '..', '..');
const META = () => fs.readFileSync(path.join(SRC, 'social', 'groupMetaEvents.ts'), 'utf8');
const LOCAL = () => fs.readFileSync(path.join(SRC, 'storage', 'local.ts'), 'utf8');
const GROUP_MSG = () => fs.readFileSync(path.join(SRC, 'social', 'groupMessaging.ts'), 'utf8');

/** Кусок файла между двумя якорями — чтобы утверждение било в одно место. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('решение по полю meta-конверта', () => {
  it('нечитаемое своё название применяется молча', () => {
    expect(decideMetaField('Рабочая группа', '', true)).toEqual({ apply: true, announce: false });
  });

  it('совпадение с нечитаемым тоже молча: сравнивать было не с чем', () => {
    // Пустая строка здесь — не значение, а след неудачной расшифровки.
    expect(decideMetaField('', '', true)).toEqual({ apply: true, announce: false });
  });

  it('прочитанное расхождение — настоящее переименование', () => {
    expect(decideMetaField('Новое', 'Старое', false)).toEqual({ apply: true, announce: true });
  });

  it('признак может вовсе не приехать — это не «нечитаемо»', () => {
    expect(decideMetaField('Новое', 'Старое', undefined)).toEqual({ apply: true, announce: true });
  });

  it('повтор прежнего значения по-прежнему отбрасывается', () => {
    expect(decideMetaField('Старое', 'Старое', false)).toEqual({ apply: false, announce: false });
  });

  it('пустое своё значение при читаемом столбце — законное «нет описания»', () => {
    // Группа без аватара — обычное дело, и появление аватара объявить нужно.
    expect(decideMetaField('nb:abc', '', false)).toEqual({ apply: true, announce: true });
  });

  it('отсутствие поля в конверте не трогает ничего', () => {
    expect(decideMetaField(null, 'Старое', false)).toEqual({ apply: false, announce: false });
    expect(decideMetaField(undefined, 'Старое', true)).toEqual({ apply: false, announce: false });
  });

  it('решение не выдумывает третьего состояния', () => {
    for (const own of ['', 'Старое']) {
      for (const unreadable of [true, false, undefined]) {
        const d = decideMetaField('X', own, unreadable);
        expect(typeof d.apply).toBe('boolean');
        expect(typeof d.announce).toBe('boolean');
        // Объявить о том, чего не применяли, нельзя ни при каких входных.
        if (d.announce) expect(d.apply).toBe(true);
      }
    }
  });

  it('модуль решения ни от чего не зависит', () => {
    expect(META()).not.toMatch(/^import /m);
  });
});

describe('форма исходников', () => {
  it('строка группы различает «не открылось» и «пусто»', () => {
    const body = slice(LOCAL(), 'function rowToGroup(', 'export async function createGroup');
    expect(body).toContain('const nameCell = readAtRestCell(');
    expect(body).toContain('const avatarCell = readAtRestCell(');
    expect(body).toContain("name: cellTextOrNull(nameCell) ?? ''");
    expect(body).toContain('nameUnreadable: unreadableFromCellState(nameCell.state)');
    expect(body).toContain('avatarCid: cellTextOrNull(avatarCell)');
    expect(body).toContain('avatarCidUnreadable: unreadableFromCellState(avatarCell.state)');
    expect(body).not.toContain('decryptAtRestString(r.name');
  });

  it('оба признака объявлены в самой строке группы', () => {
    const type = slice(LOCAL(), 'export type GroupRow = {', 'function rowToGroup(');
    expect(type).toContain('nameUnreadable?: boolean;');
    expect(type).toContain('avatarCidUnreadable?: boolean;');
  });

  it('разбор конверта спрашивает решение, а не сравнивает сам', () => {
    const body = slice(GROUP_MSG(), "if (env.op === 'meta') {", "if (env.adminOnlyPosting != null");
    expect(body).toContain('decideMetaField(env.name, group.name, group.nameUnreadable)');
    expect(body).toContain("decideMetaField(env.avatarCid, group.avatarCid ?? '', group.avatarCidUnreadable)");
    expect(body).not.toContain('env.name !== group.name');
    expect(body).not.toContain("env.avatarCid !== (group.avatarCid ?? '')");
  });

  it('системная строка пишется только по разрешению, а молчание — не молчание', () => {
    const body = slice(GROUP_MSG(), "if (env.op === 'meta') {", "if (env.adminOnlyPosting != null");
    expect(body).toContain('if (nameDecision.announce) events.push(`Группа переименована в «${env.name}»`);');
    expect(body).toContain("else log.warn('group_meta_name_unreadable'");
    expect(body).toContain("if (avatarDecision.announce) events.push('Аватар группы обновлён');");
    expect(body).toContain("else log.warn('group_meta_avatar_unreadable'");
  });
});
