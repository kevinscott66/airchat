/**
 * v4.32.617 — блок-лист отвечает за себя честно.
 *
 * Две дыры, закрытые здесь.
 *
 * 1. `blockContact` возвращал `void`. Провал записи оставался только в
 *    журнале, а все экраны одинаково показывали «Заблокировано»: человек
 *    уходил уверенный, что запрет поставлен, и узнавал обратное после
 *    перезапуска — от заблокированного приходило сообщение.
 *
 * 2. Снимок kv с другого устройства (синхронизация) или из копии
 *    (восстановление) ложится в базу мимо этого класса. В памяти оставался
 *    прежний список, и следующая же блокировка выкладывала его целиком
 *    поверх пришедшего — молча снимая запрет сразу на обоих устройствах.
 */

let mockSaveFails = false;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  const PREFIX = 'enc2:';
  const read = (k: string) => {
    const stored = kv[k];
    if (stored == null) return null;
    return stored.startsWith(PREFIX) ? stored.slice(PREFIX.length) : stored;
  };
  return {
    __kv: kv,
    __prefix: PREFIX,
    kvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
    kvGetSecret: jest.fn(async (k: string) => read(k)),
    kvGetSecretUpgrading: jest.fn(async (k: string) => read(k)),
    // Настоящий kvSetSecret отвечает false, когда шифрование не состоялось
    // (ключ at-rest не поднят, база занята) — именно этот путь и проверяем.
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      if (mockSaveFails) return false;
      kv[k] = PREFIX + v;
      return true;
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
import { BLOCK_NOT_SAVED_OFF, BLOCK_NOT_SAVED_ON, RateLimiter } from '../rateLimiter';

type MockLocal = { __kv: Record<string, string>; __prefix: string };
const mockLocal = jest.requireMock('../../storage/local') as MockLocal;

const KEY = 'p1:airchat_blocked_peer_pub_b64';
const PEER = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);

function putList(list: string[]): void {
  mockLocal.__kv[KEY] = `${mockLocal.__prefix}${JSON.stringify(list)}`;
}

beforeEach(() => {
  for (const k of Object.keys(mockLocal.__kv)) delete mockLocal.__kv[k];
  mockSaveFails = false;
});

describe('запись блок-листа не удалась', () => {
  it('блокировка честно отвечает, что не записана', async () => {
    const rl = new RateLimiter();
    await rl.whenReady();
    mockSaveFails = true;
    expect(await rl.blockContact(PEER)).toBe(false);
    // В памяти запрет всё же действует — до перезапуска.
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('проверка не пустая: удачная запись отвечает да', async () => {
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(await rl.blockContact(PEER)).toBe(true);
    expect(mockLocal.__kv[KEY]).toContain(PEER);
  });

  it('снятие блокировки отвечает так же', async () => {
    putList([PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    mockSaveFails = true;
    expect(await rl.unblockContact(PEER)).toBe(false);
  });

  it('проверка не пустая: удачное снятие отвечает да', async () => {
    putList([PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(await rl.unblockContact(PEER)).toBe(true);
    expect(rl.isBlocked(PEER)).toBe(false);
  });

  it('негодная форма ключа — тоже отказ, а не молчание', async () => {
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(await rl.blockContact('короткий')).toBe(false);
  });

  it('обе строки для человека разные и не пустые', () => {
    expect(BLOCK_NOT_SAVED_ON.length).toBeGreaterThan(0);
    expect(BLOCK_NOT_SAVED_OFF.length).toBeGreaterThan(0);
    expect(BLOCK_NOT_SAVED_ON).not.toBe(BLOCK_NOT_SAVED_OFF);
  });
});

describe('список изменили мимо класса', () => {
  it('перечитывание поднимает пришедший список', async () => {
    putList([PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.isBlocked(OTHER)).toBe(false);

    // Так это и происходит: importDialogKvSnapshot кладёт строку прямо в базу.
    putList([PEER, OTHER]);
    expect(rl.isBlocked(OTHER)).toBe(false); // до перечитывания — не видно

    await rl.reloadBlocked();
    expect(rl.isBlocked(OTHER)).toBe(true);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('перечитывание именно перечитывает, а не сливает', async () => {
    // Снятый на другом устройстве запрет должен исчезнуть и здесь: слияние
    // вернуло бы его обратно.
    putList([PEER, OTHER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    expect(rl.isBlocked(OTHER)).toBe(true);

    putList([PEER]);
    await rl.reloadBlocked();
    expect(rl.isBlocked(OTHER)).toBe(false);
    expect(rl.isBlocked(PEER)).toBe(true);
  });

  it('без перечитывания следующая блокировка затирает пришедшее', async () => {
    // Ровно та поломка, ради которой нужен reloadBlocked: проверка показывает
    // цену пропущенного перечитывания.
    putList([PEER]);
    const rl = new RateLimiter();
    await rl.whenReady();
    putList([PEER, OTHER]);
    await rl.blockContact('C'.repeat(43));
    expect(mockLocal.__kv[KEY]).not.toContain(OTHER);
  });
});

describe('форма исходника', () => {
  const dir = path.join(__dirname, '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

  it('экраны показывают отказ, а не «Заблокировано»', () => {
    for (const rel of [
      '../ui/screens/ChatScreen.tsx',
      '../ui/screens/ContactsScreen.tsx',
      '../ui/components/BlockedContactsList.tsx',
    ]) {
      expect(read(rel)).toContain('BLOCK_NOT_SAVED_OFF');
    }
  });

  it('снимок kv перечитывает список на обоих входах', () => {
    for (const rel of ['sync/liveAccountSync.ts', 'storage/dialogBackup.ts']) {
      const src = read(rel);
      expect(src).toContain('dialogKvSnapshotHasBlockList');
      expect(src).toContain('rateLimiter.reloadBlocked()');
    }
  });
});
