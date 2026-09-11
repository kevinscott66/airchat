/**
 * Ключ обёртки: чтение фразы больше не может её уничтожить (v4.32.615).
 *
 * Дефект. Один и тот же `ensureLocalWrapKey` стоял и на записи, и на чтении
 * v3-payload, и любая негодная запись ключа приводила к тому, что чтение молча
 * заводило новый ключ поверх старого. С этого момента `airchat_seed_mnemonic_enc_v2`
 * не открывался уже ничем, а наружу это выглядело как чистая установка.
 *
 * Здесь проверяется, что чтение хранилище не меняет, а запись — по-прежнему
 * заводит ключ, когда годного нет.
 */
const mockStore = new Map<string, string>();
const mockWrites: string[] = [];
const mockWarn = jest.fn();

jest.mock('../../storage/secureStoreQueued', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockWrites.push(k); mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
  isAvailableAsync: async () => true,
}));

jest.mock('../../storage/local', () => ({
  kvGet: async () => null,
  kvSet: async () => undefined,
}));

jest.mock('../../crypto/keyManager', () => ({ persistKeyPair: async () => undefined }));

jest.mock('../../storage/accountVault', () => ({
  hasAccountVaultSnapshot: async () => false,
  restoreAccountVault: async () => undefined,
}));

// Ссылка на `mockWarn` — ленивая: фабрику зовут раньше, чем инициализируется
// объявление выше, и прямая подстановка дала бы `warn: undefined`.
jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { generateMnemonic } from 'bip39';
import { decideStoredPhraseState } from '../storedPhraseState';
import {
  getStoredMnemonic,
  hasStoredMnemonic,
  persistEncryptedMnemonic,
  invalidateMnemonicGeneration,
} from '../seedPhrase';

const WRAP_KEY = 'airchat_mnemonic_local_wrap_key_v3';
const ENC_KEY = 'airchat_seed_mnemonic_enc_v2';

/** Убрать из памяти результат прошлого чтения, не трогая хранилище. */
function forgetCaches(): void {
  invalidateMnemonicGeneration();
}

describe('ключ обёртки: чтение не заводит и не перезаписывает', () => {
  beforeEach(() => {
    mockStore.clear();
    mockWrites.length = 0;
    mockWarn.mockClear();
    invalidateMnemonicGeneration();
  });

  it('здоровое устройство читается как раньше', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    forgetCaches();
    expect(await getStoredMnemonic()).toBe(m);
  });

  it('испорченный ключ обёртки чтение оставляет как есть', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    const broken = 'AAAA'; // три байта вместо тридцати двух
    mockStore.set(WRAP_KEY, broken);
    forgetCaches();
    mockWrites.length = 0;

    expect(await getStoredMnemonic()).toBeNull();
    expect(mockStore.get(WRAP_KEY)).toBe(broken);
    expect(mockWrites).toEqual([]);
  });

  it('пропавший ключ обёртки чтение не заводит заново', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    mockStore.delete(WRAP_KEY);
    forgetCaches();
    mockWrites.length = 0;

    expect(await getStoredMnemonic()).toBeNull();
    expect(mockStore.has(WRAP_KEY)).toBe(false);
    expect(mockWrites).toEqual([]);
  });

  it('сам payload при этом остаётся на устройстве', async () => {
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    const payload = mockStore.get(ENC_KEY);
    mockStore.delete(WRAP_KEY);
    forgetCaches();

    expect(await getStoredMnemonic()).toBeNull();
    expect(mockStore.get(ENC_KEY)).toBe(payload);
  });

  it('о потере сообщают в журнал — раньше сигнала не было ни одного', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    mockStore.delete(WRAP_KEY);
    forgetCaches();
    mockWarn.mockClear();
    await getStoredMnemonic();
    expect(mockWarn).toHaveBeenCalledWith('seed_local_wrap_key_unusable', { state: 'absent' });

    mockStore.set(WRAP_KEY, 'AAAA');
    forgetCaches();
    mockWarn.mockClear();
    await getStoredMnemonic();
    expect(mockWarn).toHaveBeenCalledWith('seed_local_wrap_key_unusable', { state: 'unreadable' });
  });

  // v4.32.717: проверка перевёрнута — прежде она закрепляла сам дефект.
  //
  // Стояло `expect(await hasStoredMnemonic()).toBe(false)`: на испорченном
  // ключе обёртки наличие записи докладывалось как её отсутствие. Отсутствие
  // ведёт на обычный welcome, где «Создать новый аккаунт» пишет новую фразу
  // поверх старой. Наличие — вопрос о записи, а не о том, открылась ли она;
  // читаемость спрашивают отдельно, у getStoredMnemonic (см. соседние
  // проверки в этом же describe и decideStoredPhraseState).
  it('hasStoredMnemonic на испорченном ключе отвечает «запись есть»', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    mockStore.set(WRAP_KEY, 'AAAA');
    forgetCaches();
    mockWrites.length = 0;

    expect(await hasStoredMnemonic()).toBe(true);
    // Хранилище от вопроса не меняется: ни ключ, ни payload не переписываются.
    expect(mockWrites).toEqual([]);
  });

  it('«запись есть» плюс «не открылась» — это unreadable, а не none', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    mockStore.set(WRAP_KEY, 'AAAA');
    forgetCaches();

    const present = await hasStoredMnemonic();
    const phrase = await getStoredMnemonic();
    expect(phrase).toBeNull();
    expect(decideStoredPhraseState(present, phrase)).toBe('unreadable');
  });

  it('на чистом устройстве по-прежнему «нет»', async () => {
    forgetCaches();
    expect(await hasStoredMnemonic()).toBe(false);
    expect(decideStoredPhraseState(false, null)).toBe('none');
  });
});

