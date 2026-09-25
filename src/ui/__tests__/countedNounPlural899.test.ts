/**
 * Число и слово рядом с ним согласованы (v4.32.899).
 *
 * Дефект: в восьми местах счётчик печатался с обрубком — «5 уч.», «3 дн.»,
 * «12 чел.», «через 2 мин.», — а в двух местах несклоняемая форма была ещё и
 * неверной: «Удалено. 1 контактов сейчас недоступны», «Скрыто: 1 авт.».
 * Обрубок выбирают там, где боятся за ширину; но в шести из восьми мест подпись
 * стоит на отдельной строке или в заголовке, где места достаточно, а в
 * заголовке группы соседняя ветка того же выражения уже склоняла — «12
 * участников» в обычном режиме против «12 уч.» в медленном.
 *
 * Цена не в красоте. «1 контактов» и «1 авт.» человек читает как ошибку
 * приложения, а сообщение об удалении публикации — ровно то место, где ему
 * нужно верить написанному. Сокращение же заставляет достраивать слово: «3 г.»
 * это год, гость или гигабайт.
 *
 * Правка: счётчики зовут `ruPlural` (`core/text/ruPlural`) и подписи из
 * `ui/utils/plural` — механизм в доме один и уже есть.
 *
 * Строка списка групп (`GroupsScreen` :444) намеренно ОСТАВЛЕНА сокращённой:
 * там счётчик делит строку с названием группы (`flex: 1`, `numberOfLines={1}`),
 * и «12 участников» вместо «12 уч.» откусит семь знаков от каждого названия.
 * Сокращение там — не небрежность, а плата за ширину; ниже это закреплено,
 * чтобы следующая уборка не «дочинила» его вслепую.
 */
import fs from 'fs';
import path from 'path';

import { ruPlural } from '../../core/text/ruPlural';
import { membersLabel, minutesLabel, subscribersLabel } from '../utils/plural';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
const ru = JSON.parse(read('../i18n/ru.json')) as { feed: Record<string, string> };

describe('обрубков рядом с числом не осталось', () => {
  it('заголовок группы склоняет счётчик в обеих ветках', () => {
    const body = codeOnly('screens/GroupsScreen.tsx');
    expect(body).not.toContain('${headerMemberCount} уч.');
    expect(body).toContain("? `🐢 ${group.type === 'channel' ? 'Канал' : membersLabel(headerMemberCount)}`");
  });

  it('возраст учётной записи — словами', () => {
    const body = codeOnly('screens/ProfileScreen.tsx');
    for (const cut of ['${days} дн.', '${months} мес.', '${years} г.']) expect(body).not.toContain(cut);
    expect(body).toContain("ruPlural(days, ['день', 'дня', 'дней'])");
    expect(body).toContain("ruPlural(months, ['месяц', 'месяца', 'месяцев'])");
    expect(body).toContain("ruPlural(years, ['год', 'года', 'лет'])");
  });

  it('счётчик зрителей истории — словами', () => {
    const body = codeOnly('components/StoriesRow.tsx');
    expect(body).not.toContain('${viewers.length} чел.');
    expect(body).toContain("ruPlural(viewers.length, ['человек', 'человека', 'человек'])");
  });

  it('ожидание после неудачных попыток пароля — словами, в обоих местах', () => {
    const body = codeOnly('screens/PasswordScreen.tsx');
    expect(body).not.toContain(' мин.');
    expect(body).toContain('minutesLabel(lockoutMinutesLeft(lockout))');
    expect(body).toContain('minutesLabel(lockoutMinutesLeft(lockoutMs))');
    expect(minutesLabel(1)).toBe('1 минуту');
    expect(minutesLabel(2)).toBe('2 минуты');
    expect(minutesLabel(5)).toBe('5 минут');
    expect(minutesLabel(11)).toBe('11 минут');
  });

  it('список групп в ленте — полные слова: подпись стоит на своей строке', () => {
    const body = codeOnly('screens/FeedScreen.tsx');
    expect(body).toContain("{g.type === 'channel' ? subscribersLabel(g.memberCount) : membersLabel(g.memberCount)}");
    // Ключи-обрубки ушли из словаря совсем: оставить их значит оставить соблазн.
    expect(ru.feed.groupSubs).toBeUndefined();
    expect(ru.feed.groupMembers).toBeUndefined();
  });
});

