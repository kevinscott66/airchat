/**
 * Описание группы: «не открылось» перестало притворяться «нет описания»
 * (v4.32.579).
 *
 * Дефект. rowToGroup читал столбец description через decryptAtRestNullable, а
 * тот при неудачной расшифровке отдаёт пустую строку. Из этого следовали три
 * беды сразу. Карточка группы (`group.description ? … : null`) не показывала
 * ничего — потеря выглядела как поле, которое никто не заполнял. Разбор
 * meta-конверта сравнивал присланное описание со своим и при пустом присланном
 * считал, что оно уже совпадает, — нечитаемый столбец не лечился никогда.
 * И худшее: поле правки у администратора заполнялось из того же пустого
 * значения, а выход из фокуса писал пустую строку поверх целого шифртекста и
 * рассылал её всем участникам — «не открылось» становилось «описания нет»
 * необратимо и у всех сразу.
 *
 * Что проверяется. Правило собственной записи из groupMetaEvents на всех
 * состояниях, и что все три места — чтение строки, разбор конверта и экран —
 * это правило соблюдают.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decideOwnDescriptionWrite, decideMetaField } from '../groupMetaEvents';

const SRC = path.join(__dirname, '..', '..');
const META = () => fs.readFileSync(path.join(SRC, 'social', 'groupMetaEvents.ts'), 'utf8');
const LOCAL = () => fs.readFileSync(path.join(SRC, 'storage', 'local.ts'), 'utf8');
const GROUP_MSG = () => fs.readFileSync(path.join(SRC, 'social', 'groupMessaging.ts'), 'utf8');
const GROUPS_SCREEN = () => fs.readFileSync(path.join(SRC, '..', 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');

/** Кусок файла между двумя якорями — чтобы утверждение било в одно место. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('своя запись описания', () => {
  it('пустая строка поверх непрочитанного столбца запрещена', () => {
    expect(decideOwnDescriptionWrite('', true)).toEqual({ write: false, reason: 'emptyOverUnreadable' });
  });

  it('написанное руками описание заменяет непрочитанное', () => {
    expect(decideOwnDescriptionWrite('Чат подъезда', true)).toEqual({ write: true, reason: 'ok' });
  });

  it('над прочитанным столбцом пустая строка — законное «описания нет»', () => {
    expect(decideOwnDescriptionWrite('', false)).toEqual({ write: true, reason: 'ok' });
    expect(decideOwnDescriptionWrite('')).toEqual({ write: true, reason: 'ok' });
  });

  it('признак только строго true: undefined не запрещает ничего', () => {
    expect(decideOwnDescriptionWrite('', undefined).write).toBe(true);
  });

  it('запрещается ровно одно сочетание и никакое другое', () => {
    const texts = ['', ' ', 'а', 'Чат подъезда'];
    const flags: Array<boolean | undefined> = [true, false, undefined];
    for (const t of texts) {
      for (const f of flags) {
        const d = decideOwnDescriptionWrite(t, f);
        expect(d.write).toBe(!(f === true && t === ''));
        expect(d.reason).toBe(d.write ? 'ok' : 'emptyOverUnreadable');
      }
    }
  });
});

describe('присланное описание', () => {
  it('над непрочитанным своим применяется молча и лечит столбец', () => {
    expect(decideMetaField('Чат подъезда', '', true)).toEqual({ apply: true, announce: false });
    expect(decideMetaField('', '', true)).toEqual({ apply: true, announce: false });
  });

  it('отсутствие поля в конверте ничего не меняет', () => {
    expect(decideMetaField(undefined, 'Чат подъезда', true)).toEqual({ apply: false, announce: false });
    expect(decideMetaField(null, 'Чат подъезда', false)).toEqual({ apply: false, announce: false });
  });
});

describe('форма исходников', () => {
  it('модуль решений по-прежнему ни от чего не зависит', () => {
    expect(META()).not.toMatch(/^import /m);
  });

  it('строка группы читает описание ячейкой и несёт признак', () => {
    const body = slice(LOCAL(), 'const descCell = readAtRestCell', 'type: (r.type as GroupType)');
    expect(body).toContain('description: cellTextOrNull(descCell),');
    expect(body).toContain('descriptionUnreadable: unreadableFromCellState(descCell.state),');
    expect(body).not.toContain('decryptAtRestNullable((r.description');
  });

  it('тип строки группы объявляет признак описания', () => {
    const t = slice(LOCAL(), '  description: string | null;', '  avatarCid: string | null;');
    expect(t).toContain('descriptionUnreadable?: boolean;');
  });

  it('разбор конверта решает по описанию тем же правилом, что по названию', () => {
    const body = slice(GROUP_MSG(), "if (env.op === 'meta') {", "if (env.adminOnlyPosting != null");
    expect(body).toContain("decideMetaField(env.description, group.description ?? '', group.descriptionUnreadable)");
    expect(body).not.toContain("env.description !== (group.description ?? '')");
  });

  it('экран группы спрашивает разрешение до записи описания', () => {
    const src = GROUPS_SCREEN();
    expect(src).toContain("import { decideOwnDescriptionWrite } from '../../core/social/groupMetaEvents';");
    const body = slice(src, 'const d = normalizeOwnGroupDescription(descInput);', 'descGate.begin(d)');
    expect(body).toContain('if (!decideOwnDescriptionWrite(d, group.descriptionUnreadable).write) {');
    expect(body).toContain('return;');
  });

  it('карточка группы показывает пометку вместо пустого места', () => {
    const src = GROUPS_SCREEN();
    expect(src).toContain('UNREADABLE_DESCRIPTION_TEXT');
    expect(src).toContain('{!searchVisible && !group.description && group.descriptionUnreadable ? (');
  });

  it('пометка описания — своя строка, а не текст про сообщение', () => {
    const t = fs.readFileSync(path.join(SRC, 'storage', 'unreadableText.ts'), 'utf8');
    expect(t).toContain("export const UNREADABLE_DESCRIPTION_TEXT = 'Описание не удалось прочитать';");
    expect(t).toContain("export const UNREADABLE_MESSAGE_TEXT = 'Сообщение не удалось прочитать';");
  });
});
