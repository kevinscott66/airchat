/**
 * Упоминание в группе и непрочитанный справочник контактов (v4.32.1049).
 *
 * ДЕФЕКТ. `handleMentionPress` сверял `@имя` со своим справочником контактов
 * через `listContactsFor`, а та на отказ базы отдаёт пустой список — то же
 * самое, что «этого имени у меня ни за кем не записано». Дальше имя
 * разрешалось `resolveMention(bare, allMembers)` по строкам состава группы.
 *
 * ЦЕНА. В строке состава юзернейма нет вовсе (GroupMemberRow), так что
 * совпасть могло только отображаемое имя, а его в группе назначает себе сам
 * участник. Достаточно было назваться «alice», чтобы при непрочитанном
 * справочнике нажатие на @alice открыло карточку самозванца — с «Написать» и
 * со словами «тревожиться не о чем» про ключ. Проверка по справочнику
 * (v4.32.615) заводилась ровно против этого и молча выключалась.
 *
 * ПРАВКА. Читать различающим чтением (`listContactsReadFor`) и на отказ
 * говорить вслух, что проверить не вышло, а не угадывать.
 *
 * ГРАНИЦЫ. Прочитанный и пустой справочник ведёт себя как прежде: имя ищется
 * среди участников. Неведение временное — чтение живёт внутри обработчика,
 * следующее нажатие пробует заново.
 */
import fs from 'fs';
import path from 'path';

import { resolveMention } from '../../../core/social/mentionResolve';
import { mentionMissText } from '../../../core/social/usernameDirectory';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

/** Тело `handleMentionPress` в экране групп. */
const HANDLER = (): string =>
  slice(read('ui', 'screens', 'GroupsScreen.tsx'), 'const handleMentionPress', '\n  }, [');

describe('справочник не прочитан — отказ вслух, а не догадка', () => {
  it('справочник читается различающим чтением', () => {
    expect(HANDLER()).toContain('const contacts = await listContactsReadFor(pid);');
  });

  it('двузначного чтения в обработчике не осталось', () => {
    // `listContactsFor` плющит отказ базы в пустой список — см. ниже
    // «ПОВОД ДЛЯ ПРАВКИ ЖИВ»: сама она никуда не делась и нужна в других
    // местах, но здесь её ответ неотличим от «имя никому не записано».
    expect(HANDLER()).not.toContain('listContactsFor(');
  });

  it('на отказ обработчик выходит, ничего не открыв', () => {
    const h = HANDLER();
    expect(h).toContain('if (contacts === null) {');
    expect(h).toContain("showError(mentionMissText('unreadable', bare));");
    const refusal = slice(h, 'if (contacts === null) {', 'const pubs');
    expect(refusal).toContain('return;');
    expect(refusal).not.toContain('setMentionPeek');
  });

  it('отказ стоит раньше разбора по отображаемым именам', () => {
    // Иначе порядок ничего не значил бы: самозванец нашёлся бы прежде, чем
    // дело дошло до отказа.
    const h = HANDLER();
    expect(h.indexOf("mentionMissText('unreadable', bare)")).toBeGreaterThan(-1);
    expect(h.indexOf("mentionMissText('unreadable', bare)"))
      .toBeLessThan(h.indexOf('resolveMention(bare, allMembers)'));
  });

  it('отказ отмечается в журнале', () => {
    expect(HANDLER()).toContain("log.warn('group_mention_lookup_failed'");
  });
});

describe('что человек видит, когда не выяснили', () => {
  it('сказано про нас, а не про имя', () => {
    const text = mentionMissText('unreadable', 'alice');
    expect(text).toContain('@alice');
    expect(text).toContain('справочник контактов не прочитался');
  });

  it('это состояние временное, и об этом сказано', () => {
    expect(mentionMissText('unreadable', 'alice')).toContain('Попробуйте ещё раз');
  });

  it('не выдаётся за «имени нет» и не за «нет связи»', () => {
    const text = mentionMissText('unreadable', 'alice');
    expect(text).not.toMatch(/не существует|занят|нет связи/);
  });

  it('у каждого исхода свои слова', () => {
    const statuses = [
      'ambiguous', 'space', 'unclaimed', 'unlisted', 'unconfigured', 'unreadable', 'unknown',
    ] as const;
    const texts = statuses.map((s) => mentionMissText(s, 'alice'));
    expect(new Set(texts).size).toBe(statuses.length);
  });
});

describe('ГРАНИЦА: прочитанный справочник работает как прежде', () => {
  it('счёт по ключам и отказ на неоднозначности на месте', () => {
    const h = HANDLER();
    expect(h).toContain('.map((c) => c.peerPublicKey)');
    expect(h).toContain('ambiguousUsername = pubs.size > 1;');
    expect(h).toContain('byUsername = pubs.size === 1 ? [...pubs][0] : null;');
  });

  it('прочитанный и пустой справочник не мешает искать среди участников', () => {
    expect(HANDLER()).toContain('resolveMention(bare, allMembers)');
  });

  it('чтение живёт внутри обработчика — следующее нажатие пробует заново', () => {
    // Отказ нигде не запоминается: в теле нет ни состояния, ни ссылки, куда
    // его можно было бы отложить до перезапуска экрана.
    const h = HANDLER();
    expect(h).toContain('const handleMentionPress = useCallback');
    expect(h).not.toContain('useState');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: `listContactsFor` по-прежнему отдаёт пустоту на отказ', () => {
    expect(read('core', 'social', 'contacts.ts'))
      .toContain('(await listContactsReadFor(ownerProfileId)) ?? []');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: в строке участника юзернейма нет', () => {
    // Значит, запасной разбор по составу группы может совпасть только по
    // отображаемому имени — тому, которое участник назначает себе сам.
    const row = slice(read('core', 'storage', 'local.ts'), 'export type GroupMemberRow = {', '\n};');
    expect(row).toContain('displayName: string | null;');
    expect(row).not.toContain('username');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: самозванец действительно находится по имени', () => {
    // Живой вызов, не закрепка: `resolveMention` для того и написана, чтобы
    // ловить упоминание по подписи участника. Пока справочник читается, этот
    // путь безопасен — до него доезжают только имена, которых у меня ни за
    // кем не записано.
    const hits = resolveMention('alice', [
      { username: null, displayName: 'alice' },
      { username: null, displayName: 'Боб' },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].displayName).toBe('alice');
  });

  it('ЗАКРЕПКА: отказ на неоднозначности стоит раньше разбора по составу', () => {
    const h = HANDLER();
    expect(h.indexOf("showError(mentionMissText('ambiguous', bare))"))
      .toBeLessThan(h.indexOf('const hits = byUsername'));
  });
});
