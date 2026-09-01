import * as fs from 'fs';
import * as path from 'path';

/**
 * Раунд 461: смонтированный таб можно выбрать, выбираемый — смонтирован.
 *
 * С v4.32.30 список контактов открывается из Профиля, а таб «Контакты» остался
 * висеть в дереве: кнопки в панели у него не было, выбрать его человек не мог,
 * но экран монтировался при каждом холодном старте — читал список контактов и
 * блок-лист из базы ровно в тот момент, который в этом файле специально берегут.
 * Второй, живой экран контактов при этом работал в модалке Профиля: две копии
 * одного списка, из которых видна всегда одна. Плюс ссылка airchat://tab/contacts
 * переключала на таб, у которого не было ни кнопки, ни, после уборки, тела.
 */

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const CTX = fs.readFileSync(path.join(ROOT, 'ui', 'TabRefContext.tsx'), 'utf8');

/** Значения объединения TabName — из объявления, а не из копии в тесте. */
function tabNames(): string[] {
  const line = CTX.split('\n').find((l) => l.startsWith('export type TabName ='));
  if (!line) throw new Error('нет объявления TabName');
  return quoted(line);
}

/** Строки в одинарных кавычках. */
function quoted(text: string): string[] {
  const out: string[] = [];
  const parts = text.split("'");
  for (let i = 1; i < parts.length; i += 2) out.push(parts[i]);
  return out;
}

/** Табы, чьё тело смонтировано в App.tsx. */
function mounted(): string[] {
  return APP.split('\n')
    .filter((l) => l.includes('display: tab === '))
    .map((l) => quoted(l.slice(l.indexOf('display: tab === ')))[0]);
}

/** Табы, которые можно выбрать кнопкой в панели. */
function selectable(): string[] {
  return APP.split('\n')
    .filter((l) => l.includes('scheduleTab('))
    .map((l) => quoted(l.slice(l.indexOf('scheduleTab(')))[0])
    .filter((v): v is string => typeof v === 'string');
}

const NAMES = tabNames();

describe('табы панели', () => {
  test('объявлены пять — контактов среди них нет', () => {
    expect(NAMES).toEqual(['feed', 'chat', 'groups', 'profile', 'settings']);
  });

  test('каждый объявленный таб смонтирован ровно один раз', () => {
    expect(mounted().slice().sort()).toEqual(NAMES.slice().sort());
  });

  test('каждый смонтированный таб можно выбрать кнопкой', () => {
    expect(new Set(selectable())).toEqual(new Set(mounted()));
  });
});

describe('ссылки airchat://tab/...', () => {
  const map = APP.slice(APP.indexOf('const map: Record<string, TabName> = {'));
  const body = map.slice(0, map.indexOf('};'));

  test('ведут только туда, что действительно смонтировано', () => {
    const targets = body
      .split('\n')
      .filter((l) => l.includes(':') && l.includes("'"))
      .map((l) => quoted(l)[0]);
    for (const t of targets) expect(mounted()).toContain(t);
  });

  test('старая ссылка на контакты ведёт в Профиль, а не в пустоту', () => {
    expect(body).toContain("contacts: 'profile',");
  });
});

describe('список контактов один', () => {
  const files = ['App.tsx', 'ui/screens/ProfileScreen.tsx', 'ui/screens/ContactsScreen.tsx'];
  const sources = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));

  test('экран контактов смонтирован в одном месте', () => {
    const total = sources.reduce((n, s) => n + s.split('<ContactsScreen').length - 1, 0);
    expect(total).toBe(1);
    expect(sources[0]).not.toContain('ContactsScreen');
  });

  test('обхода «а видно ли меня» больше нет — экран живёт, только пока открыт', () => {
    const contacts = sources[2];
    expect(contacts).not.toContain('alwaysActive');
    expect(contacts).not.toContain('useTabRef');
    expect(contacts).toContain('subscribeContactsChanged(() => { void load(); })');
  });
});

describe('проверка не пустая', () => {
  /** Как было до 461-го: таб есть в объявлении и в дереве, кнопки нет. */
  const BEFORE = {
    names: ['feed', 'chat', 'groups', 'contacts', 'profile', 'settings'],
    selectable: ['feed', 'chat', 'groups', 'profile', 'settings'],
  };

  test('прежний набор поймался бы', () => {
    expect(BEFORE.names).toContain('contacts');
    expect(BEFORE.selectable).not.toContain('contacts');
    expect(new Set(BEFORE.names)).not.toEqual(new Set(BEFORE.selectable));
  });
});
