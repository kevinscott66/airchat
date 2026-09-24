/**
 * Водяной знак больше не сдаётся вместе с базой (v4.32.791).
 *
 * Дефект. Знак сторожит необратимое: состав группы, роли, баны, снятие пометки
 * об исключении, «открепить всё» в личке. А сам он терялся дважды. Сдвиг
 * (`commitTs`) о неудавшейся записи только писал в журнал — вызывающий об этом
 * не узнавал, и знак оставался там, где стоял до операции. Чтение же, не сумев
 * прочитать, отвечало «свежо» на что угодно.
 *
 * Цена. Темы relay выводятся из открытых DID, писать в них может любой, а кадр
 * живёт тридцать суток. Перехваченный кадр «назначить администратором»,
 * присланный заново в минуту, когда база занята, проходил проверку свежести
 * честно: по записанному он и правда новее. Права проверяются по ТЕКУЩЕМУ
 * составу, а подписавший оригинал администратором как был, так и остался, —
 * значит `canModerate` не мешает. Тем же приёмом снимался бан, возвращался
 * исключённый и откатывались настройки переписки. Заминка базы длится секунды,
 * но выбирает их не приложение, а тот, кто шлёт повтор.
 *
 * Правка. Зеркало в памяти процесса: наибольшая отметка, которую этот запуск
 * успел ПРИМЕНИТЬ, независимо от того, легла она на диск или нет. Ставится оно
 * до записи — именно на не легший сдвиг и рассчитан повтор. Читающая сторона
 * судит по зеркалу наравне с диском, а само чтение получило повтор по занятой
 * секунде (те же паузы, что у прочих чтений, — `readRetry`). Родня — пометки
 * выхода и исключения (v4.32.787, `markFallback`); отдельная карта здесь
 * потому, что нужна не «не легло», а «наибольшее из применённого».
 *
 * Мягкость осталась ровно там, где сказать нечего: пустое зеркало и нечитаемая
 * база разом — то есть перезапуск и заминка в одну секунду. Такой пропуск
 * теперь назван в журнале (`control_ts_unknown_pass`).
 */
const mockKv = new Map<string, string>();
let mockWriteFails = false;
/** Ключи (уже с префиксом профиля), чтение которых отвечает «не смогли». */
const mockReadFail = new Set<string>();
/** Сколько раз спрашивали каждый ключ — по этому видно повтор чтения. */
const mockReads = new Map<string, number>();
const mockWarns: string[] = [];

