jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => { throw new Error('native FS unavailable'); },
  readAsStringAsync: jest.fn(async () => { throw new Error('native FS unavailable'); }),
}));
jest.mock('../../logger', () => ({ log: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => true }));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: jest.fn(async () => 'bafy-test') }));
jest.mock('../readWebAttachment', () => ({ readWebAttachment: jest.fn(async () => ({ ok: true, b64: 'AQID', size: 3, mime: 'image/png' })) }));
import * as FS from 'expo-file-system/legacy';
import { uploadMediaToCid } from '../mediaUpload';
import { addToIpfs } from '../../transport/ipfs/node';
import { readWebAttachment } from '../readWebAttachment';

it('browser group/document upload reads picker URL and reports actual byte size', async () => {
  expect(await uploadMediaToCid('data:image/png;base64,AQID')).toEqual({ ok: true, cid: 'bafy-test', sizeBytes: 3 });
  expect(addToIpfs).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  expect(FS.readAsStringAsync).not.toHaveBeenCalled();
});
it('rejects oversized picker data before IPFS upload', async () => {
  jest.clearAllMocks();
  (readWebAttachment as jest.Mock).mockResolvedValueOnce({ ok: false, reason: 'oversize' });
  expect(await uploadMediaToCid('blob:https://air.example/picker', { ipfsMaxBytes: 12 })).toEqual({ ok: false, reason: 'oversize', limitBytes: 12 });
  expect(addToIpfs).not.toHaveBeenCalled();
});
