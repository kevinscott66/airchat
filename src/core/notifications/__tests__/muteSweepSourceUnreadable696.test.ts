/**
 * Уборка «без звука» больше не выдумывает бессрочное глушение (v4.32.696).
 *
 * v4.32.628 закрыл здесь половину вопроса: чтение записи под КАНОНИЧЕСКИМ
 * именем стало тройственным, потому что отказ базы был неотличим от «записи
 * нет» и уборка ставила старое значение поверх нового. Вторая половина
 * осталась слепой — чтение самой переносимой записи.
 *
 * Ключ приходит из scopedKvListKeysByPrefix, то есть он существует; null от
 * `scopedKvGet` означает здесь только отказ базы. Но parseMuteValue(null)
 * отвечает `{ muted: false, untilMs: null }`, и уборка на этом основании
 * принимала решение за человека: запись не истёкшая и неканоническая, значит
 * переносим — а переносится она значением `'1'`, то есть как БЕССРОЧНОЕ
 * глушение. Срок терялся, источник стирался, вернуться было некуда.
 *
 * Проверка поведением: муте-модуль живой, отказ подделан на уровне базы.
 */
const mockKv = new Map<string, string>();
/** Ключи, чтение которых обязано сорваться (kvTryGet отдаёт null). */
const mockReadFail = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockReadFail.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => { mockKv.set(k, v); },
  kvSetChecked: async (k: string, v: string) => { mockKv.set(k, v); return true; },
  kvDelete: async (k: string) => { mockKv.delete(k); },
  kvDeleteChecked: async (k: string) => { mockKv.delete(k); },
  kvListKeysByPrefix: async (p: string) => [...mockKv.keys()].filter((k) => k.startsWith(p)),
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMuted, sweepExpiredMutes } from '../muteStore';
import { canonicalMuteId } from '../muteChatId';

const SRC = readFileSync(join(__dirname, '..', 'muteStore.ts'), 'utf8');

/** Тело уборки: в listMuted чтение осталось прежним намеренно — там ничего не стирается. */
function sweepBody(): string {
  const from = SRC.indexOf('export async function sweepExpiredMutes(');
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

/** Открытый ключ собеседника — под таким именем запись делали прежние сборки. */
const PEER = 'W'.repeat(43);
const DID = canonicalMuteId('chat', PEER);
const LEGACY = `p1:mute:chat:${PEER}`;
const CANON = `p1:mute:chat:${DID}`;

beforeEach(() => {
  mockKv.clear();
  mockReadFail.clear();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: уборка вообще работает', () => {
  it('читаемая старая запись переезжает под каноническое имя', async () => {
    const until = Date.now() + 60 * 60 * 1000;
    mockKv.set(LEGACY, `until:${until}`);
    const res = await sweepExpiredMutes();
    expect(res.migrated).toBe(1);
    expect(mockKv.get(CANON)).toBe(`until:${until}`);
    expect(mockKv.has(LEGACY)).toBe(false);
    await expect(isMuted('chat', PEER)).resolves.toBe(true);
  });

  it('истёкшая запись убирается', async () => {
    mockKv.set(CANON, `until:${Date.now() - 1000}`);
    const res = await sweepExpiredMutes();
    expect(res.removed).toBe(1);
    expect(mockKv.has(CANON)).toBe(false);
  });
});

describe('нечитаемая запись остаётся нетронутой', () => {
  it('уборка не создаёт канонической записи и не стирает источник', async () => {
    const until = Date.now() + 60 * 60 * 1000;
    mockKv.set(LEGACY, `until:${until}`);
    mockReadFail.add(LEGACY);

    const res = await sweepExpiredMutes();

    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: источник цел, нового имени не появилось.
    expect(mockKv.get(LEGACY)).toBe(`until:${until}`);
    expect(mockKv.has(CANON)).toBe(false);
    expect(res).toEqual({ removed: 0, migrated: 0 });
  });

  it('срок глушения не превращается в бессрочный', async () => {
    const until = Date.now() + 60 * 60 * 1000;
    mockKv.set(LEGACY, `until:${until}`);
    mockReadFail.add(LEGACY);
    await sweepExpiredMutes();

    // База ответила на следующем заходе — переезд проходит с настоящим сроком.
    mockReadFail.clear();
    await sweepExpiredMutes();
    expect(mockKv.get(CANON)).toBe(`until:${until}`);
    expect(mockKv.get(CANON)).not.toBe('1');
  });

  it('нечитаемая запись не удаляется как истёкшая', async () => {
    mockKv.set(CANON, `until:${Date.now() + 1000}`);
    mockReadFail.add(CANON);
    const res = await sweepExpiredMutes();
    expect(mockKv.has(CANON)).toBe(true);
    expect(res.removed).toBe(0);
  });
});

describe('исходник: уборка спрашивает базу тремя состояниями', () => {
  it('чтение переносимой записи тройственное и отказ пропускается', () => {
    const body = sweepBody();
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain('const read = await scopedKvTryGet(k);');
    expect(body).toContain('if (read === null) continue;');
    expect(body).toContain('const parsed = parseMuteValue(read.value, now);');
    expect(body).not.toContain('parseMuteValue(await scopedKvGet(k), now)');
  });

  it('проверка v4.32.628 на канонической записи осталась на месте', () => {
    const body = sweepBody();
    expect(body).toContain('const existing = await scopedKvTryGet(target);');
    expect(body).toContain('if (existing === null) continue;');
    expect(body).toContain('if (!(await scopedKvSetChecked(target, value))) continue;');
  });
});