describe('сообщения словаря больше не врут при единице', () => {
  it('«удалено частично» читается и про один контакт, и про несколько', () => {
    expect(ru.feed.deletedPartlyOne).toBeDefined();
    expect(ru.feed.deletedPartlyOne).not.toContain('{{');
    // Единственное число доведено до конца: «у него», «он выйдет».
    expect(ru.feed.deletedPartlyOne).toContain('у него');
    expect(ru.feed.deletedPartly).toContain('{{contacts}}');
    expect(ru.feed.deletedPartly).toContain('у них');
    expect(ru.feed.deletedPartly).not.toContain('{{n}}');

    const body = codeOnly('screens/FeedScreen.tsx');
    expect(body).toContain("? t('feed.deletedPartlyOne')");
    expect(body).toContain("ruPlural(missed, ['контакт', 'контакта', 'контактов'])");
    // Ноль недоставленных по-прежнему говорит «удалено у всех».
    const at = body.indexOf('const spread = missed === 0');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 120)).toContain("t('feed.deletedEverywhere')");
  });

  it('«скрытые авторы» не считают авторов обрубком и объясняют, как вернуть', () => {
    expect(ru.feed.mutedAuthorsMsg).not.toContain('авт.');
    expect(ru.feed.mutedAuthorsMsg).not.toContain('→');
    expect(ru.feed.mutedAuthorsMsg).toContain('{{count}}');
    expect(ru.feed.mutedAuthorsMsg).toContain('«Показывать публикации»');
  });
});

describe('подписи действительно склоняются', () => {
  it('три формы у каждой подписи, а не две', () => {
    expect(membersLabel(1)).toBe('1 участник');
    expect(membersLabel(3)).toBe('3 участника');
    expect(membersLabel(12)).toBe('12 участников');
    expect(subscribersLabel(1)).toBe('1 подписчик');
    expect(subscribersLabel(22)).toBe('22 подписчика');
  });

  it('формы возраста и зрителей — те же, что подставлены в экраны', () => {
    expect(ruPlural(1, ['день', 'дня', 'дней'])).toBe('день');
    expect(ruPlural(21, ['день', 'дня', 'дней'])).toBe('день');
    expect(ruPlural(3, ['месяц', 'месяца', 'месяцев'])).toBe('месяца');
    expect(ruPlural(5, ['год', 'года', 'лет'])).toBe('лет');
    expect(ruPlural(1, ['человек', 'человека', 'человек'])).toBe('человек');
    expect(ruPlural(2, ['человек', 'человека', 'человек'])).toBe('человека');
    expect(ruPlural(1, ['контакт', 'контакта', 'контактов'])).toBe('контакт');
    expect(ruPlural(5, ['контакт', 'контакта', 'контактов'])).toBe('контактов');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('сокращение в строке списка групп оставлено намеренно', () => {
    const body = codeOnly('screens/GroupsScreen.tsx');
    // Счётчик делит строку с названием: у названия `flex: 1` и обрезка в одну
    // строку, у счётчика `flexShrink: 0`. Полное слово отнимает ширину у
    // КАЖДОГО названия в списке — плата больше выигрыша.
    expect(body).toContain("`${item.memberCount} подп.` : `${item.memberCount} уч.`");
    expect(body).toContain("<Text style={[glStyles.name, rowFont.name, { color: colors.text }]} numberOfLines={1}>");
    expect(body).toContain("marginLeft: 6, flexShrink: 0 }}");
  });

  it('словарь остался разбираемым, а тронутые ключи — на месте', () => {
    expect(Object.keys(ru.feed).length).toBeGreaterThan(50);
    for (const k of ['deletedEverywhere', 'deletedPartly', 'mutedAuthorsMsg', 'mutedAuthorsTitle']) {
      expect(typeof ru.feed[k]).toBe('string');
      expect(ru.feed[k].length).toBeGreaterThan(0);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('правило склонения в доме одно, и это оно', () => {
    const core = fs.readFileSync(path.join(UI, '..', 'core', 'text', 'ruPlural.ts'), 'utf8');
    expect(core).toContain('export function ruPlural');
    expect(codeOnly('utils/plural.ts')).toContain("export { ruPlural } from '../../core/text/ruPlural';");
  });

  it('без склонения число и слово расходятся — вот как именно', () => {
    // Ровно те строки, что стояли на экранах до правки.
    expect(`${1} контактов`).not.toBe(`1 ${ruPlural(1, ['контакт', 'контакта', 'контактов'])}`);
    expect(`${2} участников`).not.toBe(membersLabel(2));
  });
});
