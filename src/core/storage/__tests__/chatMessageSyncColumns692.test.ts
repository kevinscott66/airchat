/**
 * Выгрузка сообщений и запись их обратно должны говорить об одних и тех же
 * столбцах (v4.32.692).
 *
 * exportRawChatMessageRows брал строку целиком (`SELECT *`), а
 * importRawChatMessageRows перечисляет одиннадцать столбцов — на пять меньше.
 * Эти пять (edited_at, reactions, forwarded_from, starred, transport) местные:
 * v4.32.615 специально закрыла их от перезаписи чужой ревизией, и это верно.
 * Неверно было отдавать их наружу: синхронизация считает отпечаток по тому,
 * что вернула выгрузка, а получатель у себя эти пять воспроизвести не может.
 * Отпечаток расходился с сохранённой головой навсегда, и устройства гоняли
 * одно и то же сообщение по кругу, тратя по мутации за проход.
 *
 * Проверка идёт по существу, а не по виду исходника: ниже собрана модель
 * прохода синхронизации, и она показывает и сходимость с перечислением, и
 * вечный круг без него.
 */

import fs from 'fs';
import path from 'path';

import {
  RAW_CHAT_MESSAGE_COLUMNS,
  sanitizeRawChatMessageRows,
} from '../chatMessageBackup';

const PUB = 'A'.repeat(43);
const NOW = 1_700_000_000_000;
const PID = 2;

/** Пять столбцов, которые остаются на устройстве и наружу не едут. */
const LOCAL_ONLY = ['edited_at', 'reactions', 'forwarded_from', 'starred', 'transport'];

const LOCAL = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'local.ts'), 'utf8');

/** Тело функции от заголовка до закрывающей скобки на нулевом отступе. */
function bodyOf(src: string, header: string): string {
  const from = src.indexOf(header);
  expect(from).toBeGreaterThan(-1);
  const to = src.indexOf('\n}', from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

/** Строка в БД: одиннадцать общих столбцов плюс пять местных. */
function dbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    contact_pub_b64: PUB,
    cid: null,
    text: 'enc2:xxxx',
    direction: 'in',
    status: 'delivered',
    media_cids: null,
    created_at: NOW - 1000,
    owner_profile_id: PID,
    reply_to_id: null,
    reply_to_preview: null,
    edited_at: null,
    reactions: null,
    forwarded_from: null,
    starred: 0,
    transport: null,
    ...over,
  };
}

function stable(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]])
  );
}

/** Выгрузка после правки: только перечисленные столбцы. */
function exportProjected(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of RAW_CHAT_MESSAGE_COLUMNS) out[c] = row[c];
  return out;
}

/** Выгрузка до правки: строка целиком. */
function exportStar(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

/** Запись входящей ревизии: трогает ровно перечисленные столбцы. */
function importRow(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...local };
  for (const c of RAW_CHAT_MESSAGE_COLUMNS) next[c] = incoming[c];
  return next;
}

/**
 * Модель обмена. Возвращает, сколько проходов подряд кто-то отправлял ревизию.
 * Ноль после первой передачи — обмен сошёлся.
 */
function cycle(
  exportRow: (r: Record<string, unknown>) => Record<string, unknown>,
  passes: number
): number {
  // Отправитель: у сообщения есть маршрут и реакция; получатель пуст.
  let a = dbRow({ transport: 'ipfs', reactions: '{"👍":["x"]}' });
  let b: Record<string, unknown> | null = null;
  // Голова — отпечаток той ревизии, которую сторона считает общей.
  let headA = stable(exportRow(a));
  let headB = '';
  let pushes = 0;

  // Первая передача: A -> B.
  const first = exportRow(a);
  b = importRow(dbRow({ transport: null, reactions: null }), first);
  headB = stable(first);

  for (let i = 0; i < passes; i++) {
    const fromB = stable(exportRow(b));
    if (fromB !== headB) {
      pushes++;
      a = importRow(a, exportRow(b));
      headA = fromB;
      headB = fromB;
    }
    const fromA = stable(exportRow(a));
    if (fromA !== headA) {
      pushes++;
      b = importRow(b, exportRow(a));
      headA = fromA;
      headB = fromA;
    }
  }
  return pushes;
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('список столбцов на месте, local.ts читается', () => {
    expect(RAW_CHAT_MESSAGE_COLUMNS.length).toBe(11);
    expect(LOCAL().length).toBeGreaterThan(100_000);
    expect(sanitizeRawChatMessageRows([dbRow()], PID, NOW).rows).toHaveLength(1);
  });
});

describe('выгрузка и запись говорят об одних столбцах', () => {
  it('разбор строки отдаёт ровно перечисленные ключи', () => {
    const { rows } = sanitizeRawChatMessageRows([dbRow()], PID, NOW);
    expect(Object.keys(rows[0]).sort()).toEqual([...RAW_CHAT_MESSAGE_COLUMNS].sort());
  });

  it('пять местных столбцов наружу не едут', () => {
    for (const c of LOCAL_ONLY) {
      expect(RAW_CHAT_MESSAGE_COLUMNS as readonly string[]).not.toContain(c);
    }
  });

  it('разбор не протаскивает местный столбец, даже если он есть в файле', () => {
    const { rows } = sanitizeRawChatMessageRows(
      [dbRow({ reactions: '{"👍":["x"]}', starred: 1, transport: 'ipfs' })],
      PID,
      NOW
    );
    expect(Object.keys(rows[0])).not.toContain('reactions');
    expect(Object.keys(rows[0])).not.toContain('starred');
    expect(Object.keys(rows[0])).not.toContain('transport');
  });
});

describe('обмен между устройствами сходится', () => {
  it('с перечислением столбцов после первой передачи никто больше не отправляет', () => {
    expect(cycle(exportProjected, 20)).toBe(0);
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: со строкой целиком круг не кончается', () => {
    // По две отправки за проход — и так до бесконечности.
    expect(cycle(exportStar, 20)).toBe(40);
  });
});

describe('local.ts', () => {
  it('выгрузка перечисляет столбцы, а не берёт строку целиком', () => {
    const body = bodyOf(LOCAL(), 'export async function exportRawChatMessageRows(');
    expect(body).toContain('RAW_CHAT_MESSAGE_COLUMNS.join');
    expect(body).not.toContain('SELECT * FROM chat_messages');
    expect(body).toContain('FROM chat_messages');
    expect(body).toContain('WHERE owner_profile_id = ?');
  });

  it('запись перечисляет ровно те же столбцы', () => {
    const body = bodyOf(LOCAL(), 'export async function importRawChatMessageRows(');
    const list = body.match(/INSERT INTO chat_messages \(([^)]+)\)/);
    expect(list).not.toBeNull();
    const cols = (list as RegExpMatchArray)[1].split(',').map((c) => c.trim());
    expect(cols.sort()).toEqual([...RAW_CHAT_MESSAGE_COLUMNS].sort());
  });

  it('местные столбцы записью не трогаются', () => {
    const body = bodyOf(LOCAL(), 'export async function importRawChatMessageRows(');
    const set = body.slice(body.indexOf('DO UPDATE SET'));
    for (const c of LOCAL_ONLY) {
      expect(set).not.toContain(`${c} = excluded.${c}`);
    }
  });

  it('список берётся из общего места, а не переписан рядом', () => {
    expect(LOCAL()).toContain(
      "import { RAW_CHAT_MESSAGE_COLUMNS, sanitizeRawChatMessageRows } from './chatMessageBackup';"
    );
  });
});
