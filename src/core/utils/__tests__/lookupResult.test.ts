/**
 * Отказ чтения не должен выдаваться за отсутствие записи (v4.32.548).
 *
 * Дефект. Переход к группе по нажатию на баннер уведомления искал группу
 * ТОЛЬКО в списке, уже загруженном в память. Список перечитывается по
 * `subscribeChatWrites` лишь пока вкладка «Группы» активна — значит сообщение
 * в новую группу, пришедшее с другой вкладки, в память не попадало вовсе, а
 * при первом открытии вкладки список ещё пуст. Промах не делал НИЧЕГО:
 * приложение переключало вкладку и оставалось на списке, человек нажимал на
 * уведомление и не получал ни группы, ни объяснения.
 *
 * Вторая половина: `getGroup` отвечал `null` и на «нет такой группы», и на
 * отказ базы — `try { … } catch { return null; }`. На таком ответе нельзя
 * строить фразу для человека: «такой группы нет» на неотвеченный вопрос — это
 * неправда. Третий этаж той же ошибки, что v4.32.544 и v4.32.547.
 */
import fs from 'fs';
import path from 'path';
import {
  foundResult,
  missingResult,
  failedResult,
  lookupValue,
  isTrulyMissing,
  firstFound,
  fromNullable,
  type LookupResult,
} from '../lookupResult';

describe('три разных ответа', () => {
  it('найденное отдаёт значение', () => {
    expect(lookupValue(foundResult(7))).toBe(7);
  });

  it('отсутствие и отказ одинаково не дают значения', () => {
    expect(lookupValue(missingResult<number>())).toBeNull();
    expect(lookupValue(failedResult<number>())).toBeNull();
  });

  it('но различаются там, где это решает фразу для человека', () => {
    expect(isTrulyMissing(missingResult())).toBe(true);
    expect(isTrulyMissing(failedResult())).toBe(false);
    expect(isTrulyMissing(foundResult(1))).toBe(false);
  });

  it('найденное значение отдаётся как есть, даже ложное', () => {
    expect(lookupValue(foundResult(0))).toBe(0);
    expect(lookupValue(foundResult(''))).toBe('');
    expect(lookupValue(foundResult(false))).toBe(false);
  });

  it('пустое значение из памяти — это отсутствие, а не отказ', () => {
    expect(fromNullable(undefined).state).toBe('missing');
    expect(fromNullable(null).state).toBe('missing');
    expect(fromNullable(0).state).toBe('found');
    expect(lookupValue(fromNullable('x'))).toBe('x');
  });
});

describe('сведение нескольких попыток', () => {
  it('первое найденное побеждает — это самый свежий ответивший источник', () => {
    const r = firstFound([missingResult<string>(), foundResult('db'), foundResult('later')]);
    expect(lookupValue(r)).toBe('db');
  });

  it('память впереди базы, если ответили обе', () => {
    const r = firstFound([foundResult('cache'), foundResult('db')]);
    expect(lookupValue(r)).toBe('cache');
  });

  it('отказ важнее пустоты: врать про отсутствие нельзя', () => {
    expect(firstFound([missingResult(), failedResult()]).state).toBe('failed');
    expect(firstFound([failedResult(), missingResult()]).state).toBe('failed');
  });

  it('найденное важнее отказа: ответ уже есть', () => {
    expect(lookupValue(firstFound([failedResult<number>(), foundResult(5)]))).toBe(5);
  });

  it('все промолчали — честное отсутствие', () => {
    expect(firstFound([missingResult(), missingResult()]).state).toBe('missing');
  });

  it('пустой список попыток — тоже отсутствие, а не падение', () => {
    expect(firstFound<number>([]).state).toBe('missing');
  });

  it('сведение ничего не портит: результат — один из поданных видов', () => {
    const cases: Array<LookupResult<number>[]> = [
      [foundResult(1), failedResult()],
      [failedResult(), failedResult()],
      [missingResult(), foundResult(2), failedResult()],
    ];
    for (const c of cases) {
      const r = firstFound(c);
      expect(['found', 'missing', 'failed']).toContain(r.state);
      if (r.state === 'found') expect(c.some((x) => x.state === 'found')).toBe(true);
      if (r.state === 'failed') expect(c.some((x) => x.state === 'failed')).toBe(true);
    }
  });
});

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const PURE = read('../lookupResult.ts');
const LOCAL = read('../../storage/local.ts');
const SCREEN = read('../../../ui/screens/GroupsScreen.tsx');

const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
};
const GET_GROUP = (): string =>
  bodyOf(LOCAL, 'export async function getGroup(id: string, ownerProfileId: number): Promise<GroupRow | null> {');
const GET_GROUP_READ = (): string => bodyOf(LOCAL, 'export async function getGroupRead(');

describe('форма исходников', () => {
  it('разбор ответа живёт без импортов — его можно проверить целиком', () => {
    expect(PURE.split('\n').filter((l) => l.startsWith('import ')).length).toBe(0);
    expect(PURE).toContain('export function firstFound<T>(');
  });

  it('getGroup больше не глотает отказ базы сам', () => {
    const body = GET_GROUP();
    expect(body).toContain('getGroupRead(');
    expect(body).not.toContain('try {');
    expect(body).not.toContain('catch');
  });

  it('getGroupRead отвечает отказом и пишет об этом в журнал', () => {
    const body = GET_GROUP_READ();
    expect(body).toContain('return missingResult();');
    expect(body).toContain('return failedResult();');
    expect(body).toContain("log.warn('group_read_failed'");
  });

  it('переход по уведомлению спрашивает базу, а не только список в памяти', () => {
    const body = bodyOf(
      SCREEN,
      '  useEffect(() => {\n    if (!groupJump) return;'
    );
    expect(body).toContain('getGroupRead(groupJump.groupId, pid)');
    expect(body).toContain('firstFound(');
  });

  it('промах перехода больше не молчит', () => {
    const body = bodyOf(SCREEN, '  useEffect(() => {\n    if (!groupJump) return;');
    expect(body).toContain("log.warn('ui_group_jump_unresolved'");
    expect(body).toContain('showError(');
    expect(body).toContain('isTrulyMissing(result)');
  });

  it('фраза про удаление из группы не показывается на отказе базы', () => {
    const body = bodyOf(SCREEN, '  useEffect(() => {\n    if (!groupJump) return;');
    const missingAt = body.indexOf('вас из неё удалили');
    const guardAt = body.indexOf('isTrulyMissing(result)');
    expect(missingAt).toBeGreaterThan(guardAt);
  });
});
