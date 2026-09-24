/**
 * v4.32.888 — «N сообщ.» и ни слова о том, у кого сообщение пропадёт.
 *
 * Дефект. Подтверждение удаления пачки в переписке и в группе показывало
 * одно и то же тело: число и обрубок слова. Между тем действия за ними
 * разные и необратимые по-разному. В личной переписке пачка идёт через
 * `deleteMessageLocally` — только своё устройство. В группе каждое удаление
 * уходит участникам управляющим конвертом `op: 'del'`, то есть стирает
 * сообщение и у них. Одиночное удаление в группе спрашивало и того меньше:
 * тело было пустой строкой.
 *
 * Цена. Одиночное удаление в переписке спрашивает выбором — «Удалить у
 * себя» или «Удалить у всех». Человек, только что выбиравший второе,
 * выделяет десять сообщений, жмёт «Удалить» и получает первое, ничего об
 * этом не узнав: у собеседника всё на месте. В группе — зеркально: человек
 * думает, что убирает у себя, а сообщение пропадает у всех, и вернуть его
 * нельзя. Числа при этом писались как «1 новых» и «1 непрочитанных».
 *
 * Правка. Тело называет область действия словами, число согласовано с ним
 * через `pluralRu`. Поведение удаления не тронуто — тронуты только слова.
 */
import fs from 'fs';
import path from 'path';
import { pluralRu } from '../../../core/storage/ruPlural';

const SRC = path.join(__dirname, '..', '..');
/** Исходник без строк-комментариев: объяснение правки не должно её подтверждать. */
const bare = (...rel: string[]): string =>
  fs
    .readFileSync(path.join(SRC, ...rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const chat = (): string => bare('screens', 'ChatScreen.tsx');
const groups = (): string => bare('screens', 'GroupsScreen.tsx');
const stats = (): string => bare('components', 'modals', 'groups', 'GroupStatsModal.tsx');

/** Тело `Alert.alert` — от заголовка до открывающей скобки списка кнопок. */
function alertBody(source: string, title: string): string {
  const at = source.indexOf(`'${title}'`);
  expect(at).toBeGreaterThan(0);
  const rest = source.slice(at + title.length + 2);
  return rest.slice(0, rest.indexOf('[\n'));
}

describe('окно удаления называет, у кого сообщение пропадёт', () => {
  it('переписка, пачка: сказано, что у собеседника останется', () => {
    const body = alertBody(chat(), 'Удалить выбранные?');
    expect(body).toContain('только у вас');
    expect(body).toContain('У собеседника');
    expect(body).not.toContain('сообщ.');
  });

  it('группа, пачка: сказано, что удалится у всех участников', () => {
    const body = alertBody(groups(), 'Удалить выбранные?');
    expect(body).toContain('у всех участников группы');
    expect(body).not.toContain('сообщ.');
  });

  it('группа, одно сообщение: тело больше не пустое', () => {
    const body = alertBody(groups(), 'Удалить сообщение?');
    expect(body).not.toMatch(/,\s*''\s*,/);
    expect(body).toContain('у всех участников группы');
    expect(body).toContain('Недавно удалённых');
  });
});

describe('число согласовано со словом', () => {
  it('полоса непрочитанных в переписке', () => {
    const say = (n: number): string => `↓ ${n} ${pluralRu(n, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`;
    expect([say(1), say(2), say(5), say(11), say(21)]).toEqual([
      '↓ 1 новое сообщение',
      '↓ 2 новых сообщения',
      '↓ 5 новых сообщений',
      '↓ 11 новых сообщений',
      '↓ 21 новое сообщение',
    ]);
    expect(chat()).toContain("pluralRu(openUnreadCount, 'новое сообщение', 'новых сообщения', 'новых сообщений')");
  });

  it('полоса непрочитанных в группе', () => {
    const say = (n: number): string => `${n} ${pluralRu(n, 'непрочитанное', 'непрочитанных', 'непрочитанных')}`;
    expect([say(1), say(3), say(9)]).toEqual(['1 непрочитанное', '3 непрочитанных', '9 непрочитанных']);
    expect(groups()).toContain("pluralRu(grpOpenUnread, 'непрочитанное', 'непрочитанных', 'непрочитанных')");
  });

  it('счётчик в статистике группы', () => {
    const say = (n: number): string => `${n} ${pluralRu(n, 'сообщение', 'сообщения', 'сообщений')}`;
    expect([say(1), say(2), say(5)]).toEqual(['1 сообщение', '2 сообщения', '5 сообщений']);
    expect(stats()).not.toContain('сообщ.');
  });

  it('оба подтверждения удаления склоняют глагол, а не только существительное', () => {
    const say = (n: number): string =>
      `${n} ${pluralRu(n, 'сообщение удалится', 'сообщения удалятся', 'сообщений удалятся')}`;
    expect([say(1), say(2), say(5)]).toEqual(['1 сообщение удалится', '2 сообщения удалятся', '5 сообщений удалятся']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: области действия по-прежнему разные', () => {
  it('переписка удаляет пачку только у себя', () => {
    expect(chat()).toContain('ids.map((id) => svc.deleteMessageLocally(id))');
  });

  it('группа рассылает удаление участникам', () => {
    expect(groups()).toContain("{ op: 'del', msgId: id }");
    expect(groups()).toContain("{ op: 'del', msgId: msg.id }");
  });

  it('выбор «у себя» или «у всех» для одного сообщения в переписке на месте', () => {
    const s = chat();
    expect(s).toContain("label: 'Удалить у себя'");
    expect(s).toContain("label: 'Удалить у всех'");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удаление осталось удалением', () => {
  it('копии по-прежнему кладутся в «Недавно удалённые»', () => {
    expect(chat()).toContain('await saveRecentlyDeleted(m)');
    expect(groups()).toContain('await saveGrpRecentlyDeleted(m)');
  });

  it('кнопки подтверждения не потерялись', () => {
    for (const s of [chat(), groups()]) {
      expect(s).toContain("{ text: 'Отмена', style: 'cancel' }");
      expect(s).toContain("text: 'Удалить', style: 'destructive'");
    }
  });

  it('несостоявшееся удаление по-прежнему называется вслух', () => {
    expect(chat()).toContain('в переписке — удалить не получилось');
    expect(groups()).toContain('в группе — удалить не получилось');
  });
});
