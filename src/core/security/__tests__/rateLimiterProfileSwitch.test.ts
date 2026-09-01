/**
 * v4.32.497 — переключение аккаунта обнуляет ВСЕ окна ограничений.
 *
 * Окна ключуются публичным ключом собеседника, а не номером профиля: один и
 * тот же человек может быть в контактах обоих аккаунтов. Что израсходовано
 * под одной личностью, не должно ограничивать другую.
 *
 * Мок хранилища тот же, что в rateLimiter.test.ts: kvSetSecret/kvGetSecret с
 * обратимым префиксом вместо шифрования.
 */

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
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret,
    kvSetSecret,
    kvGetSecretUpgrading: kvGetSecret,
    notifyChatStorageChanged: jest.fn(),
  };
});

jest.mock('../../crypto/keyManager', () => ({
  publicKeyHash4: () => new Uint8Array([1, 2, 3, 4]),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

import fs from 'fs';
import path from 'path';
import { RateLimiter } from '../rateLimiter';

const PEER = 'A'.repeat(43);
const CONTROL_LIMIT = 500;
const MESSAGE_LIMIT = 50;
const INVITE_LIMIT = 10;
const HASH = '01020304';

async function loaded(): Promise<RateLimiter> {
  const rl = new RateLimiter();
  await rl.whenReady();
  return rl;
}

/** Израсходовать окно до отказа. */
function drain(take: () => boolean, limit: number): void {
  for (let i = 0; i < limit; i++) expect(take()).toBe(true);
  expect(take()).toBe(false);
}

describe('окна ограничений не переезжают в другой аккаунт', () => {
  it('служебные конверты: запас возвращается после переключения', async () => {
    const rl = await loaded();
    drain(() => rl.canSendControl(PEER), CONTROL_LIMIT);
    await rl.resetForProfileSwitch();
    expect(rl.canSendControl(PEER)).toBe(true);
  });

  it('личные сообщения: запас возвращается после переключения', async () => {
    const rl = await loaded();
    drain(() => rl.canSendMessage(PEER), MESSAGE_LIMIT);
    await rl.resetForProfileSwitch();
    expect(rl.canSendMessage(PEER)).toBe(true);
  });

  it('приглашения: запас возвращается после переключения', async () => {
    const rl = await loaded();
    drain(() => rl.canSendInvite(HASH), INVITE_LIMIT);
    await rl.resetForProfileSwitch();
    expect(rl.canSendInvite(HASH)).toBe(true);
  });

  it('без переключения запас по-прежнему кончается', async () => {
    const rl = await loaded();
    drain(() => rl.canSendControl(PEER), CONTROL_LIMIT);
    expect(rl.canSendControl(PEER)).toBe(false);
  });

  it('окна раздельные: служебные не расходуют запас личных', async () => {
    const rl = await loaded();
    drain(() => rl.canSendControl(PEER), CONTROL_LIMIT);
    expect(rl.canSendMessage(PEER)).toBe(true);
  });

  it('переключение чистит блок-лист в памяти до перечитывания', async () => {
    const rl = await loaded();
    await rl.blockContact(PEER);
    expect(rl.isBlocked(PEER)).toBe(true);
    await rl.unblockContact(PEER);
    await rl.resetForProfileSwitch();
    expect(rl.isBlocked(PEER)).toBe(false);
  });
});

describe('форма исходника', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'rateLimiter.ts'), 'utf8');
  const reset = (() => {
    const at = source.indexOf('async resetForProfileSwitch(');
    expect(at).toBeGreaterThan(0);
    return source.slice(at, source.indexOf('\n  }\n', at));
  })();

  /** Все окна класса — по объявлению полей, а не по памяти автора теста. */
  const windows = [...source.matchAll(/private (?:readonly )?(\w+) = new Map</g)].map((m) => m[1]);

  it('окон в классе ровно три и они найдены', () => {
    expect(windows.sort()).toEqual(['controlCounts', 'inviteCounts', 'messageCounts']);
  });

  it.each(['inviteCounts', 'messageCounts', 'controlCounts'])(
    'окно %s чистится при переключении',
    (name) => {
      expect(windows).toContain(name);
      expect(reset).toContain(`this.${name}.clear();`);
    },
  );

  it('новое окно нельзя добавить, забыв про чистку', () => {
    for (const name of windows) expect(reset).toContain(`this.${name}.clear();`);
  });

  it('блок-лист перечитывается с диска, а не просто очищается', () => {
    expect(reset).toContain('this.blocked = new Set();');
    expect(reset).toContain('this.ready = this.loadBlocked();');
    expect(reset).toContain('await this.ready;');
  });
});