describe('ключ обёртки: запись его по-прежнему заводит', () => {
  beforeEach(() => {
    mockStore.clear();
    mockWrites.length = 0;
    mockWarn.mockClear();
    invalidateMnemonicGeneration();
  });

  it('на чистом устройстве появляется ключ на 32 байта', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    const stored = mockStore.get(WRAP_KEY);
    expect(typeof stored).toBe('string');
    expect(Buffer.from(stored as string, 'base64').length).toBe(32);
  });

  it('поверх испорченного ключа запись заводит годный, и фраза читается', async () => {
    mockStore.set(WRAP_KEY, 'AAAA');
    const m = generateMnemonic(256);
    await persistEncryptedMnemonic(m);
    forgetCaches();

    expect(Buffer.from(mockStore.get(WRAP_KEY) as string, 'base64').length).toBe(32);
    expect(await getStoredMnemonic()).toBe(m);
  });

  it('годный ключ повторная запись не меняет', async () => {
    await persistEncryptedMnemonic(generateMnemonic(256));
    const first = mockStore.get(WRAP_KEY);
    await persistEncryptedMnemonic(generateMnemonic(256));
    expect(mockStore.get(WRAP_KEY)).toBe(first);
  });
});

describe('храповик: чтение payload не зовёт ensureLocalWrapKey', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'seedPhrase.ts'), 'utf8'
  ) as string;
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const bodyOf = (head: string): string => {
    const i = CODE.indexOf(head);
    expect(i).toBeGreaterThan(-1);
    const j = CODE.indexOf('\n}\n', i);
    return CODE.slice(i, j);
  };

  it('tryDecryptLocalPayload читает ключ, но не заводит его', () => {
    const body = bodyOf('async function tryDecryptLocalPayload(');
    expect(body).toContain('await readLocalWrapKey()');
    expect(body).not.toContain('ensureLocalWrapKey');
  });

  it('readLocalWrapKey ничего не пишет в хранилище', () => {
    const body = bodyOf('async function readLocalWrapKey(');
    expect(body).toContain('getItemAsync');
    expect(body).not.toContain('setItemAsync');
  });

  it('persistEncryptedMnemonic ключ по-прежнему заводит', () => {
    const body = bodyOf('export async function persistEncryptedMnemonic(');
    expect(body).toContain('await ensureLocalWrapKey()');
  });
});
