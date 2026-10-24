const mockNativeFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: mockNativeFetch }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import { Platform } from 'react-native';
import { AttachmentBodyLimitError, fetchAttachmentResponse, readBoundedAttachmentBody } from '../boundedAttachmentResponse';

function stream(chunks: number[][], length: string | null = null) {
  const reader = { read: jest.fn(async () => chunks.length ? { done: false, value: new Uint8Array(chunks.shift()!) } : { done: true }), cancel: jest.fn(async () => {}), releaseLock: jest.fn() };
  const body = { getReader: () => reader, cancel: jest.fn(async () => {}) };
  return { reader, response: { ok: true, status: 200, body, headers: { get: () => length } } as unknown as Response };
}
it.each([null, '1'])('caps chunked bytes with missing/underreported length %s', async (length) => {
  const { reader, response } = stream([[1, 2], [3, 4], [5, 6], [7]], length);
  const controller = new AbortController();
  await expect(readBoundedAttachmentBody(response, 5, controller)).rejects.toBeInstanceOf(AttachmentBodyLimitError);
  expect(reader.read).toHaveBeenCalledTimes(3);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(controller.signal.aborted).toBe(true);
});
it('rejects declared excess before consuming body', async () => {
  const { reader, response } = stream([[1]], '99');
  await expect(readBoundedAttachmentBody(response, 5, new AbortController())).rejects.toBeInstanceOf(AttachmentBodyLimitError);
  expect(reader.read).not.toHaveBeenCalled();
  expect(response.body!.cancel).toHaveBeenCalled();
});
it('accepts exact cap and joins real chunks', async () => {
  const { response } = stream([[1, 2], [], [3, 4, 5]]);
  expect(await readBoundedAttachmentBody(response, 5, new AbortController())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
});
it('does not fall back to unbounded text when streaming unavailable', async () => {
  const text = jest.fn();
  await expect(readBoundedAttachmentBody({ headers: { get: () => null }, body: null, text } as unknown as Response, 5, new AbortController())).rejects.toThrow('stream_unavailable');
  expect(text).not.toHaveBeenCalled();
});
it('aborts and cancels a stalled stream at the caller deadline', async () => {
  const { reader, response } = stream([]);
  reader.read.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = readBoundedAttachmentBody(response, 5, controller);
  controller.abort();
  await expect(pending).rejects.toThrow('download_aborted');
  expect(reader.cancel).toHaveBeenCalled();
});
it.each(['web', 'ios', 'android'])('uses redirect:error and no credentials on %s', async (platform) => {
  Object.assign(Platform, { OS: platform });
  const { response } = stream([[1]]);
  const web = jest.fn(async () => response);
  global.fetch = web;
  mockNativeFetch.mockReset().mockResolvedValue(response);
  const signal = new AbortController().signal;
  expect(await fetchAttachmentResponse('https://ntfy.sh/file/1', signal)).toBe(response);
  const selected = platform === 'web' ? web : mockNativeFetch;
  expect(selected).toHaveBeenCalledWith('https://ntfy.sh/file/1', { signal, redirect: 'error', credentials: 'omit' });
  if (platform !== 'web') expect(web).not.toHaveBeenCalled();
});
it('rejects a transport reporting redirect without reading its body', async () => {
  Object.assign(Platform, { OS: 'web' });
  const { reader, response } = stream([[1]]);
  global.fetch = jest.fn(async () => ({ ...response, redirected: true })) as unknown as typeof fetch;
  await expect(fetchAttachmentResponse('https://ntfy.sh/file/1', new AbortController().signal)).rejects.toThrow('redirect_rejected');
  expect(reader.read).not.toHaveBeenCalled();
  expect(response.body!.cancel).toHaveBeenCalled();
});
