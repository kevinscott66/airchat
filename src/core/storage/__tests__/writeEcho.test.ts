import fs from 'fs';
import path from 'path';

import { anyChanged, changedRows } from '../writeEcho';

const LOCAL = fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Тело экспортируемой функции целиком — от её объявления до следующего export. */
function fnBody(name: string): string {
  const start = LOCAL.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = LOCAL.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('changedRows', () => {
  it('число изменённых строк проходит как есть', () => {
    expect(changedRows({ changes: 1 })).toBe(1);
    expect(changedRows({ changes: 42 })).toBe(42);
  });

  it('ноль изменений — это ноль', () => {
    // Ради этого случая всё и затевалось: UPDATE, не тронувший ни одной
    // строки, не должен будить подписчиков.
    expect(changedRows({ changes: 0 })).toBe(0);
  });

  it('неизвестность читается как «не менялось»', () => {
    // null, отсутствующее поле, NaN, минус — разные обёртки SQLite ведут себя
    // по-разному. Если трактовать «не знаю» как «изменилось», круг вернётся.
    expect(changedRows(null)).toBe(0);
    expect(changedRows(undefined)).toBe(0);
    expect(changedRows({})).toBe(0);
    expect(changedRows({ changes: null })).toBe(0);
    expect(changedRows({ changes: NaN })).toBe(0);
    expect(changedRows({ changes: -3 })).toBe(0);
    expect(changedRows({ changes: Infinity })).toBe(0);
  });

  it('дробное число строк округляется вниз', () => {
    expect(changedRows({ changes: 2.7 })).toBe(2);
  });

  it('не бросает ни на чём из перечисленного', () => {
    for (const v of [null, undefined, {}, { changes: null }, { changes: NaN }]) {
      expect(() => changedRows(v as never)).not.toThrow();
    }
  });
});

describe('anyChanged', () => {
  it('одного настоящего изменения достаточно', () => {
    expect(anyChanged({ changes: 0 }, { changes: 1 })).toBe(true);
    expect(anyChanged({ changes: 1 }, { changes: 0 })).toBe(true);
  });

  it('все запросы вхолостую — сигнала нет', () => {
    expect(anyChanged({ changes: 0 }, { changes: 0 })).toBe(false);
    expect(anyChanged(null, undefined, {})).toBe(false);
  });

  it('пустой список — не изменение', () => {
    expect(anyChanged()).toBe(false);
  });
});

describe('исходники: сигнал хранилища привязан к изменению', () => {
  const GUARDED = [
    'markConversationRead',
    'markAllConversationsRead',
    'markConversationUnread',
    'markGroupRead',
    'markAllGroupsRead',
    'markGroupUnread',
  ];

  it.each(GUARDED)('%s будит подписчиков только через anyChanged', (name) => {
    // Круг loadMessages → markGroupRead → emitChatWrites → loadMessages
    // держался ровно на безусловном вызове emitChatWrites в этих функциях.
    const body = fnBody(name);
    expect(body).toContain('if (anyChanged(');
    expect(body).not.toMatch(/\n {4}emitChatWrites\(\);/);
  });

  it.each(GUARDED)('%s отсеивает строки, которым менять нечего', (name) => {
    // Без условия в WHERE поле changes врёт: SQLite считает изменением и
    // запись того же самого значения.
    const body = fnBody(name);
    expect(body).toMatch(/unread_count (!=|=) 0/);
  });

  it('снятие непрочитанных у группы проверяет обе колонки', () => {
    // mention_count живёт отдельно от unread_count: упоминание могло остаться
    // при нулевом счётчике сообщений, и такую строку чистить надо.
    for (const name of ['markGroupRead', 'markAllGroupsRead']) {
      expect(fnBody(name)).toContain('(unread_count != 0 OR mention_count != 0)');
    }
  });

  it('пометка «непрочитано» больше не считает через CASE', () => {
    // CASE менял значение на такое же и потому всегда давал changes = 1.
    expect(fnBody('markConversationUnread')).not.toContain('CASE WHEN unread_count');
    expect(fnBody('markGroupUnread')).not.toContain('MAX(unread_count');
  });

  it('сбой снятия непрочитанных попадает в журнал', () => {
    // Было `catch { }` — счётчик не гас, и объяснить это было нечем.
    for (const name of ['markGroupRead', 'markAllGroupsRead', 'markGroupUnread']) {
      expect(fnBody(name)).toContain('log.warn(');
    }
  });

  it('отметки о прочтении в группе не уходят по второму разу', () => {
    // Вторая половина той же цены: loadMessages зовётся на каждую запись в
    // хранилище, а дедупликация отметок жила внутри одного вызова — те же
    // отметки уходили тем же двадцати участникам снова и снова.
    const grp = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
      'utf8',
    );
    expect(grp).toContain('sentGroupReceiptsRef');
    expect(grp).toContain('if (sentGroupReceiptsRef.current.has(mark)) continue;');
  });

  it('модуль сигнала не тянет за собой ни базу, ни expo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'writeEcho.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
  });
});
