/**
 * «Без звука» действует и при закрытом приложении (v4.32.502).
 *
 * Обработчик push, поднимающийся на каждое входящее сообщение, про настройку
 * «без звука» не знал вовсе: он спрашивал только общий переключатель и «Не
 * беспокоить». Заглушённый собеседник молчал, пока приложение открыто, и
 * будил телефон ночью, когда закрыто, — то есть настройка не работала ровно в
 * том случае, ради которого её и включают.
 *
 * Второе следствие того же места: баннер о личном сообщении показывают два
 * независимых пути, а от двойного показа защищала только память процесса,
 * которой у фонового контекста нет. Одно сообщение давало два уведомления
 * подряд — безличное и именное. Развести их удалось не третьей договорённостью
 * через хранилище, а общим именем баннера: второй показ заменяет первый.
 */
import * as fs from 'fs';
import * as path from 'path';

import { bannerIdForCid } from '../bannerId';
import { muteKey } from '../../core/notifications/muteValue';
import { profileScopedKey } from '../../core/storage/kvKeys';

// Таблица kv, которую видит фоновый контекст. Значения — ровно те строки, что
// пишет muteStore: kvSet кладёт их в базу открытым текстом.
let mockKv: Record<string, string> = {};
let mockOpenFails = false;
const mockWrites: string[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    if (mockOpenFails) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    return {
      getFirstAsync: jest.fn(async (_sql: string, params: string[]) => {
        const v = mockKv[params[0]];
        return v === undefined ? null : { v };
      }),
      getAllAsync: jest.fn(async (sql: string, params?: string[]) => {
        const keys = params ?? [];
        if (!/WHERE k IN/.test(sql)) return [];
        return keys.filter((k) => mockKv[k] !== undefined).map((k) => ({ k, v: mockKv[k] }));
      }),
      runAsync: jest.fn(async (sql: string) => {
        mockWrites.push(sql);
        return { changes: 0, lastInsertRowId: 0 };
      }),
      execAsync: jest.fn(async (sql: string) => {
        mockWrites.push(sql);
      }),
      closeAsync: jest.fn(async () => undefined),
    };
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isBackgroundMuted } = require('../backgroundNotifyPrefs') as typeof import('../backgroundNotifyPrefs');

const DID = 'did:key:z6MkabcDEF123';
const NOW = 1_700_000_000_000;
const MIRROR = 'active_profile_id';

beforeEach(() => {
  mockKv = {};
  mockOpenFails = false;
  mockWrites.length = 0;
});

