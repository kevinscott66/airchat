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
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri in files })),
    readAsStringAsync: jest.fn(async (uri: string) => files[uri] ?? ''),
    writeAsStringAsync: jest.fn(async (uri: string, data: string) => { files[uri] = data; }),
  };
});
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
