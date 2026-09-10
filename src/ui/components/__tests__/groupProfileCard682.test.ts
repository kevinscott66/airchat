/**
 * Круг 4.32.682. Шапка группы и канала — карточка профиля.
 *
 * Три беды, которые здесь заперты:
 *
 *  1. Канал назывался группой. Счётчик в шапке звал `membersLabel` без
 *     разбора вида, и подписчики канала считались участниками, хотя
 *     `subscribersLabel` лежал в `plural.ts` с самого начала.
 *  2. Непрочитанная ячейка (название, адрес, описание) выглядела как пустое
 *     место — неотличимо от «здесь ничего не задано». Администратор, нажав
 *     «добавить», затёр бы чужое значение, которого не видел.
 *  3. Состав шапки жил вложенными тернарными операторами посреди экрана на
 *     шесть тысяч строк и не проверялся ничем, кроме запуска приложения.
 */

import fs from 'fs';
import path from 'path';
import {
  groupKindGenitive,
  groupProfileRows,
  groupProfileSubtitle,
  groupProfileTitle,
  type GroupProfileFacts,
} from '../groupProfileModel';

function facts(over: Partial<GroupProfileFacts> = {}): GroupProfileFacts {
  return {
    type: 'group',
    amAdmin: false,
    name: 'Наши',
    handle: null,
    description: '',
    publicId: 'GR7QK2',
    memberCount: 12,
    ...over,
  };
}

describe('подпись под названием различает группу и канал', () => {
  it('у канала — подписчики, у группы — участники', () => {
    expect(groupProfileSubtitle(facts({ type: 'channel', memberCount: 12 }))).toBe('Канал · 12 подписчиков');
    expect(groupProfileSubtitle(facts({ type: 'group', memberCount: 12 }))).toBe('Группа · 12 участников');
  });

  it('и склоняется по числу, а не приписывает окончание', () => {
    expect(groupProfileSubtitle(facts({ type: 'channel', memberCount: 1 }))).toBe('Канал · 1 подписчик');
    expect(groupProfileSubtitle(facts({ type: 'group', memberCount: 1 }))).toBe('Группа · 1 участник');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: слова у двух видов действительно разные', () => {
    const ch = groupProfileSubtitle(facts({ type: 'channel' }));
    const gr = groupProfileSubtitle(facts({ type: 'group' }));
    expect(ch).not.toBe(gr);
    expect(ch).not.toContain('участ');
    expect(gr).not.toContain('подпис');
  });

  it('родительный падеж вида — для подсказок', () => {
    expect(groupKindGenitive('channel')).toBe('канала');
    expect(groupKindGenitive('group')).toBe('группы');
  });
});

describe('название', () => {
  it('пустое название названо по виду', () => {
    expect(groupProfileTitle(facts({ name: '' }))).toBe('Группа без названия');
    expect(groupProfileTitle(facts({ name: '', type: 'channel' }))).toBe('Канал без названия');
  });

  it('непрочитанное название не притворяется отсутствующим', () => {
    const t = groupProfileTitle(facts({ name: '', nameUnreadable: true }));
    expect(t).toBe('Название не удалось прочитать');
    // ПРОВЕРКА НЕ ПУСТАЯ: обычное название по-прежнему показывается как есть.
    expect(groupProfileTitle(facts({ name: 'Наши' }))).toBe('Наши');
  });
});

