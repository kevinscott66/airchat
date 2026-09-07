/**
 * Сдвиг водяного знака отчитывается о себе (v4.32.655).
 *
 * Раньше commitTs писал через scopedKvSetFor внутри try/catch. Эта форма
 * отдаёт void и гасит отказ базы внутри себя, так что catch не срабатывал ни
 * разу: строки control_ts_write_failed в журнале не было никогда, а
 * acceptControlTs отвечал «принято» и на конверт, знак которого не лёг.
 *
 * Само поведение при отказе остаётся прежним — пропустить, а не отвергнуть
 * (см. заголовок controlWatermark.ts): приложение без доступа к базе не должно
 * переставать применять настройки собеседника. Меняется только то, что причина
 * теперь названа.
 */
const mockKv = new Map<string, string>();
let mockWriteFails = false;
const mockWarns: Array<{ msg: string; data: unknown }> = [];

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetFor: async (pid: number, k: string) => ({ value: mockKv.get(`p${pid}:${k}`) ?? null }),
  scopedKvSetCheckedFor: async (pid: number, k: string, v: string) => {
    if (mockWriteFails) return false;
    mockKv.set(`p${pid}:${k}`, v);
    return true;
  },
}));
jest.mock('../../logger', () => ({
  log: {
    warn: (msg: string, data: unknown) => {
      mockWarns.push({ msg, data });
    },
    info: () => {},
    debug: () => {},
    error: () => {},
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  acceptControlTs,
  commitControlTs,
  commitGroupControlTs,
  commitGroupMessageTs,
  controlTsFresh,
  groupMessageTsFresh,
} from '../controlWatermark';

const PEER = 'сосед-открытый-ключ==';
const PID = 1;

beforeEach(() => {
  mockKv.clear();
  mockWriteFails = false;
  mockWarns.length = 0;
});

const failures = (): number => mockWarns.filter((w) => w.msg === 'control_ts_write_failed').length;

describe('не легший сдвиг знака назван в журнале', () => {
  it('удавшийся сдвиг молчит и метку ставит', async () => {
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(failures()).toBe(0);
    expect(mockKv.size).toBe(1);
  });

  it('отказ базы называется, а не гасится', async () => {
    mockWriteFails = true;
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(failures()).toBe(1);
    expect(mockWarns.at(-1)).toEqual({ msg: 'control_ts_write_failed', data: { kind: 'copyguard' } });
    expect(mockKv.size).toBe(0);
  });

  it('вид состояния в строке журнала различается', async () => {
    mockWriteFails = true;
    await commitControlTs('disappear', PEER, PID, 2000);
    await commitGroupControlTs('meta:name', 'g-1', PID, 2000);
    await commitGroupMessageTs('msg-1', PID, 2000);
    expect(mockWarns.map((w) => (w.data as { kind: string }).kind)).toEqual([
      'disappear',
      'grp:meta',
      'grp:msg',
    ]);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: без отказа те же три сдвига журнал не трогают', async () => {
    await commitControlTs('disappear', PEER, PID, 2000);
    await commitGroupControlTs('meta:name', 'g-1', PID, 2000);
    await commitGroupMessageTs('msg-1', PID, 2000);
    expect(failures()).toBe(0);
    expect(mockKv.size).toBe(3);
  });
});

describe('приём остаётся мягким — меняется только видимость причины', () => {
  it('конверт применяется, даже когда знак не лёг', async () => {
    mockWriteFails = true;
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(true);
    expect(failures()).toBe(1);
    // Знака нет, значит тот же конверт пройдёт снова: окно для повтора дешевле,
    // чем переставшие применяться настройки собеседника.
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(true);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: как только запись легла, повтор отвергается', async () => {
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(true);
    expect(failures()).toBe(0);
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(false);
  });

  it('пара «проверить → сдвинуть» ведёт себя так же', async () => {
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    mockWriteFails = true;
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    mockWriteFails = false;
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(false);
  });

  it('слоты сообщений группы живут по тому же правилу', async () => {
    expect(await groupMessageTsFresh('msg-1', PID, 2000)).toBe(true);
    await commitGroupMessageTs('msg-1', PID, 2000);
    expect(await groupMessageTsFresh('msg-1', PID, 2000)).toBe(false);
    expect(await groupMessageTsFresh('msg-2', PID, 2000)).toBe(true);
  });
});

describe('в исходнике не осталось слепой формы записи', () => {
  const SRC = readFileSync(join(__dirname, '..', 'controlWatermark.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('пишет только проверенная форма', () => {
    expect(CODE).toContain('scopedKvSetCheckedFor');
    expect(CODE).not.toContain('scopedKvSetFor');
    // Повод для правки жив: единственный писатель по-прежнему один на весь файл.
    expect(CODE.split('scopedKvSetCheckedFor(').length - 1).toBe(1);
  });

  it('отказ записи назван словом, а не поглощён', () => {
    expect(CODE).toContain("log.warn('control_ts_write_failed', { kind });");
    // Проверка не пустая: сама строка про отказ в файле есть ровно одна.
    expect(CODE.split("'control_ts_write_failed'").length - 1).toBe(1);
  });
});
