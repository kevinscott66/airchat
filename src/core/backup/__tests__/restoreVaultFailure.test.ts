/**
 * Не восстановившаяся копия кошелька обязана быть слышна (v4.32.619).
 *
 * Дефект. `restoreFromMnemonic` звала `restoreAccountVault(normalized)` и
 * ответ выбрасывала. А `false` там значит «не тот ключ», «манифест не
 * разобрался» или «файловая система отказала» — то есть база с перепиской,
 * публикациями и группами на диск НЕ легла. Человек после этого попадал в
 * приложение с верным DID и пустотой вместо своих данных, и ни одного слова
 * ему об этом не говорилось: экран восстановления рапортовал успех.
 *
 * Отсутствие снимка — случай законный и отдельный: профиль просто заведётся
 * чистым. `restoreAccountVault` отвечает `false` и на него тоже, поэтому
 * спрашивать надо `hasAccountVaultSnapshot`, а не толковать один `false` в
 * два смысла.
 */
let mockHasSnapshot = false;
let mockRestoreOk = true;
const mockCalls: string[] = [];

jest.mock('../../storage/accountVault', () => ({
  hasAccountVaultSnapshot: jest.fn(async () => mockHasSnapshot),
  restoreAccountVault: jest.fn(async () => { mockCalls.push('restore'); return mockRestoreOk; }),
}));

const mockSecure = new Map<string, string>();
jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockSecure.set(k, v); },
  deleteItemAsync: async (k: string) => { mockSecure.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../crypto/keyManager', () => ({
  persistKeyPair: jest.fn(async () => { mockCalls.push('persistKeyPair'); }),
}));

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async () => null),
  kvSet: jest.fn(async () => undefined),
  closeLocalDatabase: jest.fn(async () => undefined),
}));

jest.mock('../../social/feedService', () => ({
  closeFeedStorage: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { restoreFromMnemonic } from '../seedPhrase';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(() => {
  mockSecure.clear();
  mockCalls.length = 0;
  mockHasSnapshot = false;
  mockRestoreOk = true;
});

describe('восстановление из секретных слов', () => {
  it('проверка не пустая: снимок есть и лёг — восстановление проходит', async () => {
    mockHasSnapshot = true;
    mockRestoreOk = true;
    const pair = await restoreFromMnemonic(MNEMONIC);
    expect(pair.publicKey).toHaveLength(32);
    expect(mockCalls).toContain('restore');
  });

  it('снимка нет — это не сбой, профиль заведётся чистым', async () => {
    mockHasSnapshot = false;
    mockRestoreOk = false;
    const pair = await restoreFromMnemonic(MNEMONIC);
    expect(pair.publicKey).toHaveLength(32);
    // Раз снимка нет, восстанавливать нечего — и звать незачем.
    expect(mockCalls).not.toContain('restore');
  });

  it('снимок есть, но не восстановился — наружу ошибка, а не тихий вход', async () => {
    mockHasSnapshot = true;
    mockRestoreOk = false;
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow(/не восстановилась/);
  });

  it('ключи всё равно записаны — повтор той же фразой сойдётся', async () => {
    mockHasSnapshot = true;
    mockRestoreOk = false;
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow();
    // Секретные слова уже легли: следующая попытка теми же словами не
    // упрётся в «сначала выйдите из текущего кошелька».
    mockRestoreOk = true;
    await expect(restoreFromMnemonic(MNEMONIC)).resolves.toBeTruthy();
  });
});