describe('строки карточки', () => {
  it('участник не видит приглашений заполнить пустое', () => {
    const rows = groupProfileRows(facts({ amAdmin: false, handle: null, description: '' }));
    expect(rows.map((r) => r.id)).toEqual(['public_id']);
  });

  it('администратор видит их обе', () => {
    const rows = groupProfileRows(facts({ amAdmin: true, handle: null, description: '' }));
    expect(rows.map((r) => r.id)).toEqual(['handle', 'description', 'public_id']);
    expect(rows[0]).toMatchObject({ value: null, placeholder: 'Добавить публичный адрес', editable: true });
    expect(rows[1]).toMatchObject({ value: null, placeholder: 'Добавить описание группы', editable: true });
  });

  it('приглашение к описанию знает вид', () => {
    const rows = groupProfileRows(facts({ amAdmin: true, type: 'channel' }));
    expect(rows[1]).toMatchObject({ placeholder: 'Добавить описание канала' });
  });

  it('адрес показывается с собачкой и копируется', () => {
    const rows = groupProfileRows(facts({ handle: 'aircafe' }));
    expect(rows[0]).toMatchObject({ id: 'handle', value: '@aircafe', copyable: true });
    // ПРОВЕРКА НЕ ПУСТАЯ: участнику адрес не отдаётся на правку.
    expect(rows[0].editable).toBeFalsy();
    expect(groupProfileRows(facts({ handle: 'aircafe', amAdmin: true }))[0].editable).toBe(true);
  });

  it('непрочитанные ячейки говорят об этом вслух, а не молчат', () => {
    const rows = groupProfileRows(
      facts({ amAdmin: true, handleUnreadable: true, descriptionUnreadable: true, description: '' }),
    );
    expect(rows[0]).toMatchObject({ id: 'handle', value: null, unreadable: true, placeholder: 'Адрес не удалось прочитать' });
    expect(rows[1]).toMatchObject({ id: 'description', value: null, unreadable: true, placeholder: 'Описание не удалось прочитать' });
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: без признака те же данные дали бы «добавить».
    const plain = groupProfileRows(facts({ amAdmin: true }));
    expect(plain[0].placeholder).toBe('Добавить публичный адрес');
    expect(plain[0].unreadable).toBeFalsy();
  });

  it('непрочитанное видит и участник — иначе он решит, что адреса нет', () => {
    const rows = groupProfileRows(facts({ amAdmin: false, handleUnreadable: true }));
    expect(rows.map((r) => r.id)).toEqual(['handle', 'public_id']);
    expect(rows[0].editable).toBeFalsy();
  });

  it('постоянный идентификатор всегда последний', () => {
    for (const f of [
      facts({ amAdmin: true, handle: 'aircafe', description: 'Про кофе' }),
      facts({ amAdmin: false }),
      facts({ amAdmin: true, type: 'channel', handleUnreadable: true }),
    ]) {
      const rows = groupProfileRows(f);
      expect(rows[rows.length - 1]).toMatchObject({ id: 'public_id', value: 'GR7QK2', copyable: true });
    }
    // ПРОВЕРКА НЕ ПУСТАЯ: если идентификатор вывести не удалось, строки нет.
    expect(groupProfileRows(facts({ publicId: '' })).map((r) => r.id)).toEqual([]);
  });

  it('у каждой строки есть подпись для голосового доступа', () => {
    const rows = groupProfileRows(facts({ amAdmin: true, handle: 'aircafe', description: 'Про кофе' }));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.a11y.length).toBeGreaterThan(5);
  });
});

describe('экран отдал шапку компоненту', () => {
  const SCREEN = fs.readFileSync(path.join(__dirname, '..', '..', 'screens', 'GroupsScreen.tsx'), 'utf8');
  const HEADER = fs.readFileSync(
    path.join(__dirname, '..', '..', 'screens', 'groups-components', 'GroupProfileHeader.tsx'),
    'utf8',
  );

  it('ПРОВЕРКА НЕ ПУСТАЯ: читаются те самые файлы', () => {
    expect(SCREEN.length).toBeGreaterThan(100_000);
    expect(HEADER).toContain('export function GroupProfileHeader');
  });

  it('разметки шапки на экране больше нет', () => {
    expect(SCREEN).toContain('<GroupProfileHeader');
    expect(SCREEN).not.toContain('gmStyles.infoHeader');
    expect(SCREEN).not.toContain('gmStyles.avatarEditBadge');
    expect(SCREEN).not.toContain('+ Добавить публичный адрес');
  });

  it('счётчик в шапке больше не зовёт membersLabel вслепую', () => {
    expect(SCREEN).not.toContain('membersLabel(members.length)');
    expect(HEADER).toContain('groupProfileSubtitle(facts)');
  });

  it('у компонента нет своих чисел кегля — только токены font', () => {
    const code = HEADER.split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    expect(code.match(/fontSize:\s*\d/g)).toBeNull();
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: кегль всё-таки задаётся, просто из шкалы.
    expect(code).toContain('fontSize: font.');
  });
});
