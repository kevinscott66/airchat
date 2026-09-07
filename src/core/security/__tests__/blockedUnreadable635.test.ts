/**
 * v4.32.635 — непрочитанный блок-лист не выдаётся за пустой.
 *
 * Дефект. Список хранится шифртекстом (v4.32.306), а читался строкой:
 * `kvGetSecretUpgrading` отвечает `null` и на «записи нет», и на «запись не
 * открылась нашим ключом». `loadBlockedOnce` второе принимал за первое —
 * исключения не возникало, `loadFailed` оставался снятым, и весь заведённый
 * ради таких случаев механизм повтора (`whenReady` / `retryLoad`, v4.32.498)
 * не запускался ни разу. Дальше:
 *
 *   • `isBlocked` навсегда отвечал «не заблокирован» на кого угодно —
 *     заблокированный доходил и до переписки, и до звонка;
 *   • настройки показывали «Нет заблокированных контактов»;
 *   • следующая блокировка выкладывала список из одной записи ПОВЕРХ
 *     нечитаемого шифртекста, и прежние запреты исчезали безвозвратно вместе
 *     с байтами, которые ещё могли открыться верным ключом;
 *   • перенос со старых имён ключа сносил старую запись, приняв её
 *     нечитаемость за отсутствие.
 */

let mockUnreadable: Set<string> = new Set();
let mockUnreadableOnce = false;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const cell = (k: string) => {
    const stored = kv[k];
    if (stored == null) return { state: 'absent' };
    if (mockUnreadable.has(k)) return { state: 'unreadable' };
    return { state: 'plain', text: stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored };
  };
  return {
    __kv: kv,
    __prefix: PREFIX,
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecretCell: jest.fn(async (k: string) => cell(k)),
    kvGetSecretCellUpgrading: jest.fn(async (k: string) => {
      if (mockUnreadableOnce) {
        mockUnreadableOnce = false;
        return { state: 'unreadable' };
      }
      return cell(k);
    }),
    kvSetSecret: jest.fn(async (k: string, v: string) => { kv[k] = PREFIX + v; return true; }),
    notifyChatStorageChanged: jest.fn(),
  };
});

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../crypto/keyManager', () => ({
  publicKeyHash4: () => new Uint8Array([1, 2, 3, 4]),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

import fs from 'fs';
import path from 'path';
import { RateLimiter } from '../rateLimiter';

type MockLocal = { __kv: Record<string, string>; __prefix: string };
const mockLocal = jest.requireMock('../../storage/local') as MockLocal;

const KEY = 'p1:airchat_blocked_peer_pub_b64';
const BASE = 'airchat_blocked_peer_pub_b64';
const PEER = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);

function put(key: string, list: string[]): void {
  mockLocal.__kv[key] = `${mockLocal.__prefix}${JSON.stringify(list)}`;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockUnreadable = new Set();
  mockUnreadableOnce = false;
});

describe('блок-лист, который не открылся', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: читаемый список поднимается как обычно', async () => {
    put(KEY, [PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.blockedListReadable()).toBe(true);
    expect(rl.isBlocked(PEER)).toBe(true);
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([PEER]);
  });

  it('нечитаемый список — это сбой чтения, а не пустой список', async () => {
    put(KEY, [PEER]);
    mockUnreadable.add(KEY);
    const rl = new RateLimiter();
    await rl.whenReady();
    // Ответить верно уже нечем, но соврать про «прочитано» нельзя: на этом
    // признаке держится и повтор, и честный экран настроек.
    expect(rl.blockedListReadable()).toBe(false);
  });

  it('поверх нечитаемого списка новая блокировка не ложится', async () => {
    put(KEY, [PEER]);
    mockUnreadable.add(KEY);
    const rl = new RateLimiter();
    await rl.whenReady();
    await expect(rl.blockContact(OTHER)).resolves.toBe(false);
    // Прежний шифртекст цел: он ещё может открыться верным ключом.
    expect(mockLocal.__kv[KEY]).toContain(PEER);
    expect(mockLocal.__kv[KEY]).not.toContain(OTHER);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: на читаемом списке блокировка ложится', async () => {
    put(KEY, [PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    await expect(rl.blockContact(OTHER)).resolves.toBe(true);
    expect(mockLocal.__kv[KEY]).toContain(OTHER);
  });

  it('снятие блокировки поверх нечитаемого списка тоже отказывает', async () => {
    put(KEY, [PEER, OTHER]);
    mockUnreadable.add(KEY);
    const rl = new RateLimiter();
    await rl.whenReady();
    await expect(rl.unblockContact(PEER)).resolves.toBe(false);
    expect(mockLocal.__kv[KEY]).toContain(PEER);
  });

  it('нечитаемая старая запись — тоже сбой чтения, а не пустой список', async () => {
    // Своего ключа нет — начинается перенос со старого имени. Старая запись
    // не открывается; принять её за отсутствующую значит снять все запреты и
    // отдать уборке единственный экземпляр списка.
    put(BASE, [PEER]);
    mockUnreadable.add(BASE);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.blockedListReadable()).toBe(false);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: читаемая старая запись переносится', async () => {
    put(BASE, [PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.blockedListReadable()).toBe(true);
    expect(rl.isBlocked(PEER)).toBe(true);
    expect(mockLocal.__kv[KEY]).toContain(PEER);
  });

  it('настройки дожидаются повтора, а не показывают пустоту', async () => {
    put(KEY, [PEER]);
    mockUnreadableOnce = true;
    const rl = new RateLimiter();
    // Первое чтение сорвалось; getBlockedPubKeys обязан пройти через
    // whenReady, иначе отдаст пустой список от резолвнувшегося `ready`.
    await expect(rl.getBlockedPubKeys()).resolves.toEqual([PEER]);
  });
});

describe('экран «Заблокированные» различает пустоту и сбой', () => {
  const ui = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'components', 'BlockedContactsList.tsx'),
    'utf8'
  );

  it('ПРОВЕРКА НЕ ПУСТАЯ: пустой список у экрана по-прежнему свой', () => {
    expect(ui).toContain('blocked_list_empty');
  });

  it('несостоявшееся чтение показано отдельно', () => {
    expect(ui).toContain('rateLimiter.blockedListReadable()');
    expect(ui).toContain('blocked_list_unreadable');
  });
});

describe('дошифровывающее чтение отличает сбой базы от пустоты', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
  const at = src.indexOf('export async function kvGetSecretCellUpgrading(');
  const body = src.slice(at, src.indexOf('\n}\n', at));

  it('ПРОВЕРКА НЕ ПУСТАЯ: срез найден и это та самая функция', () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toContain('AT_REST_PREFIX');
  });

  it('читает kvTryGet, а не kvGet: сбой базы — не «записи нет»', () => {
    expect(body).toContain('await kvTryGet(key)');
    expect(body).toContain("return { state: 'unreadable' };");
    // Свой же комментарий выше упоминает kvGet — сравниваем без комментариев.
    expect(body.replace(/^\s*\/\/.*$/gm, '')).not.toContain('await kvGet(');
  });
});
