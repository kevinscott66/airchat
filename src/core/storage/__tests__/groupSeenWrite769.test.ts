/**
 * Занятая база больше не съедает галочку «прочитано» навсегда (v4.32.769).
 *
 * `markGroupMessageSeen` отвечала `void`, а свой отказ гасила сама: занятая
 * база, не поднявшаяся блокировка, не открывшийся ключ данных, нечитаемый
 * столбец `seen_by` — наружу во всех случаях уходило ровно то же, что и после
 * удачной записи, то есть ничего.
 *
 * Приёмник квитанции ветку отсрочки имел (v4.32.748) и объяснял её в
 * комментарии — но зажигалась она исключением, а эта функция его не бросает.
 * Ветка была мёртвой: отказ объявлялся разобранным, метка «докуда прочитано» у
 * ретранслятора уходила вперёд, а повтора у квитанции нет — следующая
 * расскажет уже про следующее сообщение. Галочка у отправителя не появлялась
 * никогда.
 *
 * Второй дефект в том же месте: нечитаемый столбец списка прочитавших
 * возвращался как «писать нечего» — вровень с «читатель уже в списке». Ключ
 * данных мог просто ещё не подняться; со второй попыткой он открывается.
 *
 * Здесь проверяются все четыре исхода записи и то, что откладывается ровно
 * один из них.
 */
type Run = { changes: number; lastInsertRowId: number };

/** Столбец списка прочитавших: id сообщения → что лежит в базе. */
let mockSeen = new Map<string, string | null>();
/** Отказывает ли база на любом обращении — как при `database is locked`. */
let mockDbFails = false;
/** Что в столбце не открывается нашим ключом. */
let mockUnreadable = new Set<string>();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => {
      if (mockDbFails) throw new Error('database is locked');
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []): Promise<Run> => {
      if (mockDbFails) throw new Error('database is locked');
      if (sql.includes('SET seen_by =')) {
        mockSeen.set(String(params[1] ?? ''), (params[0] ?? null) as string | null);
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (mockDbFails) throw new Error('database is locked');
      const id = String(params[0] ?? '');
      if (sql.includes('SELECT seen_by FROM')) {
        return mockSeen.has(id) ? { seen_by: mockSeen.get(id) ?? null } : null;
      }
      return null;
    }),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
  // Третье состояние столбца — непустой шифртекст, не открывшийся ключом.
  readAtRestCell: jest.fn((stored: string | null) => {
    if (stored === null || stored === undefined) return { state: 'absent' };
    if (mockUnreadable.has(stored)) return { state: 'unreadable' };
    return { state: 'plain', text: stored };
  }),
}));

import * as fs from 'fs';
import * as path from 'path';

import { markGroupMessageSeen, markGroupMessageSeenChecked } from '../local';

const MSG = 'msg-1';
const GROUP = 'grp-1';
const PID = 1;

