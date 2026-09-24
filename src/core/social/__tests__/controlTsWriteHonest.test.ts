/**
 * Сдвиг водяного знака отчитывается о себе (v4.32.655).
 *
 * Раньше commitTs писал через scopedKvSetFor внутри try/catch. Эта форма
 * отдаёт void и гасит отказ базы внутри себя, так что catch не срабатывал ни
 * разу: строки control_ts_write_failed в журнале не было никогда, а
 * acceptControlTs отвечал «принято» и на конверт, знак которого не лёг.
 *
 * Поведение при отказе с v4.32.791 другое, и два случая ниже переписаны.
 * Прежде «знак не лёг» означало «пропустить»: тот же кадр, присланный второй
 * раз, применялся снова. Довод был — приложение без доступа к базе не должно
 * переставать применять настройки собеседника. Но по этой же дороге ходят
 * права в группе, баны и снятие исключения, и повтор перехваченного кадра
 * возвращал отнятое. Теперь применённое помнит зеркало в памяти процесса, и
 * оно ставится ДО записи: отказ базы больше не открывает дорогу повтору.
 *
 * Мягкость никуда не делась, но сузилась до «перезапуск и нечитаемая база в
 * одну секунду» — там зеркало пусто, сказать нечего, и кадр проходит с записью
 * control_ts_unknown_pass в журнале. Честный более поздний кадр проходит
 * всегда: отвергается только тот, чья метка не новее применённой.
 */
const mockKv = new Map<string, string>();
let mockWriteFails = false;
let mockReadFails = false;
const mockWarns: Array<{ msg: string; data: unknown }> = [];

jest.mock('../../storage/profileScopedKv', () => ({
  // null — это «не смогли прочитать», а не «ничего не было»: profileScopedKv
  // различает эти два случая, и правка v4.32.791 опирается ровно на разницу.
  scopedKvTryGetFor: async (pid: number, k: string) =>
    mockReadFails ? null : { value: mockKv.get(`p${pid}:${k}`) ?? null },
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
import { resetControlTsMirrorForTests } from '../controlWatermark';
import {
  watermarkKey,
  commitControlTs,
  commitGroupControlTs,
  commitGroupMessageTs,
  controlTsFresh,
  groupMessageTsFresh,
  type ControlKind,
} from '../controlWatermark';

/**
 * Прежняя слитная форма «проверить и сразу сдвинуть». С v4.32.778 её в
 * приложении нет — осталась только здесь, чтобы проверять сами правила отметки
 * (монотонность, окно будущего, раздельность ячеек) в одну строку. В приёмниках
 * такая форма запрещена: см. комментарий у `controlTsFresh`.
 */
async function acceptControlTs(
  kind: ControlKind,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<boolean> {
  if (!(await controlTsFresh(kind, peerPubB64, pid, ts))) return false;
  await commitControlTs(kind, peerPubB64, pid, ts);
  return true;
}

const PEER = 'сосед-открытый-ключ==';
const PID = 1;

beforeEach(() => {
  // v4.32.791: зеркало знака живёт на уровне модуля — убираем его, иначе
  // применённое соседней проверкой судило бы конверты этой.
  resetControlTsMirrorForTests();
  mockKv.clear();
  mockWriteFails = false;
  mockReadFails = false;
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
  it('конверт применяется, когда знак не лёг, — но второй раз уже нет', async () => {
    mockWriteFails = true;
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(true);
    expect(failures()).toBe(1);
    // Строки в базе нет, но зеркало помнит применённое: повтор того же кадра
    // отбивается (v4.32.791). Прежде он проходил — и вместе с настройками
    // копирования той же дорогой возвращались отнятые права и снятые баны.
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(false);
  });

  it('отказ записи не запирает поток: честный более поздний кадр проходит', async () => {
    // Оборотная сторона зеркала. Оно хранит МАКСИМУМ применённого, а не запрет:
    // собеседник, продолжающий слать новые метки, ничего не теряет даже при
    // наглухо недоступной базе.
    mockWriteFails = true;
    expect(await acceptControlTs('copyguard', PEER, PID, 2000)).toBe(true);
    expect(await acceptControlTs('copyguard', PEER, PID, 2001)).toBe(true);
    expect(await acceptControlTs('copyguard', PEER, PID, 3000)).toBe(true);
    expect(await acceptControlTs('copyguard', PEER, PID, 3000)).toBe(false);
  });

  it('после перезапуска с нечитаемой базой кадр проходит — и это названо', async () => {
    // Остаток мягкости: зеркало пусто, база молчит, судить не по чему. Раньше
    // такое молчание ничем не отличалось от «знак прочитан, кадр новый».
    resetControlTsMirrorForTests();
    mockKv.clear();
    mockReadFails = true;
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    expect(mockWarns.some((w) => w.msg === 'control_ts_unknown_pass')).toBe(true);
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
    // Сдвиг не лёг в базу, но был произнесён — и этого довольно (v4.32.791).
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(false);
    mockWriteFails = false;
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(false);
  });

  it('зеркало не подменяет базу: прочитанное из базы старше — судит база', async () => {
    // Слот мог быть сдвинут прошлым запуском приложения. Зеркало пусто, метка
    // из базы читается и работает как прежде.
    mockKv.set(`p${PID}:${watermarkKey('copyguard', PEER)}`, '5000');
    expect(await controlTsFresh('copyguard', PEER, PID, 4000)).toBe(false);
    expect(await controlTsFresh('copyguard', PEER, PID, 6000)).toBe(true);
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
