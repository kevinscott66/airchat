/**
 * Счётчик в кружке: один вид и одно имя (v4.32.931).
 *
 * Дефект. Правило «больше сотни — пиши «99+»» было выписано восемь раз, в
 * четырёх файлах, тремя способами сразу; рядом жило то же правило для кружка
 * поменьше — «9+», ещё три копии. И ни один кружок не имел имени: озвучка
 * читала нижнюю вкладку как «Чаты. 3», а на переполнении — «Чаты. 99 плюс».
 * Сами вкладки при этом не были вкладками: ни роли, ни выбранного состояния.
 *
 * Цена. Одиннадцать копий одного порога расходятся молча. Для незрячего же
 * нижний ряд — единственный вход в приложение, и он звучал как пять кнопок
 * без признака того, какая открыта.
 *
 * Правка. `ui/utils/badgeCount`: `badgeText` рисует, `unreadA11yLabel`
 * называет, `tabA11yLabel` склеивает название вкладки со счётом. В `App.tsx`
 * у вкладок появились `accessibilityRole="tab"` и `selected`, а название
 * каждой записано один раз — его читают и глаз, и озвучка.
 *
 * Границы. Что именно считает кружок, модуль не знает: «непрочитанные» — про
 * переписки, у заявок на вступление подпись своя и уже написана на месте
 * (`GroupsScreen`). Поэтому `badgeText` без слов, а имя даётся отдельно.
 */
import fs from 'fs';
import path from 'path';

import { pluralRu } from '../../core/storage/ruPlural';
import { badgeDigit } from '../theme';
import { badgeText, tabA11yLabel, unreadA11yLabel, BADGE_MAX, SMALL_BADGE_MAX } from '../utils/badgeCount';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const APP = 'App.tsx';
const TABS = ['feed', 'chat', 'groups', 'profile', 'settings'] as const;
const TITLES = ['Новости', 'Чаты', 'Группы', 'Профиль', 'Ещё'] as const;

describe('число в кружке', () => {
  it('ноль, отрицательное и нечисло кружка не рисуют', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-3)).toBe('');
    expect(badgeText(NaN)).toBe('');
    expect(badgeText(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('до порога — само число', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(42)).toBe('42');
    expect(badgeText(BADGE_MAX)).toBe('99');
  });

  it('за порогом — «99+»', () => {
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(4821)).toBe('99+');
  });

  it('кружок поверх значка вмещает одну цифру', () => {
    expect(badgeText(9, SMALL_BADGE_MAX)).toBe('9');
    expect(badgeText(10, SMALL_BADGE_MAX)).toBe('9+');
  });

  it('дробь отбрасывается — счёт всегда про штуки', () => {
    expect(badgeText(3.9)).toBe('3');
  });
});

describe('как счётчик звучит', () => {
  it('число склоняется', () => {
    expect(unreadA11yLabel(1)).toBe('1 непрочитанное');
    expect(unreadA11yLabel(2)).toBe('2 непрочитанных');
    expect(unreadA11yLabel(5)).toBe('5 непрочитанных');
    expect(unreadA11yLabel(21)).toBe('21 непрочитанное');
  });

  it('переполнение читается словами, а не знаком', () => {
    expect(unreadA11yLabel(100)).toBe('больше 99 непрочитанных');
    expect(unreadA11yLabel(100)).not.toContain('+');
    expect(unreadA11yLabel(10, SMALL_BADGE_MAX)).toBe('больше 9 непрочитанных');
  });

  it('нечего считать — нечего и говорить', () => {
    expect(unreadA11yLabel(0)).toBe('');
    expect(unreadA11yLabel(NaN)).toBe('');
  });

  it('имя вкладки: название, а за ним счёт', () => {
    expect(tabA11yLabel('Чаты', 0)).toBe('Чаты');
    expect(tabA11yLabel('Чаты', 3)).toBe('Чаты, 3 непрочитанных');
    expect(tabA11yLabel('Группы', 250)).toBe('Группы, больше 99 непрочитанных');
  });
});

describe('вкладки называются и знают, какая открыта', () => {
  const app = codeOnly(APP);

  for (const t of TABS) {
    it(`${t}: роль вкладки и выбранное состояние`, () => {
      expect(app).toContain(`testID="tab_${t}"\n            accessibilityRole="tab"`);
      expect(app).toContain(`accessibilityState={{ selected: tab === '${t}' }}`);
    });
  }

  it('счётчик уходит в подпись, а не остаётся голой цифрой', () => {
    expect(app).toContain('accessibilityLabel={tabA11yLabel(TAB_TITLES.chat, chatUnread)}');
    expect(app).toContain('accessibilityLabel={tabA11yLabel(TAB_TITLES.groups, groupUnread)}');
  });

  it('вкладки без счётчика названы своим словом', () => {
    for (const t of ['feed', 'profile', 'settings'] as const) {
      expect(app).toContain(`accessibilityLabel={TAB_TITLES.${t}}`);
    }
  });

  it('название вкладки записано ровно один раз', () => {
    for (const title of TITLES) {
      const hits = app.split(`'${title}'`).length - 1;
      expect([title, hits]).toEqual([title, 1]);
    }
  });
});

describe('порог записан в одном месте', () => {
  it('«99+» и «9+» руками больше нигде не пишут', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name)) continue;
        const rel = full.slice(SRC.length + 1);
        if (rel === 'ui/utils/badgeCount.ts') continue;
        const src = fs.readFileSync(full, 'utf8');
        if (src.includes("'99+'") || src.includes("'9+'")) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('все одиннадцать кружков зовут общую подпись', () => {
    const users = ['App.tsx', 'ui/screens/GroupsScreen.tsx', 'ui/screens/ChatScreen.tsx', 'ui/screens/ChatListScreen.tsx'];
    let calls = 0;
    for (const rel of users) {
      expect(codeOnly(rel)).toContain("utils/badgeCount'");
      calls += codeOnly(rel).split('badgeText(').length - 1;
    }
    expect(calls).toBe(11);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('склонение живо и снаружи', () => {
    expect(pluralRu(1, 'непрочитанное', 'непрочитанных', 'непрочитанных')).toBe('непрочитанное');
    expect(pluralRu(11, 'непрочитанное', 'непрочитанных', 'непрочитанных')).toBe('непрочитанных');
  });

  it('цифра в кружке по-прежнему меньше обычной — токен на месте', () => {
    expect(badgeDigit).toBe(10);
  });

  it('у заявок на вступление подпись своя, и она осталась на месте', () => {
    // Границу видно: модуль счётчика не знает слова «заявки», и знать не должен.
    expect(codeOnly('ui/screens/GroupsScreen.tsx')).toContain('accessibilityLabel={`Заявки на вступление: ${pendingCount}`}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  /** Как кружок рисовали до правки — в восьми местах из одиннадцати. */
  const oldBadge = (n: number): string => (n > 99 ? '99+' : String(n));

  it('на обычном счёте прежняя запись совпадает — потому и прожила', () => {
    for (const n of [1, 7, 42, 99, 100, 5000]) {
      expect(oldBadge(n)).toBe(badgeText(n));
    }
  });

  it('а на испорченном счёте рисовала «NaN» прямо в кружке', () => {
    expect(oldBadge(NaN)).toBe('NaN');
    expect(badgeText(NaN)).toBe('');
  });

  it('и произносилась знаком, а не словом', () => {
    expect(oldBadge(150)).toContain('+');
    expect(unreadA11yLabel(150)).not.toContain('+');
  });
});
