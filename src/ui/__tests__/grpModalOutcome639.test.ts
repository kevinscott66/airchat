/**
 * Окна групп не молчат об отказе (v4.32.639).
 *
 * Два места в дереве групповых окон принимали отказ хранилища за обычный ход
 * событий:
 *
 * 1. `GroupStarredModal` снимал звезду как `void setGroupMessageStarred(...)
 *    .then(...)` — без `.catch`. Не записалось: строка оставалась в избранном,
 *    сообщения не появлялось, отказ уходил в неперехваченное отклонение
 *    обещания. В переписке тот же случай давно закрыт `runGuardedOp`.
 *
 * 2. `GroupCreateModal` читал только что созданную группу через `getGroup`,
 *    который схлопывает сбой чтения в `null` (см. lookupValue). Ветка
 *    `if (group)` на этом молчала: окно закрывалось без «Группа создана» и без
 *    ошибки, `onCreated` не звался, и группы не было в списке до перезагрузки.
 *    Правильный вход — `getGroupRead` с тремя исходами, он существует с
 *    v4.32.548 и здесь просто не использовался.
 *
 * Рэтчет на форму исходников: обеих правок нельзя лишиться незаметно.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(UI, ...p), 'utf8');

/** Свои же комментарии цитируют старый код — сверяем только сам код. */
const stripComments = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '');

const STARRED = stripComments(read('components', 'modals', 'groups', 'GroupStarredModal.tsx'));
const CREATE = stripComments(read('components', 'modals', 'groups', 'GroupCreateModal.tsx'));
const GUARD = read('components', 'runGuardedOp.ts');
const LOCAL = fs.readFileSync(
  path.join(UI, '..', 'core', 'storage', 'local.ts'), 'utf8');
const LOOKUP = fs.readFileSync(
  path.join(UI, '..', 'core', 'utils', 'lookupResult.ts'), 'utf8');

describe('окна групп не молчат об отказе (v4.32.639)', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: файлы прочитаны и это те самые файлы', () => {
    expect(STARRED.length).toBeGreaterThan(1000);
    expect(CREATE.length).toBeGreaterThan(1000);
    expect(STARRED).toContain('function StarredRowImpl(');
    expect(STARRED).toContain('setGroupMessageStarred');
    expect(CREATE).toContain('export function CreateGroupModal(');
    expect(CREATE).toContain('const submit = async () => {');
  });

  it('снятие звезды в группе идёт через общий перехват', () => {
    expect(STARRED).toContain("import { runGuardedOp } from '../../runGuardedOp';");
    expect(STARRED).toContain('runGuardedOp(async () => {');
    expect(STARRED).toContain("'Не удалось убрать из избранного'");
    expect(STARRED).toContain("'ui_group_unstar_failed'");
    // Именно этой строки быть не должно: она и есть неперехваченное отклонение.
    expect(STARRED).not.toContain('void setGroupMessageStarred(');
  });

  it('общий перехват действительно показывает отказ, а не только пишет в журнал', () => {
    // Без этого предыдущая проверка была бы обещанием, а не фактом.
    expect(GUARD).toContain('export function runGuardedOp(');
    expect(GUARD).toContain('showError(userErrorText(e, fallback))');
  });

  it('создание группы читает её тремя исходами, а не двумя', () => {
    expect(CREATE).toContain('const read = await getGroupRead(id, pid);');
    expect(CREATE).toContain("if (read.state === 'found') {");
    expect(CREATE).toContain('onCreated(read.value);');
    expect(CREATE).toContain('isTrulyMissing(read)');
    // getGroup молчит о сбое — здесь его быть не должно ни в импорте, ни в теле.
    expect(CREATE).not.toMatch(/\bgetGroup\(/);
    expect(CREATE).not.toMatch(/^\s*getGroup,\s*$/m);
  });

  it('оба исхода, кроме найденного, доходят до человека', () => {
    expect(CREATE).toContain('Группа создана, но в списке её нет.');
    expect(CREATE).toContain('Группа создана, но прочитать её не удалось.');
    // Ровно один showSuccess: успех не должен звучать при неудачном чтении.
    expect(CREATE.match(/showSuccess\(/g)).toHaveLength(1);
  });

  it('отказ чтения контактов объясняется, а не прячет раздел', () => {
    expect(CREATE).toContain('void listContacts()');
    expect(CREATE).toContain(".catch((e) => {");
    expect(CREATE).toContain("'Не удалось загрузить контакты'");
  });

  it('повод для правки жив: getGroup по-прежнему схлопывает сбой в null', () => {
    // Если local.ts однажды научит getGroup честности, эта проверка упадёт и
    // напомнит перечитать окно, а не оставит рэтчет висеть без причины.
    expect(LOCAL).toContain('return lookupValue(await getGroupRead(id, ownerProfileId));');
    expect(LOOKUP).toContain('export function isTrulyMissing');
    expect(LOOKUP).toContain('export function lookupValue');
  });

  it('в окнах нет рукописного разбора ошибки', () => {
    expect(STARRED).not.toContain('instanceof Error');
    expect(CREATE).not.toContain('instanceof Error');
  });
});
