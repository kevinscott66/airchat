/**
 * v4.32.1031 — восстановление молча проходило мимо целой копии.
 *
 * Дефект. `restoreFromMnemonic` спрашивала `hasAccountVaultSnapshot`, а та
 * отвечала `false` и на «копии нет», и на «посмотреть не смогли»: опрос шёл
 * через `exists`, гасящий бросок, а подъёмник застрявших под `.previous-…`
 * копий молчал о своих отказах. Ветка «снимка нет» законна — профиль
 * заводится чистым, — поэтому ошибочное «нет» никуда не докладывалось.
 *
 * Цена. Человек вводит секретные слова, видит успех и попадает в пустой
 * аккаунт, тогда как копия лежит на диске целой. Подсказанное таким экраном
 * действие — выйти и восстановить заново, — а выход зовёт
 * `performLocalWalletWipe`, то есть `deleteAccountVault`. Копия уносится.
 * Отдельно: при смене кошелька то же «нет» велит выйти из ТЕКУЩЕГО кошелька,
 * хотя разрешение остаться давала как раз местная копия нового seed'а.
 *
 * Правка. Состояние копии отвечает тремя словами, и `unknown` доходит до
 * человека ошибкой: «не удалось проверить». Пустой аккаунт больше не
 * выдаётся за отсутствие данных.
 *
 * Границы. Само хранилище здесь подделано: честность его ответа проверяет
 * `core/storage/__tests__/vaultSnapshotUnknown1031.test.ts`. Тут — что с
 * этим ответом делает восстановление.
 */
/** Что отвечает хранилище о местной копии: три слова, как в модуле. */
let mockState: 'present' | 'absent' | 'unknown' = 'absent';
let mockRestoreOk = true;
const mockCalls: string[] = [];

jest.mock('../../storage/accountVault', () => ({
  // Обе двери сразу: до правки `restoreFromMnemonic` зовёт прежнюю, и
  // `false` — ровно то, чем нынешний опрос отвечает на свой отказ.
  hasAccountVaultSnapshot: jest.fn(async () => mockState === 'present'),
  accountVaultSnapshotState: jest.fn(async () => mockState),
  restoreAccountVault: jest.fn(async () => {
    mockCalls.push('restore');
    return mockRestoreOk;
  }),
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

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER =
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

beforeEach(() => {
  mockSecure.clear();
  mockCalls.length = 0;
  mockState = 'absent';
  mockRestoreOk = true;
});

describe('восстановление не выдаёт непроверенное за пустое', () => {
  it('посмотреть не смогли — человек слышит об этом, а не входит в пустоту', async () => {
    mockState = 'unknown';
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow(/не удалось проверить/);
  });

  it('и восстановления при этом не затевается: мы не знаем, что восстанавливать', async () => {
    mockState = 'unknown';
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow();
    expect(mockCalls).not.toContain('restore');
  });

  it('при смене кошелька непроверенное не гонит человека выходить из текущего', async () => {
    // Сначала завести кошелёк, чтобы `previous` был не пуст.
    mockState = 'absent';
    await restoreFromMnemonic(MNEMONIC);
    mockCalls.length = 0;
    mockState = 'unknown';
    // Разрешение остаться даёт местная копия нового seed'а. Пока о ней
    // ничего не известно, «сначала выйдите» — совет стереть данные зря.
    await expect(restoreFromMnemonic(OTHER)).rejects.toThrow(/не удалось проверить/);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние три случая отвечают как раньше', () => {
  it('снимок есть и лёг — восстановление проходит', async () => {
    mockState = 'present';
    const pair = await restoreFromMnemonic(MNEMONIC);
    expect(pair.publicKey).toHaveLength(32);
    expect(mockCalls).toContain('restore');
  });

  it('снимка нет — это не сбой, профиль заведётся чистым', async () => {
    mockState = 'absent';
    mockRestoreOk = false;
    const pair = await restoreFromMnemonic(MNEMONIC);
    expect(pair.publicKey).toHaveLength(32);
    expect(mockCalls).not.toContain('restore');
  });

  it('снимок есть, но не восстановился — наружу ошибка, а не тихий вход', async () => {
    mockState = 'present';
    mockRestoreOk = false;
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow(/не восстановилась/);
  });

  it('ГРАНИЦА: чужой seed без местной копии по-прежнему просит выйти', async () => {
    mockState = 'absent';
    await restoreFromMnemonic(MNEMONIC);
    await expect(restoreFromMnemonic(OTHER)).rejects.toThrow(/выйдите из текущего/);
  });

  it('ГРАНИЦА: чужой seed с местной копией пускают без выхода', async () => {
    mockState = 'absent';
    await restoreFromMnemonic(MNEMONIC);
    mockState = 'present';
    await expect(restoreFromMnemonic(OTHER)).resolves.toBeTruthy();
  });

  it('ключи всё равно записаны — повтор той же фразой сойдётся', async () => {
    mockState = 'present';
    mockRestoreOk = false;
    await expect(restoreFromMnemonic(MNEMONIC)).rejects.toThrow();
    mockRestoreOk = true;
    await expect(restoreFromMnemonic(MNEMONIC)).resolves.toBeTruthy();
  });
});