jest.mock('../../storage/profileScopedKv', () => ({
  // null — «не смогли прочитать», { value: null } — «ничего не было». Правка
  // опирается ровно на эту разницу, поэтому мок её и держит.
  scopedKvTryGetFor: async (pid: number, k: string) => {
    const full = `p${pid}:${k}`;
    mockReads.set(full, (mockReads.get(full) ?? 0) + 1);
    if (mockReadFail.has(full)) return null;
    return { value: mockKv.get(full) ?? null };
  },
  scopedKvSetCheckedFor: async (pid: number, k: string, v: string) => {
    if (mockWriteFails) return false;
    mockKv.set(`p${pid}:${k}`, v);
    return true;
  },
}));
jest.mock('../../logger', () => ({
  log: {
    warn: (msg: string) => {
      mockWarns.push(msg);
    },
    info: () => {},
    debug: () => {},
    error: () => {},
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONTROL_TS_MAX_SKEW_MS,
  commitControlTs,
  commitGroupControlTs,
  commitGroupMessageTs,
  controlTsFresh,
  controlTsMirrorSize,
  groupControlTsFresh,
  groupMessageTsFresh,
  resetControlTsMirrorForTests,
  watermarkKey,
} from '../controlWatermark';
import { READ_RETRY_ATTEMPTS } from '../../storage/readRetry';

const PEER = 'сосед-открытый-ключ==';
const GID = 'группа-1';
const PID = 7;
const NOW = Date.now();

/**
 * Уборка зеркала, переживающая его отсутствие.
 *
 * Зеркало живёт на уровне модуля, и без уборки применённое одной проверкой
 * судило бы конверты следующей. Но на коде ДО правки этого вывода нет вовсе, а
 * набор обязан и там загружаться и идти до конца — иначе блоки «ПРОВЕРКА НЕ
 * ПУСТАЯ» и «ПОВОД ДЛЯ ПРАВКИ ЖИВ» ничего бы не доказывали: они и должны
 * проходить на старом коде.
 */
const resetMirror = (): void => {
  const fn = resetControlTsMirrorForTests as unknown as (() => void) | undefined;
  if (typeof fn === 'function') fn();
};

beforeEach(() => {
  resetMirror();
  mockKv.clear();
  mockReadFail.clear();
  mockReads.clear();
  mockWriteFails = false;
  mockWarns.length = 0;
});

/** Полное имя ключа в моке базы — с префиксом профиля. */
const full = (key: string): string => `p${PID}:${key}`;

describe('не легшая запись больше не открывает дорогу повтору', () => {
  it('роль в группе: повтор отбит, хотя на диске знака нет', async () => {
    const slot = `m:${PEER}` as const;
    mockWriteFails = true;
    expect(await groupControlTsFresh(slot, GID, PID, NOW - 10_000)).toBe(true);
    await commitGroupControlTs(slot, GID, PID, NOW - 10_000);
    expect(mockKv.size).toBe(0);
    expect(mockWarns).toContain('control_ts_write_failed');
    // Вот он, перехваченный кадр, присланный второй раз.
    expect(await groupControlTsFresh(slot, GID, PID, NOW - 10_000)).toBe(false);
    expect(mockWarns).toContain('control_ts_replay_rejected');
  });

  it('и откат к более ранней метке — тоже', async () => {
    mockWriteFails = true;
    await commitControlTs('disappear', PEER, PID, NOW - 10_000);
    expect(await controlTsFresh('disappear', PEER, PID, NOW - 60_000)).toBe(false);
  });

  it('честный более поздний кадр проходит и при наглухо мёртвой базе', async () => {
    // Зеркало хранит максимум применённого, а не запрет: собеседник, который
    // продолжает слать новые метки, не теряет ничего.
    mockWriteFails = true;
    expect(await controlTsFresh('copyguard', PEER, PID, NOW - 30_000)).toBe(true);
    await commitControlTs('copyguard', PEER, PID, NOW - 30_000);
    expect(await controlTsFresh('copyguard', PEER, PID, NOW - 20_000)).toBe(true);
    await commitControlTs('copyguard', PEER, PID, NOW - 20_000);
    expect(await controlTsFresh('copyguard', PEER, PID, NOW - 25_000)).toBe(false);
  });

  it('зеркало только растёт: поздний сдвиг не сбивается ранним', async () => {
    mockWriteFails = true;
    await commitControlTs('presence', PEER, PID, NOW - 10_000);
    await commitControlTs('presence', PEER, PID, NOW - 90_000);
    expect(await controlTsFresh('presence', PEER, PID, NOW - 50_000)).toBe(false);
  });
});

describe('нечитаемая база больше не отвечает «свежо» на что угодно', () => {
  it('слот, о котором этот запуск уже знает, судится по памяти', async () => {
    await commitGroupMessageTs('m1', PID, NOW - 10_000);
    mockReadFail.add(full(`ctl_ts_v1:grp:msg:m1`));
    expect(await groupMessageTsFresh('m1', PID, NOW - 60_000)).toBe(false);
    expect(await groupMessageTsFresh('m1', PID, NOW - 1_000)).toBe(true);
  });

  it('слот, о котором ничего не применяли, пропускает — и это названо', async () => {
    mockReadFail.add(full(watermarkKey('copyguard', PEER)));
    expect(await controlTsFresh('copyguard', PEER, PID, NOW - 60_000)).toBe(true);
    expect(mockWarns).toContain('control_ts_read_failed');
    expect(mockWarns).toContain('control_ts_unknown_pass');
  });

  it('прочитанное с диска судит наравне с памятью: прошлый запуск не забыт', async () => {
    // Зеркало пусто (перезапуск), но строка в базе есть — прежнее правило.
    mockKv.set(full(watermarkKey('disappear', PEER)), String(NOW - 5_000));
    expect(await controlTsFresh('disappear', PEER, PID, NOW - 60_000)).toBe(false);
    expect(await controlTsFresh('disappear', PEER, PID, NOW - 1_000)).toBe(true);
  });

  it('чтение повторяется по занятой секунде, а не сдаётся с первого раза', async () => {
    const key = full(watermarkKey('presence', PEER));
    mockReadFail.add(key);
    await controlTsFresh('presence', PEER, PID, NOW - 1_000);
    expect(mockReads.get(key)).toBe(READ_RETRY_ATTEMPTS + 1);
  });

  it('удавшееся чтение повтора не заказывает', async () => {
    const key = full(watermarkKey('presence', PEER));
    await controlTsFresh('presence', PEER, PID, NOW - 1_000);
    expect(mockReads.get(key)).toBe(1);
  });
});

describe('зеркало не путает ячейки и не растёт без края', () => {
  it('слоты разных участников и разных групп не пересекаются', async () => {
    const other = 'другой-ключ==';
    await commitGroupControlTs(`m:${PEER}`, GID, PID, NOW - 10_000);
    expect(await groupControlTsFresh(`m:${other}`, GID, PID, NOW - 60_000)).toBe(true);
    expect(await groupControlTsFresh(`m:${PEER}`, 'другая-группа', PID, NOW - 60_000)).toBe(true);
  });

  it('профили не делят одну память', async () => {
    await commitControlTs('copyguard', PEER, PID, NOW - 10_000);
    expect(await controlTsFresh('copyguard', PEER, PID + 1, NOW - 60_000)).toBe(true);
  });

  it('потолок держится, и вытесняется самая давняя запись', async () => {
    mockWriteFails = true;
    for (let i = 0; i < 4200; i++) {
      await commitGroupMessageTs(`m${i}`, PID, NOW - 10_000);
    }
    expect(controlTsMirrorSize()).toBe(4096);
    // Первые слоты вытеснены — для них всё ровно так, как было до правки.
    mockReadFail.add(full('ctl_ts_v1:grp:msg:m0'));
    expect(await groupMessageTsFresh('m0', PID, NOW - 60_000)).toBe(true);
    // Последние на месте.
    mockReadFail.add(full('ctl_ts_v1:grp:msg:m4199'));
    expect(await groupMessageTsFresh('m4199', PID, NOW - 60_000)).toBe(false);
  });

  it('повторный сдвиг того же слота не съедает лишнюю ячейку', async () => {
    await commitControlTs('copyguard', PEER, PID, NOW - 10_000);
    await commitControlTs('copyguard', PEER, PID, NOW - 5_000);
    expect(controlTsMirrorSize()).toBe(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние правила знака целы', () => {
  it('испорченная метка отвергается до всякой базы', async () => {
    expect(await controlTsFresh('copyguard', PEER, PID, 0)).toBe(false);
    expect(await controlTsFresh('copyguard', PEER, PID, Number.NaN)).toBe(false);
    expect(mockReads.size).toBe(0);
  });

  it('метка из будущего дальше допуска на часы отвергается', async () => {
    expect(await controlTsFresh('copyguard', PEER, PID, NOW + CONTROL_TS_MAX_SKEW_MS + 60_000)).toBe(
      false,
    );
    expect(await controlTsFresh('copyguard', PEER, PID, NOW + 1_000)).toBe(true);
  });

  it('удавшийся сдвиг по-прежнему пишется на диск', async () => {
    await commitControlTs('copyguard', PEER, PID, NOW - 10_000);
    expect(mockKv.get(full(watermarkKey('copyguard', PEER)))).toBe(String(NOW - 10_000));
    expect(mockWarns).not.toContain('control_ts_write_failed');
  });

  it('дробная метка на диске и в памяти округляется одинаково', async () => {
    await commitControlTs('copyguard', PEER, PID, NOW - 10_000.7);
    expect(mockKv.get(full(watermarkKey('copyguard', PEER)))).toBe(String(NOW - 10_001));
    expect(await controlTsFresh('copyguard', PEER, PID, NOW - 10_001)).toBe(false);
  });
});

/** Код модуля без комментариев: пояснение не должно подменять проверку. */
const code = (): string =>
  readFileSync(join(__dirname, '..', 'controlWatermark.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('порядок в самом сдвиге', () => {
  it('зеркало ставится ДО записи, а не после неё', () => {
    // Иначе не легший сдвиг снова стал бы дорогой для повтора.
    const CODE = code();
    const remember = CODE.indexOf('mirrorRemember(pid, key, at);');
    const write = CODE.indexOf('scopedKvSetCheckedFor(pid, key, String(at))');
    expect(remember).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(remember);
  });

  it('отказ записи ничего не отменяет — снятия зеркала в файле нет', () => {
    const CODE = code();
    expect(CODE).not.toContain('mirror.delete(mirrorId(pid, key))');
    expect(CODE.split('mirror.clear();').length - 1).toBe(1);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сдвиг по-прежнему ничего не возвращает — узнать об отказе снаружи нельзя', () => {
    // Вот почему память об отказе пришлось поселить внутри самого модуля:
    // одиннадцать пар «проверить → сдвинуть» разбросаны по шести файлам, и ни
    // одна не получает от сдвига ни слова.
    const CODE = code();
    expect(CODE).toContain(
      'async function commitTs(key: string, kind: string, pid: number, ts: number): Promise<void> {',
    );
    expect(CODE).toContain("log.warn('control_ts_write_failed', { kind });");
  });

  it('этой дорогой ходят состав и роли группы, а не одни настройки', () => {
    const GRP = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
    expect(GRP).toContain('groupControlTsFresh(');
    expect(GRP).toContain('commitGroupControlTs(');
  });

  it('конверт живёт достаточно долго, чтобы повтор был не теорией', () => {
    // Окно приёма равно сроку хранения на relay: месяц, в течение которого
    // перехваченный кадр остаётся подписанным и валидным.
    const MSG = readFileSync(join(__dirname, '..', 'messaging.ts'), 'utf8');
    expect(MSG).toContain('const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;');
    const WIN = readFileSync(
      join(__dirname, '..', '..', 'transport', 'retentionWindow.ts'),
      'utf8',
    );
    expect(WIN).toContain('export const RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;');
  });
});
