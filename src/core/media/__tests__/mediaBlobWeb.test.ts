jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: null,
  getInfoAsync: jest.fn(async () => { throw new Error('native filesystem unavailable'); }),
  readAsStringAsync: jest.fn(async () => { throw new Error('native filesystem unavailable'); }),
}));
jest.mock('../../logger', () => ({ log: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../transport/internet/internetTransport', () => ({
  getInternetTransportSingleton: () => ({ getStatus: () => ({ relay: 'https://ntfy.sh' }) }),
}));
jest.mock('../../config', () => ({ getConfigSync: () => ({ internet: { relayBase: 'https://ntfy.sh' }, cloudBackup: { enabled: false } }) }));
jest.mock('../../backup/seedPhrase', () => ({ getMnemonicGeneration: () => 1, getStoredMnemonic: async () => null }));
jest.mock('../../sync/syncApi', () => ({ downloadSyncMedia: async () => null, uploadSyncMedia: jest.fn() }));
jest.mock('../../transport/lan/lanBlob', () => ({ lanBlobCacheWrite: jest.fn(), lanBlobPush: jest.fn(), lanBlobCachedPath: jest.fn() }));
jest.mock('../readWebAttachment', () => ({ readWebAttachment: jest.fn(async () => ({ ok: true, b64: 'AQID', size: 3, mime: 'image/png' })) }));

import { Buffer } from 'buffer';
import * as FS from 'expo-file-system/legacy';
import { readWebAttachment } from '../readWebAttachment';
import { uploadEncryptedBlob, resolveBlobToLocalFileResult } from '../mediaBlob';
import { decryptSymmetric, encryptSymmetric } from '../../crypto/encrypt';

beforeEach(() => jest.clearAllMocks());

it('encrypts picker bytes and uploads without native filesystem reads', async () => {
  let uploaded = '';
  globalThis.fetch = jest.fn(async (_url, options) => {
    uploaded = String(options?.body);
    return { ok: true, json: async () => ({ attachment: { url: 'https://ntfy.sh/file/test.bin' } }) };
  }) as unknown as typeof fetch;
  const ref = await uploadEncryptedBlob('blob:https://air.example/picker');
  expect(ref).not.toBeNull();
  expect(readWebAttachment).toHaveBeenCalled();
  expect(FS.readAsStringAsync).not.toHaveBeenCalled();
  expect(decryptSymmetric(new Uint8Array(Buffer.from(ref!.k, 'base64')), new Uint8Array(Buffer.from(uploaded, 'base64')))).toEqual(new Uint8Array([1, 2, 3]));
});

it.each(['image/png', 'text/html', 'image/svg+xml'])('decrypts browser attachments with safe MIME (%s)', async (mime) => {
  const key = new Uint8Array(32).fill(4);
  const cipher = encryptSymmetric(key, new Uint8Array([1, 2, 3]));
  globalThis.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => null }, text: async () => Buffer.from(cipher).toString('base64') })) as unknown as typeof fetch;
  const result = await resolveBlobToLocalFileResult({ u: 'https://ntfy.sh/file/test.bin', k: Buffer.from(key).toString('base64'), m: mime });
  expect(result).toEqual({ ok: true, uri: `data:${mime === 'image/png' ? mime : 'application/octet-stream'};base64,AQID` });
  expect(FS.readAsStringAsync).not.toHaveBeenCalled();
});

it('does not fetch an untrusted attachment host', async () => {
  globalThis.fetch = jest.fn();
  expect(await resolveBlobToLocalFileResult({ u: 'https://tracker.example/file/test.bin', k: Buffer.alloc(32).toString('base64') })).toEqual({ ok: false, reason: 'blocked-host' });
  expect(fetch).not.toHaveBeenCalled();
});
