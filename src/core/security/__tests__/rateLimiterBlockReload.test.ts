/**
 * v4.32.498 — сорвавшееся чтение блок-листа повторяется.
 *
 * Раньше сбой чтения только писался в журнал: `whenReady` всё равно
 * резолвился, список в памяти оставался пустым, и `isBlocked` навсегда
 * отвечал «не заблокирован». Одной неудачи (база занята, ключ шифрования
 * ещё не поднят при переключении профиля) хватало, чтобы заблокированный
 * контакт снова дошёл до переписки и звонков — без единого признака для
 * человека.
 *
 * Здесь проверяется, что после неудачи список поднимается сам, что повтор
 * один на всех обратившихся сразу и что успешное чтение повторов не плодит.
 */

let mockReads = 0;
let mockFailUntil = 0;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const kvSetSecret = jest.fn(async (k: string, v: string) => { kv[k] = PREFIX + v; return true; });
  const kvGetSecret = jest.fn(async (k: string) => {
    const stored = kv[k];
    if (stored == null) return null;
    return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
  });
  return {
    __kv: kv,
    __prefix: PREFIX,
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret,
    kvSetSecret,
    kvGetSecretUpgrading: jest.fn(async (k: string) => {
      mockReads += 1;
      if (mockReads <= mockFailUntil) throw new Error('database is locked');
      const stored = kv[k];
      if (stored == null) return null;
      return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
    }),
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
const PEER = 'A'.repeat(43);

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockLocal.__kv[KEY] = `${mockLocal.__prefix}${JSON.stringify([PEER])}`;
  mockReads = 0;
  mockFailUntil = 0;
});

describe('чтение блок-листа сорвалось', () => {
  it('ожидающий получает уже перечитанный список', async () => {
    mockFailUntil = 1;
    const rl = new RateLimiter();
    await rl.whenReady();
    // Первое чтение упало, повтор ушёл прямо из whenReady — и дождался.
    expect(mockReads).toBe(2);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('успешное чтение повторов не плодит', async () => {
    const rl = new RateLimiter();
    await rl.whenReady();
    await rl.whenReady();
    await rl.whenReady();
    expect(mockReads).toBe(1);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('повтор тоже упал — следующий обратившийся пробует снова', async () => {
    mockFailUntil = 2;
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.isBlocked(PEER)).toBe(false);
    await rl.whenReady();
    expect(rl.isBlocked(PEER)).toBe(true);
    expect(mockReads).toBe(3);
  });

  it('повтор один на всех, кто пришёл в одно окно', async () => {
    mockFailUntil = 1;
    const rl = new RateLimiter();
    await Promise.all([rl.whenReady(), rl.whenReady(), rl.whenReady()]);
    expect(mockReads).toBe(2);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('синхронный вопрос сам запускает повтор', async () => {
    // Так спрашивают приём звонка, mesh-фильтр и ворота отправки: whenReady
    // им ждать негде.
    mockFailUntil = 1;
    const rl = new RateLimiter();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(mockReads).toBe(1);
    expect(rl.isBlocked(PEER)).toBe(false); // этот ответ уже не исправить
    await new Promise((r) => { setTimeout(r, 0); });
    expect(mockReads).toBe(2);
    expect(rl.isBlocked(PEER)).toBe(true); // а следующий — верный
  });

  it('переключение профиля не тянет за собой чужой повтор', async () => {
    mockFailUntil = 1;
    const rl = new RateLimiter();
    await rl.whenReady();
    const before = mockReads;
    await rl.resetForProfileSwitch();
    expect(mockReads).toBe(before + 1);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('пустая запись — это не сбой, а пустой список', async () => {
    delete mockLocal.__kv[KEY];
    const rl = new RateLimiter();
    await rl.whenReady();
    await rl.whenReady();
    expect(mockReads).toBe(1);
    expect(rl.isBlocked(PEER)).toBe(false);
  });
});

describe('форма исходника', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'rateLimiter.ts'), 'utf8');

  it('чтение и разбор ошибки разведены по разным методам', () => {
    expect(source).toContain('private async loadBlockedOnce(): Promise<void> {');
    expect(source).toContain('await this.loadBlockedOnce();');
  });

  it('успех снимает отметку, сбой ставит', () => {
    const at = source.indexOf('private async loadBlocked(): Promise<void> {');
    const body = source.slice(at, source.indexOf('\n  }\n', at));
    expect(body).toContain('this.loadFailed = false;');
    expect(body).toContain('this.loadFailed = true;');
    expect(body).toContain("log.warn('rate_limiter_block_load_failed'");
  });

  it('разбор ошибки живёт ровно в одном месте', () => {
    expect(source.match(/rate_limiter_block_load_failed/g)).toHaveLength(1);
    expect(source.match(/this\.loadFailed = true;/g)).toHaveLength(1);
  });

  it('оба входа спрашивают отметку', () => {
    const ready = source.slice(source.indexOf('async whenReady('));
    expect(ready.slice(0, 200)).toContain('if (this.loadFailed) await this.retryLoad();');
    const blocked = source.slice(source.indexOf('isBlocked(peerPubKeyB64: string): boolean {'));
    expect(blocked.slice(0, 500)).toContain('if (this.loadFailed) void this.retryLoad();');
  });

  it('повтор не отклоняется: он идёт через loadBlocked, а тот всё ловит', () => {
    const at = source.indexOf('private retryLoad(): Promise<void> {');
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, source.indexOf('\n  }\n', at));
    expect(body).toContain('this.loadBlocked()');
    expect(body).toContain('this.reloading = again;');
    expect(body).toContain('this.ready = again;');
  });
});
