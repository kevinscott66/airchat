/**
 * Сохранение настройки больше не может потерять файл целиком (v4.32.967).
 *
 * Дефект. Запись шла через временный файл — и это правильно, — но порядок был
 * такой: написать временный, УДАЛИТЬ прежний, перенести временный на его
 * место. Между второй и третьей строкой на диске не оставалось ни одной копии
 * настроек. А `catch` вокруг всего этого удалял временный файл — то есть в
 * случае отказа переноса стирал последнюю копию слитого своими руками.
 *
 * Цена. В этом файле живут адрес своего ретранслятора, настройки VPN и
 * туннеля. Терялись они молча: чтение при старте считает отсутствие файла за
 * «переопределений нет» — и это верно, пока файл теряться не может. Устройство
 * возвращалось на публичный ntfy.sh, а функция в этот момент обещала прямо
 * обратное: «прежние целы, и попытку можно повторить».
 *
 * Правка. Прежний файл не удаляется, а отодвигается под имя `.prev`, и только
 * после удачного переноса нового убирается. Отказ возвращает прежний на место.
 * Питание и убитый процесс никакого `catch` не ждут — поэтому отодвинутую
 * копию поднимает ещё и ближайшее чтение, оба: и то, что при старте, и то, что
 * перед следующим сохранением.
 *
 * Границы. Файловая система здесь поддельная, в памяти; проверяется порядок
 * действий, а не поведение песочницы iOS.
 */
jest.mock('expo-file-system/legacy', () => {
  const files: Record<string, string> = {};
  return {
    __files: files,
    documentDirectory: '/doc/',
    getInfoAsync: jest.fn(async (uri: string) => ({
      exists: uri in files,
      size: (files[uri] ?? '').length,
    })),
    readAsStringAsync: jest.fn(async (uri: string) => files[uri] ?? ''),
    writeAsStringAsync: jest.fn(async (uri: string, data: string) => {
      mockWrites += 1;
      if (mockWriteFails) throw new Error('ENOSPC');
      files[uri] = data;
    }),
    deleteAsync: jest.fn(async (uri: string) => { delete files[uri]; }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      // Отказ переноса — это ровно то окно, ради которого правка: место
      // кончилось, песочница ответила отказом, файл под замком.
      if (mockMoveFails) throw new Error('EXDEV');
      if (!(from in files)) throw new Error('ENOENT');
      files[to] = files[from];
      delete files[from];
    }),
  };
});
/** Перенос файла отказывает. */
let mockMoveFails = false;
/** Запись временного файла отказывает. */
let mockWriteFails = false;
/** Сколько раз писали файл — чтобы отличить отказ записи от отказа переноса. */
let mockWrites = 0;

