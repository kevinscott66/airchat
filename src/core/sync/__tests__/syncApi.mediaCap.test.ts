/**
 * Облачная копия вложения читается в память только до известного потолка
 * (v4.32.622).
 *
 * `Buffer.from(b64, 'base64')` синхронная: строка любой длины разворачивалась
 * в память целиком раньше, чем дело доходило до расшифровки, и телефон падал
 * по нехватке памяти. Отвечает при этом не наш узел, а тот, кто отвечает: тема
 * запроса — адрес из настроек, и ответ произвольной длины стоит ему одного
 * заголовка. Потолок общий со скачиванием вложения с релея (blobRef).
 *
 * Заодно проверяется, что отказ оставляет след: до этой версии «копии нет»,
 * «устройство отозвано», «истёк таймаут» и «сервер ответил мусором» были
 * неотличимы вообще ничем — наружу уходил один и тот же null.
 */
jest.mock('../../storage/secureStoreQueued', () => {
  const secure = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => secure.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { secure.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { secure.delete(key); }),
  };
});
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '18.0', constants: {}, isPad: false },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' }, nativeAppVersion: '1.0.0', platform: { ios: { model: 'iPhone' } } },
}));
jest.mock('../../storage/accountVault', () => ({
  accountIdFromPublicKey: jest.fn(() => 'account-id'),
  accountVaultIdFromMnemonic: jest.fn(() => 'legacy-id'),
}));
jest.mock('../../backup/seedPhrase', () => ({
  deriveKeyPairFromMnemonic: jest.fn(() => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) })),
}));
jest.mock('../../config', () => ({
  getConfigSync: jest.fn(() => ({ cloudBackup: { enabled: true, baseUrl: 'https://sync.example/cloud-vault' } })),
}));
jest.mock('../../crypto/signature', () => ({ signJson: jest.fn(async () => ({ payload: '{}', signature: 'sig' })) }));
jest.mock('../../crypto/keyManager', () => ({ ED25519_SECRET_KEY_BYTES: 32 }));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { downloadSyncMedia } from '../syncApi';
import { MAX_DOWNLOAD_B64_CHARS } from '../../media/blobRef';

const mockLog = (jest.requireMock('../../logger') as { log: { warn: jest.Mock } }).log;
const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
const MEDIA_ID = 'media-1234567890';


function serve(mediaBody: () => string): void {
  global.fetch = jest.fn(async (url: string) => {
    // Любой запрос синхронизации начинается с постановки устройства на учёт.
    if (String(url).includes('/devices/enroll')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(mediaBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockLog.warn.mockClear();
});

it('строка длиннее потолка не разворачивается в память', async () => {
  const oversize = 'A'.repeat(MAX_DOWNLOAD_B64_CHARS + 1);
  serve(() => JSON.stringify({ mediaId: MEDIA_ID, ciphertextB64: oversize }));

  const spy = jest.spyOn(Buffer, 'from');
  try {
    expect(await downloadSyncMedia('valid seed', PAIR, MEDIA_ID)).toBeNull();
    // Именно это и стоило памяти: развернуть 12 МБ base64 в байты.
    const decoded = spy.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).length > MAX_DOWNLOAD_B64_CHARS,
    );
    expect(decoded).toBe(false);
  } finally {
    spy.mockRestore();
  }

  expect(mockLog.warn).toHaveBeenCalledWith('sync_media_oversize', expect.objectContaining({
    chars: MAX_DOWNLOAD_B64_CHARS + 1,
  }));
});

it('проверка не пустая: копия в пределах потолка возвращается байтами', async () => {
  const payload = Buffer.from('вложение').toString('base64');
  serve(() => JSON.stringify({ mediaId: MEDIA_ID, ciphertextB64: payload }));

  const bytes = await downloadSyncMedia('valid seed', PAIR, MEDIA_ID);
  expect(bytes).not.toBeNull();
  expect(Buffer.from(bytes as Uint8Array).toString()).toBe('вложение');
  expect(mockLog.warn).not.toHaveBeenCalledWith('sync_media_oversize', expect.anything());
});

it('отказ сервера оставляет след в журнале, а не только null', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/devices/enroll')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'device_revoked' }), { status: 403 });
  }) as unknown as typeof fetch;

  expect(await downloadSyncMedia('valid seed', PAIR, MEDIA_ID)).toBeNull();
  expect(mockLog.warn).toHaveBeenCalledWith('sync_media_get_failed', expect.objectContaining({
    err: 'Это устройство отозвано. Войдите снова на этом устройстве.',
  }));
});
