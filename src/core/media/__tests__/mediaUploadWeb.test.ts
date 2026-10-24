jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => { throw new Error('native FS unavailable'); },
  readAsStringAsync: jest.fn(async () => { throw new Error('native FS unavailable'); }),
}));
jest.mock('../../logger', () => ({ log: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => true }));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: jest.fn(async () => 'bafy-test') }));
jest.mock('../mediaBlob', () => ({ uploadEncryptedBlob: jest.fn(async () => ({ id: 'encrypted' })), makeNbCid: () => 'nb:encrypted' }));
jest.mock('../readWebAttachment', () => ({ readWebAttachment: jest.fn(async () => ({ ok: true, b64: 'AQID', size: 3, mime: 'image/png' })) }));
import { Platform } from 'react-native';
import * as FS from 'expo-file-system/legacy';
import { uploadMediaToCid } from '../mediaUpload';
import { addToIpfs } from '../../transport/ipfs/node';
import { uploadEncryptedBlob } from '../mediaBlob';
import { MAX_BLOB_BYTES } from '../blobRef';
import { readWebAttachment } from '../readWebAttachment';

it('explicit public upload preserves browser picker reading and size reporting', async () => {
  expect(await uploadMediaToCid('data:image/png;base64,AQID', { publicIpfs: true })).toEqual({ ok: true, cid: 'bafy-test', sizeBytes: 3 });
  expect(addToIpfs).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  expect(FS.readAsStringAsync).not.toHaveBeenCalled();
});
it('rejects oversized picker data before IPFS upload', async () => {
  jest.clearAllMocks();
  (readWebAttachment as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'oversize' });
  expect(await uploadMediaToCid('blob:https://air.example/picker', { publicIpfs: true, ipfsMaxBytes: 12 })).toEqual({ ok: false, reason: 'oversize', limitBytes: 12 });
  expect(addToIpfs).not.toHaveBeenCalled();
});

it('private browser attachments bypass local Helia even when it would return a CID', async () => {
  jest.clearAllMocks();
  expect(await uploadMediaToCid('blob:https://air.example/private', { sizeBytes: 3, mime: 'text/plain', targetDid: 'did:recipient' })).toEqual({ ok: true, cid: 'nb:encrypted', sizeBytes: 3 });
  expect(addToIpfs).not.toHaveBeenCalled();
  expect(readWebAttachment).not.toHaveBeenCalled();
  expect(uploadEncryptedBlob).toHaveBeenCalledWith('blob:https://air.example/private', 'text/plain', 'did:recipient');
});
it('private limit is relay limit even when public IPFS could accept larger files', async () => {
  jest.clearAllMocks();
  expect(await uploadMediaToCid('blob:https://air.example/large', { sizeBytes: MAX_BLOB_BYTES + 1, ipfsMaxBytes: 50_000_000 })).toEqual({ ok: false, reason: 'oversize', limitBytes: MAX_BLOB_BYTES });
  expect(addToIpfs).not.toHaveBeenCalled();
  expect(uploadEncryptedBlob).not.toHaveBeenCalled();
});

it.each(['ios', 'android', 'web'])('private %s upload never falls back to plaintext IPFS when relay fails', async (platform) => {
  jest.clearAllMocks();
  const previous = Platform.OS;
  Object.assign(Platform, { OS: platform });
  (uploadEncryptedBlob as jest.Mock).mockResolvedValueOnce(null);
  try {
    expect(await uploadMediaToCid('file:///private', { sizeBytes: 3 })).toEqual({ ok: false, reason: 'failed', limitBytes: MAX_BLOB_BYTES });
    expect(addToIpfs).not.toHaveBeenCalled();
  } finally { Object.assign(Platform, { OS: previous }); }
});