describe('фоновый обработчик и «без звука»', () => {
  it('записи нет — баннер показываем', async () => {
    mockKv[MIRROR] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('бессрочная запись активного профиля — молчим', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
  });

  it('второй аккаунт заглушил — первому это не указ', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(2, muteKey('chat', DID))] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('активен второй аккаунт — читаем его запись, а не первого', async () => {
    mockKv[MIRROR] = '2';
    mockKv[profileScopedKey(2, muteKey('chat', DID))] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = 'until:1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
  });

  it('старая запись без префикса принадлежит первому профилю', async () => {
    mockKv[MIRROR] = '1';
    mockKv[muteKey('chat', DID)] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
  });

  it('старая запись без префикса не наследуется вторым профилем', async () => {
    mockKv[MIRROR] = '2';
    mockKv[muteKey('chat', DID)] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('своя запись профиля перебивает старую общую', async () => {
    mockKv[MIRROR] = '1';
    mockKv[muteKey('chat', DID)] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = `until:${NOW - 1}`;
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('отсрочка ещё не истекла — молчим', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = `until:${NOW + 60_000}`;
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
  });

  it('отсрочка истекла — показываем', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = `until:${NOW - 1}`;
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('порченое значение читается как «показать», а не как «молчать»', async () => {
    mockKv[MIRROR] = '1';
    for (const bad of ['', 'true', 'until:', 'until:abc', 'until:-5', `until:${NOW + 400 * 24 * 3600_000}`]) {
      mockKv[profileScopedKey(1, muteKey('chat', DID))] = bad;
      await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
    }
  });

  it('зеркала профиля нет — считаем первым, и его запись действует', async () => {
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = '1';
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
  });

  it('мусор в зеркале профиля не уводит чтение в чужой namespace', async () => {
    for (const bad of ['', 'abc', '0', '-3', '1.5', 'p2']) {
      mockKv = { [MIRROR]: bad, [profileScopedKey(1, muteKey('chat', DID))]: '1' };
      await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(true);
    }
  });

  it('база недоступна из фона — показываем, а не молчим', async () => {
    mockOpenFails = true;
    await expect(isBackgroundMuted(DID, NOW)).resolves.toBe(false);
  });

  it('отправитель неизвестен — не молчим и в базу не ходим', async () => {
    mockKv[MIRROR] = '1';
    await expect(isBackgroundMuted(undefined, NOW)).resolves.toBe(false);
    await expect(isBackgroundMuted('', NOW)).resolves.toBe(false);
  });

  it('фон ничего не переписывает: истёкшую запись убирает приложение', async () => {
    mockKv[MIRROR] = '1';
    mockKv[profileScopedKey(1, muteKey('chat', DID))] = `until:${NOW - 1}`;
    await isBackgroundMuted(DID, NOW);
    expect(mockWrites).toEqual([]);
    expect(mockKv[profileScopedKey(1, muteKey('chat', DID))]).toBe(`until:${NOW - 1}`);
  });
});

describe('имя баннера', () => {
  it('одно сообщение — одно имя на обоих путях показа', () => {
    const cid = 'a'.repeat(64);
    expect(bannerIdForCid(cid)).toBe(bannerIdForCid(cid));
    expect(bannerIdForCid(cid)).toBe(`dm:${cid}`);
  });

  it('разные сообщения — разные имена, иначе баннеры съедали бы друг друга', () => {
    expect(bannerIdForCid('a'.repeat(64))).not.toBe(bannerIdForCid('b'.repeat(64)));
  });

  it('до фикса имени не было вовсе: два показа — два баннера', () => {
    // Модель прежнего поведения: notifee складывает уведомления без id рядом.
    const shelf = new Map<string, string>();
    const post = (id: string | undefined, title: string) =>
      shelf.set(id ?? `auto:${shelf.size}`, title);
    post(undefined, 'AirChat');
    post(undefined, 'Аня');
    expect(shelf.size).toBe(2);

    shelf.clear();
    const cid = 'c'.repeat(32);
    post(bannerIdForCid(cid), 'AirChat');
    post(bannerIdForCid(cid), 'Аня');
    expect(shelf.size).toBe(1);
    expect([...shelf.values()]).toEqual(['Аня']);
  });
});

describe('форма кода', () => {
  const SRC = path.join(__dirname, '..', '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
  const BG = read('firebaseMessagingBackground.ts');
  const PUSH = read('notifications', 'pushNotifications.ts');
  const PREFS = read('notifications', 'backgroundNotifyPrefs.ts');
  const BANNER = read('notifications', 'bannerId.ts');
  const STORE = read('core', 'notifications', 'muteStore.ts');
  const PM = read('core', 'identity', 'profileManager.ts');

  it('фоновый обработчик спрашивает «без звука» до показа баннера', () => {
    // v4.32.572: та же проверка, но только для личного сообщения — общую
    // группу личное «без звука» не глушит.
    expect(BG).toContain("if (kind === 'dm' && (await isBackgroundMuted(contactDid))) return;");
    expect(BG.indexOf('isBackgroundMuted(contactDid)')).toBeLessThan(BG.indexOf('displayNotification'));
    expect(BG.indexOf('prefs.show')).toBeLessThan(BG.indexOf('isBackgroundMuted(contactDid)'));
  });

  it('оба пути показа зовут одно и то же имя баннера', () => {
    expect(BG).toContain('id: bannerIdForCid(cid),');
    expect(PUSH).toContain('id: bannerIdForCid(cid),');
    expect(PUSH).toContain("import { bannerIdForCid, bannerIdForGroup } from './bannerId';");
  });

  it('имя баннера считается без зависимостей — его берёт фоновый контекст', () => {
    expect(BANNER).not.toMatch(/^import /m);
    expect(BANNER).not.toContain('require(');
  });

  it('разбор значения и формат ключа существуют в одном экземпляре', () => {
    // Своих копий у читателей быть не должно: разъедься они — заглушённый
    // собеседник снова начнёт будить телефон при закрытом приложении.
    for (const src of [STORE, PREFS]) {
      expect(src).not.toContain("startsWith('until:')");
      expect(src).not.toMatch(/`mute:\$\{/);
      expect(src).not.toContain("'mute:'");
    }
    expect(STORE).toContain("from './muteValue'");
    expect(PREFS).toContain("from '../core/notifications/muteValue'");
    expect(PREFS).toContain("from '../core/storage/kvKeys'");
    // Обратный разбор имени тоже один: список «Заглушённые» и уборка читают
    // его тем же кодом, что собирает имя.
    expect(STORE).toContain('parseMuteKey(k)');
    expect(STORE).toContain('muteKeyPrefix(');
  });

  it('фон не чинит чужой слой: удаления в нём нет', () => {
    const body = PREFS.slice(PREFS.indexOf('export async function isBackgroundMuted'));
    expect(body).not.toContain('DELETE');
    expect(body).not.toContain('runAsync');
  });

  it('номер активного профиля зеркалится из единственного места', () => {
    expect(PM).toContain('await this.mirrorActiveProfileId();');
    expect(PM.match(/mirrorActiveProfileId\(\)/g)).toHaveLength(2);
    const mirrorKey = "'active_profile_id'";
    expect(PM).toContain(`const ACTIVE_PROFILE_MIRROR_KEY = ${mirrorKey};`);
    expect(PREFS).toContain(`const ACTIVE_PROFILE_MIRROR_KEY = ${mirrorKey};`);
    // Зеркало пишется на каждой записи состояния — иначе фон читал бы номер,
    // который уже сменился.
    const persist = PM.slice(PM.indexOf('private async persistState'));
    expect(persist.slice(0, persist.indexOf('\n  }'))).toContain('mirrorActiveProfileId');
  });

  it('зеркало не роняет смену профиля, если запись не удалась', () => {
    const body = PM.slice(PM.indexOf('private async mirrorActiveProfileId'));
    expect(body.slice(0, body.indexOf('\n  }\n'))).toContain('} catch {');
  });
});
