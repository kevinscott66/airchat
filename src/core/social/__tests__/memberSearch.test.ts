/**
 * Рэтчет к v4.32.606: поиск по участникам и подсказка упоминаний не должны
 * молча терять того, чьё имя не открыл ключ.
 */
import fs from 'fs';
import path from 'path';
import {
  mentionSkippedNotice,
  mentionableMembers,
  memberSkippedNotice,
  searchMembersByName,
} from '../memberSearch';

const MODULE = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'memberSearch.ts'), 'utf8');
const GROUPS = (): string =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf8'
  );

/** Кусок исходника между двумя якорями — чтобы проверка била в одно тело. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

type M = { peerPubB64: string; displayName?: string | null; displayNameUnreadable?: boolean };

const anna: M = { peerPubB64: 'a', displayName: 'Анна' };
const anton: M = { peerPubB64: 'b', displayName: 'Антон' };
const boris: M = { peerPubB64: 'c', displayName: 'Борис' };
const hidden: M = { peerPubB64: 'd', displayName: null, displayNameUnreadable: true };
const nameless: M = { peerPubB64: 'e', displayName: null };

describe('searchMembersByName', () => {
  test('пустой запрос — это «не ищу»: состав отдаётся целиком', () => {
    const all = [anna, hidden, boris];
    const r = searchMembersByName(all, '');
    expect(r.matched).toBe(all);
    expect(r.unreadable).toBe(0);
  });

  test('запрос из одних пробелов тоже «не ищу»', () => {
    const all = [anna, hidden];
    expect(searchMembersByName(all, '   ').matched).toBe(all);
    expect(searchMembersByName(all, '   ').unreadable).toBe(0);
  });

  test('находит по части имени', () => {
    const r = searchMembersByName([anna, anton, boris], 'ан');
    expect(r.matched.map((m) => m.peerPubB64)).toEqual(['a', 'b']);
  });

  test('регистр запроса не важен', () => {
    expect(searchMembersByName([boris], 'БОР').matched).toEqual([boris]);
  });

  test('регистр имени не важен', () => {
    expect(searchMembersByName([{ peerPubB64: 'x', displayName: 'ЗОЯ' }], 'зо').matched).toHaveLength(1);
  });

  test('пробелы по краям запроса срезаются', () => {
    expect(searchMembersByName([anna], '  анн  ').matched).toEqual([anna]);
  });

  test('непрочитанное имя не совпадает, но и не теряется молча', () => {
    const r = searchMembersByName([anna, hidden], 'анн');
    expect(r.matched).toEqual([anna]);
    expect(r.unreadable).toBe(1);
  });

  test('непрочитанное имя считается, даже если запрос не совпал ни с кем', () => {
    const r = searchMembersByName([anna, hidden], 'щщщ');
    expect(r.matched).toEqual([]);
    expect(r.unreadable).toBe(1);
  });

  test('несколько непрочитанных имён считаются все', () => {
    const r = searchMembersByName([hidden, { ...hidden, peerPubB64: 'd2' }, anna], 'зззз');
    expect(r.unreadable).toBe(2);
  });

  test('участник без имени, но читаемый, — не жалоба', () => {
    const r = searchMembersByName([nameless], 'ан');
    expect(r.matched).toEqual([]);
    expect(r.unreadable).toBe(0);
  });

  test('displayNameUnreadable: false — обычный участник', () => {
    const r = searchMembersByName([{ peerPubB64: 'f', displayName: 'Ева', displayNameUnreadable: false }], 'ев');
    expect(r.matched).toHaveLength(1);
    expect(r.unreadable).toBe(0);
  });

  test('порядок совпадений сохраняется', () => {
    const r = searchMembersByName([boris, anton, anna], 'а');
    expect(r.matched.map((m) => m.peerPubB64)).toEqual(['b', 'a']);
  });

  test('пустой состав — пустой ответ', () => {
    expect(searchMembersByName([], 'а')).toEqual({ matched: [], unreadable: 0 });
  });
});

describe('mentionableMembers', () => {
  test('пустой запрос — это открытая подсказка, а не «не ищу»', () => {
    const r = mentionableMembers([anna, hidden], '');
    expect(r.matched).toEqual([anna]);
    expect(r.unreadable).toBe(1);
  });

  test('непрочитанное имя не предлагается никогда', () => {
    expect(mentionableMembers([hidden], 'а').matched).toEqual([]);
    expect(mentionableMembers([hidden], '').matched).toEqual([]);
  });

  test('фильтрует по части имени', () => {
    const r = mentionableMembers([anna, anton, boris], 'ант');
    expect(r.matched).toEqual([anton]);
  });

  test('регистр не важен', () => {
    expect(mentionableMembers([boris], 'БОРИС').matched).toEqual([boris]);
  });

  test('участник без имени не предлагается, но и не считается жалобой', () => {
    const r = mentionableMembers([nameless], '');
    expect(r.matched).toEqual([]);
    expect(r.unreadable).toBe(0);
  });

  test('пустое имя от непрочитанного отличается: жалоба только на второе', () => {
    const r = mentionableMembers([nameless, hidden, anna], '');
    expect(r.matched).toEqual([anna]);
    expect(r.unreadable).toBe(1);
  });

  test('считает непрочитанные даже когда совпадений нет', () => {
    const r = mentionableMembers([hidden, hidden], 'щщ');
    expect(r).toEqual({ matched: [], unreadable: 2 });
  });
});

describe('подписи', () => {
  test('ноль непрочитанных — жаловаться не на что', () => {
    expect(memberSkippedNotice(0)).toBeNull();
    expect(mentionSkippedNotice(0)).toBeNull();
  });

  test('отрицательное и нечисло — тоже молчим', () => {
    expect(memberSkippedNotice(-1)).toBeNull();
    expect(mentionSkippedNotice(Number.NaN)).toBeNull();
    expect(memberSkippedNotice(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test('один участник — единственное число и «его»', () => {
    expect(memberSkippedNotice(1)).toBe(
      'Имя 1 участника не удалось прочитать — поиск по имени его не находит'
    );
    expect(mentionSkippedNotice(1)).toBe(
      'Имя 1 участника не удалось прочитать — упомянуть его нельзя'
    );
  });

  test('несколько — множественное и «их»', () => {
    expect(memberSkippedNotice(3)).toBe(
      'Имя 3 участников не удалось прочитать — поиск по имени их не находит'
    );
    expect(mentionSkippedNotice(5)).toBe(
      'Имя 5 участников не удалось прочитать — упомянуть их нельзя'
    );
  });

  test('21 — та же форма, что и у одного, но «их»', () => {
    expect(memberSkippedNotice(21)).toContain('21 участника');
    expect(memberSkippedNotice(21)).toContain('их не находит');
  });

  test('две подписи говорят о разных последствиях', () => {
    expect(memberSkippedNotice(2)).not.toBe(mentionSkippedNotice(2));
    expect(mentionSkippedNotice(2)).toContain('упомянуть');
  });

  test('дробное число обрезается, а не выводится как есть', () => {
    expect(memberSkippedNotice(2.7)).toContain('2 участников');
  });
});

describe('форма модуля', () => {
  test('модуль чист: единственный импорт — правило окончаний', () => {
    const imports = MODULE()
      .split('\n')
      .filter((l) => /^import /.test(l));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^import \{[^}]*\bpluralRu\b[^}]*\} from '\.\.\/storage\/ruPlural';$/);
  });

  test('модуль не тянет ни react, ни sqlite, ни expo', () => {
    const imports = MODULE()
      .split('\n')
      .filter((l) => /^import /.test(l))
      .join('\n');
    expect(imports).not.toMatch(/react|sqlite|expo/i);
  });

  test('пустой запрос разбирается по-разному в двух функциях — и это описано', () => {
    expect(MODULE()).toMatch(/Почему пустой запрос считается по-разному/);
  });
});

describe('экран зовёт модуль, а не фильтрует сам', () => {
  test('состав ищется модулем', () => {
    const body = slice(GROUPS(), "const [memberSearch, setMemberSearch] = useState('');", 'const [qrVisible');
    expect(body).toContain('searchMembersByName(members, memberSearch)');
    expect(body).toContain('memberSkippedNotice(');
    expect(body).not.toMatch(/members\.filter\(/);
  });

  test('подсказка упоминаний собирается модулем', () => {
    const body = slice(GROUPS(), 'const mentionHits = useMemo(', 'const insertMention =');
    expect(body).toContain('mentionableMembers(');
    expect(body).not.toMatch(/displayName\?\.toLowerCase\(\)/);
  });

  test('в подсказке остались и отсев «это я», и порог в пять имён', () => {
    const body = slice(GROUPS(), 'const mentionHits = useMemo(', 'const insertMention =');
    expect(body).toContain('m.peerPubB64 !== myPubB64');
    expect(body).toContain('.slice(0, 5)');
    expect(body).toContain('everyoneSuggestion ? [everyoneSuggestion, ...base] : base');
  });

  test('подсказка открывается и ради одной только жалобы', () => {
    expect(GROUPS()).toContain('{mentionSuggestions.length > 0 || mentionSkipped !== null ? (');
  });

  test('обе подписи выведены на экран в цвете предупреждения', () => {
    const src = GROUPS();
    expect(src).toContain('{mentionSkipped}');
    expect(src).toContain('{memberSkipped}');
    const warnLines = src.split('\n').filter((l) => l.includes('Skipped}'));
    expect(warnLines).toHaveLength(2);
    for (const l of warnLines) expect(l).toMatch(/colors\.warning/);
  });

  test('экран берёт весь набор из одного модуля', () => {
    const line = GROUPS()
      .split('\n')
      .find((l) => l.includes("from '../../core/social/memberSearch'"));
    expect(line).toBeDefined();
    for (const sym of ['searchMembersByName', 'mentionableMembers', 'memberSkippedNotice', 'mentionSkippedNotice']) {
      expect(line as string).toContain(sym);
    }
  });
});