jest.mock('../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../transport/ipfs/resolveLoopback', () => ({
  resolveIpfsLoopbackForAndroid: (u: string) => u,
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { saveConfigOverride } from '../config';

const fsMock = jest.requireMock('expo-file-system/legacy') as { __files: Record<string, string> };
const URI = '/doc/airchat-config.json';
const PREV = `${URI}.prev`;
const readOverride = (): Record<string, unknown> =>
  JSON.parse(fsMock.__files[URI]) as Record<string, unknown>;

/** Настройки, которые человек уже завёл и терять не согласен. */
const EXISTING = JSON.stringify({
  internet: { relayBase: 'https://свой.ретранслятор' },
  vpn: { address: 'vps.example.com' },
});

/** Только код: пояснения закрепку удовлетворять не должны. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = codeOnly(readFileSync(join(__dirname, '..', 'config.ts'), 'utf8'));

beforeEach(() => {
  for (const k of Object.keys(fsMock.__files)) delete fsMock.__files[k];
  mockMoveFails = false;
  mockWriteFails = false;
  mockWrites = 0;
});

describe('перенос отказал — настройки остаются на диске', () => {
  it('прежний файл на месте и не тронут', async () => {
    fsMock.__files[URI] = EXISTING;
    mockMoveFails = true;
    await expect(saveConfigOverride({ vpn: { uuid: 'u-1' } as never })).rejects.toThrow();
    // До правки здесь не было ничего: прежний удалён, временный убран `catch`.
    expect(fsMock.__files[URI]).toBe(EXISTING);
  });

  it('следующее сохранение сливается с ними, а не пишет один патч', async () => {
    fsMock.__files[URI] = EXISTING;
    mockMoveFails = true;
    await expect(saveConfigOverride({ vpn: { uuid: 'u-1' } as never })).rejects.toThrow();

    mockMoveFails = false;
    await saveConfigOverride({ vpn: { uuid: 'u-2' } as never });
    const ov = readOverride();
    expect((ov.internet as Record<string, unknown>).relayBase).toBe('https://свой.ретранслятор');
    expect((ov.vpn as Record<string, unknown>).address).toBe('vps.example.com');
    expect((ov.vpn as Record<string, unknown>).uuid).toBe('u-2');
  });

  it('процесс убит между переносами — копию поднимает следующее чтение', async () => {
    // Такое состояние на диске `catch` уже не исправит: его никто не звал.
    fsMock.__files[PREV] = EXISTING;
    await saveConfigOverride({ vpn: { uuid: 'u-3' } as never });
    const ov = readOverride();
    expect((ov.internet as Record<string, unknown>).relayBase).toBe('https://свой.ретранслятор');
    expect((ov.vpn as Record<string, unknown>).uuid).toBe('u-3');
    // И отодвинутая копия убрана: второй раз поднимать нечего.
    expect(Object.keys(fsMock.__files)).toEqual([URI]);
  });

  it('поднятые настройки возвращаются и вызывающему', async () => {
    fsMock.__files[PREV] = EXISTING;
    const cfg = await saveConfigOverride({ vpn: { uuid: 'u-4' } as never });
    expect(cfg.vpn?.address).toBe('vps.example.com');
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отодвинутая копия не должна ни оставаться мусором после удачи, ни подменять
 * собой отказ. Всё, что работало до правки, обязано работать и после: иначе
 * лекарство дороже болезни.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: обычный ход не изменился', () => {
  it('удачное сохранение не оставляет ни временного, ни отодвинутого', async () => {
    fsMock.__files[URI] = EXISTING;
    await saveConfigOverride({ vpn: { uuid: 'u-5' } as never });
    expect(Object.keys(fsMock.__files)).toEqual([URI]);
    expect((readOverride().vpn as Record<string, unknown>).uuid).toBe('u-5');
  });

  it('первое в жизни сохранение проходит и мусора не оставляет', async () => {
    const cfg = await saveConfigOverride({ vpn: { address: 'a' } as never });
    expect(cfg.vpn?.address).toBe('a');
    expect(Object.keys(fsMock.__files)).toEqual([URI]);
  });

  it('обрыв записи временного прежний файл не трогает', async () => {
    fsMock.__files[URI] = EXISTING;
    mockWriteFails = true;
    await expect(saveConfigOverride({ vpn: { uuid: 'u-6' } as never })).rejects.toThrow('ENOSPC');
    expect(fsMock.__files[URI]).toBe(EXISTING);
    expect(Object.keys(fsMock.__files)).toEqual([URI]);
  });

  it('ГРАНИЦА: на месте файла не объект — сохранять поверх нечего', async () => {
    fsMock.__files[URI] = '[1,2,3]';
    await expect(saveConfigOverride({ vpn: { address: 'x' } as never })).rejects.toThrow();
    expect(fsMock.__files[URI]).toBe('[1,2,3]');
  });

  it('ГРАНИЦА: отказ переноса без прежнего файла — просто отказ, мусора нет', async () => {
    mockMoveFails = true;
    await expect(saveConfigOverride({ vpn: { address: 'x' } as never })).rejects.toThrow();
    expect(Object.keys(fsMock.__files)).toEqual([]);
  });
});

/**
 * ПОВОД ДЛЯ ПРАВКИ ЖИВ.
 *
 * Потерю этого файла никто не замечает: отсутствие файла — законное состояние,
 * и читатель обязан считать его за «переопределений нет». Поэтому цена ошибки
 * здесь не «сообщение об ошибке», а тихий возврат устройства на общий ntfy.sh.
 */
describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: пропажу файла никто не заметит', () => {
  it('отсутствие файла — не беда, а обычное дело', async () => {
    await expect(saveConfigOverride({ vpn: { address: 'a' } as never })).resolves.toBeDefined();
  });

  it('отказ случается именно на переносе, а не на записи', async () => {
    fsMock.__files[URI] = EXISTING;
    mockMoveFails = true;
    await expect(saveConfigOverride({ vpn: { uuid: 'u-7' } as never })).rejects.toThrow('EXDEV');
    // Временный файл успел лечь целиком — значит окно между копиями настоящее.
    expect(mockWrites).toBe(1);
  });
});

describe('форма исходников: прежний файл отодвигается, а не удаляется', () => {
  it('у отодвинутой копии есть постоянное имя и подъёмник', () => {
    expect(SRC).toContain('function documentConfigOverridePreviousUri(): string {');
    expect(SRC).toContain('async function restoreStrandedOverride(): Promise<boolean> {');
  });

  it('запись не удаляет файл, на место которого пишет', () => {
    const at = SRC.indexOf('export async function saveConfigOverride(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at);
    expect(body).not.toContain('await FileSystem.deleteAsync(uri, { idempotent: true });');
    expect(body).toContain('await FileSystem.moveAsync({ from: uri, to: previous });');
    expect(body).toContain("await FileSystem.moveAsync({ from: previous, to: uri }).catch(() => {});");
  });

  it('оба читателя поднимают отодвинутую копию', () => {
    const user = SRC.slice(
      SRC.indexOf('async function readUserOverride('),
      SRC.indexOf('async function readUserOverride(') + 400
    );
    expect(user).toContain('await restoreStrandedOverride();');
    const writer = SRC.slice(
      SRC.indexOf('async function readConfigOverride('),
      SRC.indexOf('async function readConfigOverride(') + 400
    );
    expect(writer).toContain('if (!(await restoreStrandedOverride())) return null;');
  });
});