/** Кто записан в списке прочитавших сейчас. */
function seenOf(): string[] {
  const raw = mockSeen.get(MSG);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const read = (...p: string[]): string =>
  codeOnly(fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8'));

beforeEach(() => {
  mockSeen = new Map([[MSG, JSON.stringify([])]]);
  mockUnreadable = new Set();
  mockDbFails = false;
});

describe('четыре исхода вместо молчания', () => {
  it('обычная отметка — «записано»', async () => {
    await expect(markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice')).resolves.toBe('recorded');
    expect(seenOf()).toEqual(['alice']);
  });

  it('база занята — «не вышло», и кадр можно перезапросить', async () => {
    mockDbFails = true;
    await expect(markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice')).resolves.toBe('failed');
  });

  it('столбец не открылся — тоже «не вышло», а не «писать нечего»', async () => {
    // Ключ данных мог ещё не подняться. Со следующей попыткой он откроется, и
    // читатель допишется; прежде этот случай был неотличим от «уже в списке».
    mockSeen.set(MSG, 'enc2:непонятное');
    mockUnreadable.add('enc2:непонятное');
    await expect(markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice')).resolves.toBe('failed');
    // И поверх нечитаемого шифртекста ничего не записано.
    expect(mockSeen.get(MSG)).toBe('enc2:непонятное');
  });

  it('читатель уже в списке — «писать нечего»', async () => {
    mockSeen.set(MSG, JSON.stringify(['alice']));
    await expect(markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice')).resolves.toBe('noop');
  });

  it('строки сообщения нет — «писать нечего»: повтор её не заведёт', async () => {
    await expect(markGroupMessageSeenChecked('нет-такого', GROUP, PID, 'alice')).resolves.toBe(
      'noop'
    );
  });

  it('список упёрся в тысячу — «писать нечего»', async () => {
    // Предел стоит против накрутки просмотров с подложных ключей (v4.32.201).
    mockSeen.set(MSG, JSON.stringify(Array.from({ length: 1000 }, (_, i) => `v${i}`)));
    await expect(markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice')).resolves.toBe('noop');
    expect(seenOf()).toHaveLength(1000);
  });

  it('четыре исхода и вправду различимы', async () => {
    const outcomes: string[] = [];
    outcomes.push(await markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice'));
    outcomes.push(await markGroupMessageSeenChecked(MSG, GROUP, PID, 'alice'));
    outcomes.push(await markGroupMessageSeenChecked('нет-такого', GROUP, PID, 'bob'));
    mockDbFails = true;
    outcomes.push(await markGroupMessageSeenChecked(MSG, GROUP, PID, 'bob'));
    expect(outcomes).toEqual(['recorded', 'noop', 'noop', 'failed']);
  });
});

describe('сплющивающая форма осталась — и осталась обёрткой', () => {
  it('прежнее имя пишет ровно то же и по-прежнему ничего не отвечает', async () => {
    await expect(markGroupMessageSeen(MSG, GROUP, PID, 'alice')).resolves.toBeUndefined();
    expect(seenOf()).toEqual(['alice']);
  });

  it('и отказ по-прежнему не бросает наружу', async () => {
    mockDbFails = true;
    await expect(markGroupMessageSeen(MSG, GROUP, PID, 'alice')).resolves.toBeUndefined();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('различающая форма отвечает словом, а прежняя — ровно обёртка', () => {
    const local = read('storage', 'local.ts');
    expect(local).toContain('export type GroupSeenWrite =');
    expect(local).toContain(
      'await markGroupMessageSeenChecked(msgId, groupId, ownerProfileId, viewerPubB64);'
    );
    // Своей записи у обёртки быть не должно: две копии разъедутся.
    const a = local.indexOf('export async function markGroupMessageSeen(');
    const b = local.indexOf('export async function markGroupMessageSeenChecked(');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(local.slice(a, b)).not.toContain('beginImmediate(');
  });

  it('нечитаемый столбец — отказ, а не «писать нечего»', () => {
    const local = read('storage', 'local.ts');
    const at = local.indexOf('async function recordGroupSeenInTx(');
    expect(at).toBeGreaterThan(0);
    const body = local.slice(at, local.indexOf('\n}', at));
    expect(body).toContain('): Promise<GroupSeenWrite> {');
    const guard = body.indexOf('if (!mayOverwrite(seenCell)) {');
    expect(guard).toBeGreaterThan(0);
    expect(body.slice(guard, guard + 220)).toContain("return 'failed';");
    // И ни одного прежнего булева ответа в теле не осталось.
    expect(body).not.toContain('return false;');
    expect(body).not.toContain('return true;');
  });

  it('приёмник квитанции откладывает ровно отказ', () => {
    const grp = read('social', 'groupMessaging.ts');
    expect(grp).toContain('const seen = await markGroupMessageSeenChecked(');
    expect(grp).toContain("if (seen === 'failed') {");
    // Прежняя ветка ждала исключения, которого эта запись не бросает.
    expect(grp).not.toContain('await markGroupMessageSeen(env.lastSeenMsgId');
    const at = grp.indexOf("if (seen === 'failed') {");
    expect(grp.slice(at, at + 200)).toContain("return 'deferred';");
  });
});
