/**
 * Ответ 200, но не наш (v4.32.565).
 *
 * «Активные сессии» показывали общий запасной текст «Не удалось загрузить
 * список сессий» вместо причины. Причина терялась здесь: разбор тела
 * успешного ответа стоял вне try, и SyntaxError от JSON.parse уходил наружу
 * английским — а userErrorText показывает только кириллицу. Так выглядит
 * гостевой Wi-Fi с порталом и заглушка прокси: код 200, тело — HTML.
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

import { listSyncDevices, syncServerHost } from '../syncApi';
import { isUserFacingMessage } from '../../../ui/components/userErrorText';

const mockConfig = jest.requireMock('../../config') as { getConfigSync: jest.Mock };
const PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function respondWith(body: string): void {
  global.fetch = jest.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
}

afterEach(() => {
  mockConfig.getConfigSync.mockReturnValue({ cloudBackup: { enabled: true, baseUrl: 'https://sync.example/cloud-vault' } });
});

it('на 200 с телом не-JSON отдаёт причину по-русски, а не SyntaxError', async () => {
  respondWith('<html><body>Wi-Fi portal</body></html>');
  const error = await listSyncDevices('valid seed', PAIR).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('Сервер синхронизации ответил не по протоколу.');
  // Экран показывает текст только если он прошёл эту проверку — иначе
  // человек снова увидит запасной «Не удалось загрузить список сессий».
  expect(isUserFacingMessage((error as Error).message)).toBe(true);
});

it('syncServerHost показывает узел, куда настроена синхронизация', () => {
  expect(syncServerHost()).toBe('sync.example');
});

it('syncServerHost возвращает null, когда облачная копия выключена', () => {
  mockConfig.getConfigSync.mockReturnValue({ cloudBackup: { enabled: false, baseUrl: 'https://sync.example' } });
  expect(syncServerHost()).toBeNull();
});
