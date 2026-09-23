/**
 * Unit tests for saveConfigOverride — runtime persistence of user config edits.
 *
 * The app config is bundled + an optional Documents/airchat-config.json override,
 * deep-merged and cached. The VPN settings UI needs to WRITE edits back at
 * runtime. The load-bearing requirements:
 *  - the new patch is MERGED into the existing override file, never clobbering
 *    unrelated overrides the user already has (a naive overwrite loses settings),
 *  - successive saves accumulate (deep merge within the same section),
 *  - the in-memory cache is refreshed so getConfigSync() reflects the edit
 *    immediately, without an app restart,
 *  - defaults fill any unset fields (no undefined into the VPN controller).
 *
 * expo-file-system is an in-memory fake; no real disk touched.
 */
jest.mock('expo-file-system/legacy', () => {
  const files: Record<string, string> = {};
  return {
    __files: files,
    documentDirectory: '/doc/',
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in files, size: mockFakeSize ?? (files[uri] ?? '').length })),
    readAsStringAsync: jest.fn(async (uri: string) => {
      if (mockReadThrows) throw new Error('EBUSY');
      return files[uri] ?? '';
    }),
    writeAsStringAsync: jest.fn(async (uri: string, data: string) => {
      // v4.32.729: обрыв записи изображается как на устройстве — файл уже
      // открыт на усечение, часть байт легла, дальше отказ.
      if (mockWriteFailsAfterBytes != null) {
        files[uri] = data.slice(0, mockWriteFailsAfterBytes);
        throw new Error('ENOSPC');
      }
      files[uri] = data;
    }),
    deleteAsync: jest.fn(async (uri: string) => { delete files[uri]; }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      if (!(from in files)) throw new Error('ENOENT');
      files[to] = files[from];
      delete files[from];
    }),
  };
});
/** Чтение файла отказывает: база занята, файл недоступен. */
let mockReadThrows = false;
/** Подменённый размер файла: так проверяется потолок в 256 КБ. */
let mockFakeSize: number | null = null;
/** Сколько байт успевает лечь до отказа записи; null — запись проходит целиком. */
let mockWriteFailsAfterBytes: number | null = null;
jest.mock('../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
// config.ts transitively imports resolveLoopback → react-native. This suite is a
// pure config/merge test, so stub the loopback rewrite to an identity function;
// it keeps the suite runnable without the react-native (jest-expo) transform.
jest.mock('../transport/ipfs/resolveLoopback', () => ({
  resolveIpfsLoopbackForAndroid: (u: string) => u,
}));

import { saveConfigOverride, getConfigSync } from '../config';

const fsMock = jest.requireMock('expo-file-system/legacy') as { __files: Record<string, string> };
const OVERRIDE_URI = '/doc/airchat-config.json';
const readOverride = () => JSON.parse(fsMock.__files[OVERRIDE_URI]) as Record<string, unknown>;

beforeEach(() => {
  for (const k of Object.keys(fsMock.__files)) delete fsMock.__files[k];
  mockReadThrows = false;
  mockFakeSize = null;
  mockWriteFailsAfterBytes = null;
});

describe('saveConfigOverride', () => {
  it('writes the patch to the override file and applies it to the effective config', async () => {
    const cfg = await saveConfigOverride({
      vpn: { enabled: true, address: 'vps.example.com', uuid: 'uuid-1' } as never,
    });
    expect(cfg.vpn?.enabled).toBe(true);
    expect(cfg.vpn?.address).toBe('vps.example.com');
    expect(cfg.vpn?.uuid).toBe('uuid-1');
    // defaults fill unset VPN fields (controller must not see undefined)
    expect(cfg.vpn?.localSocksPort).toBe(10809);
    expect(cfg.vpn?.flow).toBe('xtls-rprx-vision');
    // file actually persisted
    expect((readOverride().vpn as Record<string, unknown>).address).toBe('vps.example.com');
  });

  it('does NOT clobber an unrelated pre-existing override', async () => {
    fsMock.__files[OVERRIDE_URI] = JSON.stringify({ whitelist: { enabled: true } });
    await saveConfigOverride({ vpn: { address: 'x' } as never });
    const ov = readOverride();
    expect((ov.whitelist as Record<string, unknown>).enabled).toBe(true); // preserved
    expect((ov.vpn as Record<string, unknown>).address).toBe('x');        // added
  });

  it('accumulates successive saves within the same section (deep merge)', async () => {
    await saveConfigOverride({ vpn: { address: 'a' } as never });
    await saveConfigOverride({ vpn: { uuid: 'u', publicKey: 'pk' } as never });
    const vpn = readOverride().vpn as Record<string, unknown>;
    expect(vpn.address).toBe('a'); // first edit survived
    expect(vpn.uuid).toBe('u');
    expect(vpn.publicKey).toBe('pk');
  });

  it('refreshes the in-memory cache so getConfigSync sees the edit without restart', async () => {
    await saveConfigOverride({ vpn: { address: 'fresh.example.com', enabled: true } as never });
    expect(getConfigSync().vpn?.address).toBe('fresh.example.com');
    expect(getConfigSync().vpn?.enabled).toBe(true);
  });
});

/**
 * v4.32.729: сохранение одной настройки больше не стирает остальные.
 *
 * `saveConfigOverride` сливает патч с тем, что вернуло чтение файла, и кладёт
 * результат на место файла. Чтение же любую беду сводило к `{}`: база занята,
 * обрывок после прерванной записи, подложенный файл сверх потолка. То есть
 * сбой чтения превращал сохранение ОДНОЙ настройки в стирание ВСЕХ остальных —
 * адрес своего ретранслятора, настройки VPN и туннеля исчезали молча, а
 * устройство возвращалось на общий ntfy.sh.
 *
 * Плюс сама запись шла прямо поверх: обрыв оставлял обрывок JSON, который
 * следующий запуск читает как «переопределений нет».
 */
describe('чужие переопределения переживают беду (v4.32.729)', () => {
  const EXISTING = JSON.stringify({
    internet: { relayBase: 'https://свой.ретранслятор' },
    vpn: { address: 'vps.example.com' },
  });

  it('файл не прочитался — сохранение отказывается, а не затирает', async () => {
    fsMock.__files[OVERRIDE_URI] = EXISTING;
    mockReadThrows = true;
    await expect(saveConfigOverride({ openflux: { enabled: true } as never })).rejects.toThrow(
      /прежние настройки целы/
    );
    // Ровно то, ради чего правка: чужие настройки на месте.
    expect(fsMock.__files[OVERRIDE_URI]).toBe(EXISTING);
  });

  it('файл сверх потолка — тоже «не прочитали», а не «пусто»', async () => {
    fsMock.__files[OVERRIDE_URI] = EXISTING;
    mockFakeSize = 512 * 1024;
    await expect(saveConfigOverride({ openflux: { enabled: true } as never })).rejects.toThrow();
    expect(fsMock.__files[OVERRIDE_URI]).toBe(EXISTING);
  });

  it('на месте файла не объект — сохранять поверх нечего и опасно', async () => {
    fsMock.__files[OVERRIDE_URI] = '[1,2,3]';
    await expect(saveConfigOverride({ vpn: { address: 'x' } as never })).rejects.toThrow();
    expect(fsMock.__files[OVERRIDE_URI]).toBe('[1,2,3]');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: прочитанный файл по-прежнему сливается, а не отвергается', async () => {
    fsMock.__files[OVERRIDE_URI] = EXISTING;
    const cfg = await saveConfigOverride({ vpn: { uuid: 'u-1' } as never });
    const ov = readOverride();
    expect((ov.internet as Record<string, unknown>).relayBase).toBe('https://свой.ретранслятор');
    expect((ov.vpn as Record<string, unknown>).address).toBe('vps.example.com');
    expect((ov.vpn as Record<string, unknown>).uuid).toBe('u-1');
    expect(cfg.vpn?.uuid).toBe('u-1');
  });

  it('файла нет — это «переопределять нечего», и запись идёт', async () => {
    const cfg = await saveConfigOverride({ vpn: { address: 'a' } as never });
    expect(cfg.vpn?.address).toBe('a');
    expect(Object.keys(fsMock.__files)).toEqual([OVERRIDE_URI]);
  });

  it('обрыв записи не оставляет ни обрывка, ни потери прежнего файла', async () => {
    fsMock.__files[OVERRIDE_URI] = EXISTING;
    mockWriteFailsAfterBytes = 10;
    await expect(saveConfigOverride({ vpn: { uuid: 'u-1' } as never })).rejects.toThrow('ENOSPC');
    expect(fsMock.__files[OVERRIDE_URI]).toBe(EXISTING);
    expect(Object.keys(fsMock.__files)).toEqual([OVERRIDE_URI]);
  });
});
