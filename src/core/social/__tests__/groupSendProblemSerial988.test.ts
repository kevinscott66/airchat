/**
 * Отметки «не дошло» пишутся по очереди — v4.32.988.
 *
 * Дефект. Карта отметок читается перед КАЖДОЙ записью и пишется целиком (иначе
 * свежая отметка стёрла бы все прежние: v4.32.951 научило чтение отличать
 * «пусто» от «не прочиталось»). Между чтением и записью стоит await, а
 * пишущих много и друг о друге они не знают: `announceGroupSend` ставит
 * отметку через `void` на каждое разосланное сообщение.
 *
 * Цена. Момент, ради которого вся запись и заведена, — это как раз момент
 * пачки: связь пропала, и подряд не уходит десяток сообщений, ответы рассылки
 * приходят почти одновременно. Второй пишущий читал карту до того, как первый
 * её записал, и ложился поверх — оставалась одна отметка из нескольких.
 * Остальные сообщения снова выглядели отправленными: галочка под сообщением и
 * «Отправлено» в окне сведений, при том что не ушли они никому. Повтора у
 * групповых сообщений нет, так что заметить это человеку неоткуда.
 *
 * Правка. Дорожка одна на модуль (как у закреплений, v4.32.675): следующая
 * запись начинается после того, как предыдущая закончилась. Стирание идёт по
 * той же дорожке — карта у них общая.
 *
 * Границы. Очередь не превращает отказ в успех: «не прочитали» и «не легло»
 * по-прежнему отвечают `false`, и карта остаётся нетронутой.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Хранилище: ключ → шифртекст (здесь — просто строка). */
const mockKv = new Map<string, string>();
/** Отвечает ли чтение. `null` — «не знаем». */
let mockReadable = true;
/** Ложится ли запись. */
let mockWritable = true;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetSecretFor: async (pid: number, key: string) => {
    // Такт между чтением и записью: без него перемешаться нечему.
    await new Promise((r) => setTimeout(r, 0));
    if (!mockReadable) return null;
    return { value: mockKv.get(`p${pid}:${key}`) ?? null };
  },
  scopedKvSetSecretCheckedFor: async (pid: number, key: string, value: string) => {
    await new Promise((r) => setTimeout(r, 0));
    if (!mockWritable) return false;
    mockKv.set(`p${pid}:${key}`, value);
    return true;
  },
}));

jest.mock('../../storage/local', () => ({
  notifyChatStorageChanged: jest.fn(),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import {
  loadGroupSendProblemsFor,
  recordGroupSendProblemFor,
  forgetGroupSendProblemsFor,
} from '../groupSendProblemStore';

const PID = 7;
const DENIED = { kind: 'denied', code: 'not_member' } as const;
const LOST = { kind: 'undelivered', reason: 'all_failed' } as const;

const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Какие id помнит карта. */
async function ids(): Promise<string[]> {
  const map = await loadGroupSendProblemsFor(PID);
  return Object.keys(map ?? {}).sort();
}

beforeEach(() => {
  mockKv.clear();
  mockReadable = true;
  mockWritable = true;
});

describe('пачка отказов не теряется', () => {
  it('две отметки, начатые разом, обе доходят', async () => {
    const both = await Promise.all([
      recordGroupSendProblemFor(PID, 'm1', LOST),
      recordGroupSendProblemFor(PID, 'm2', LOST),
    ]);
    expect(both).toEqual([true, true]);
    expect(await ids()).toEqual(['m1', 'm2']);
  });

  it('десяток сообщений подряд без сети — карта помнит все', async () => {
    const batch = Array.from({ length: 10 }, (_, i) => `m${i}`);
    await Promise.all(batch.map((id) => recordGroupSendProblemFor(PID, id, LOST)));
    expect(await ids()).toEqual(batch.sort());
  });

  it('разные виды беды в одной пачке не вытесняют друг друга', async () => {
    await Promise.all([
      recordGroupSendProblemFor(PID, 'm1', DENIED),
      recordGroupSendProblemFor(PID, 'm2', { kind: 'partial', sent: 2, members: 5 }),
      recordGroupSendProblemFor(PID, 'm3', LOST),
    ]);
    const map = await loadGroupSendProblemsFor(PID);
    expect(map?.m1.problem.kind).toBe('denied');
    expect(map?.m2.problem.kind).toBe('partial');
    expect(map?.m3.problem.kind).toBe('undelivered');
  });

  it('стирание в тот же миг уносит только своё', async () => {
    await recordGroupSendProblemFor(PID, 'old', LOST);
    await Promise.all([
      forgetGroupSendProblemsFor(PID, ['old']),
      recordGroupSendProblemFor(PID, 'new', LOST),
    ]);
    expect(await ids()).toEqual(['new']);
  });
});

describe('ГРАНИЦА: очередь не выдаёт отказ за успех', () => {
  it('карта не прочиталась — ни одна из пачки не легла', async () => {
    mockReadable = false;
    const both = await Promise.all([
      recordGroupSendProblemFor(PID, 'm1', LOST),
      recordGroupSendProblemFor(PID, 'm2', LOST),
    ]);
    expect(both).toEqual([false, false]);
    expect(mockKv.size).toBe(0);
  });

  it('запись не легла — так и сказано', async () => {
    mockWritable = false;
    expect(await recordGroupSendProblemFor(PID, 'm1', LOST)).toBe(false);
    expect(mockKv.size).toBe(0);
  });

  it('карта не прочиталась — стирать тоже нечего и не пишем', async () => {
    await recordGroupSendProblemFor(PID, 'm1', LOST);
    const before = mockKv.get(`p${PID}:groups:send_problems`);
    mockReadable = false;
    await forgetGroupSendProblemsFor(PID, ['m1']);
    mockReadable = true;
    expect(mockKv.get(`p${PID}:groups:send_problems`)).toBe(before);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: одиночная отметка как была', () => {
  it('поставили — читается обратно', async () => {
    expect(await recordGroupSendProblemFor(PID, 'm1', DENIED)).toBe(true);
    const map = await loadGroupSendProblemsFor(PID);
    expect(map?.m1.problem).toEqual(DENIED);
  });

  it('стирать нечего — в хранилище не ходят вовсе', async () => {
    await forgetGroupSendProblemsFor(PID, []);
    expect(mockKv.size).toBe(0);
  });

  it('карта — профиля: соседний профиль своих отметок не видит', async () => {
    await recordGroupSendProblemFor(PID, 'm1', LOST);
    expect(await loadGroupSendProblemsFor(8)).toEqual({});
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('карта по-прежнему читается целиком и пишется целиком', () => {
    // Стала бы запись точечной — очередь была бы не нужна.
    const s = src('groupSendProblemStore.ts');
    expect(s).toContain('const stored = await loadGroupSendProblemsFor(pid);');
    expect(s).toContain('JSON.stringify(merged)');
    expect(s).toContain('JSON.stringify(out)');
  });

  it('пишущих и правда несколько, и каждый — огонь-и-забыли', () => {
    const a = readFileSync(join(__dirname, '..', '..', '..', 'ui', 'groupSendAnnounce.ts'), 'utf8');
    expect(a.split('void recordGroupSendProblemFor(').length - 1).toBe(2);
  });

  it('и повтора у групповых сообщений по-прежнему нет — промах не поправить', () => {
    const o = src('groupSendOutcome.ts');
    expect(o).toContain('Единственное верное действие — сказать человеку.');
  });
});
