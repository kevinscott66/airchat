import { Buffer } from 'buffer';
import { readWebAttachment } from '../readWebAttachment';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');
const readBytes = jest.fn(async () => Uint8Array.from(png).buffer);

beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockReset();
  readBytes.mockClear();
  fetchMock.mockResolvedValue({
    ok: true,
    blob: async () => ({ size: png.length, type: 'image/png', arrayBuffer: readBytes }),
  });
});
afterAll(() => { global.fetch = originalFetch; });

it.each(['blob:https://example.com/picker-id', `data:image/png;base64,${png.toString('base64')}`])(
  'reads picker URL %s without native filesystem or filename MIME guessing', async (uri) => {
    expect(await readWebAttachment(uri, 1024)).toEqual({
      ok: true, b64: png.toString('base64'), mime: 'image/png', size: png.length,
    });
    expect(fetchMock).toHaveBeenCalledWith(uri, { credentials: 'omit' });
  },
);

it('checks actual blob size before allocating the binary/base64 copy', async () => {
  expect(await readWebAttachment('blob:https://example.com/picker-id', png.length - 1))
    .toEqual({ ok: false, reason: 'oversize' });
  expect(readBytes).not.toHaveBeenCalled();
});
it('rejects oversized data payload before decoding it', async () => {
  expect(await readWebAttachment('data:image/png;base64,AAAAAAAA', 3))
    .toEqual({ ok: false, reason: 'oversize' });
  expect(fetchMock).not.toHaveBeenCalled();
});
it('allows exact size boundary', async () => {
  expect((await readWebAttachment('blob:https://example.com/picker-id', png.length)).ok).toBe(true);
});
it.each(['https://example.com/private', 'file:///private/file', 'data:broken'])(
  'does not fetch arbitrary or invalid URL %s', async (uri) => {
    expect(await readWebAttachment(uri, 1024)).toEqual({ ok: false, reason: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('reports revoked picker URLs as unreadable, not oversize', async () => {
  fetchMock.mockRejectedValue(new TypeError('revoked'));
  expect(await readWebAttachment('blob:https://example.com/gone', 1024))
    .toEqual({ ok: false, reason: 'failed' });
});
it('does not publish empty media', async () => {
  fetchMock.mockResolvedValue({ ok: true, blob: async () => ({ size: 0, arrayBuffer: readBytes }) });
  expect(await readWebAttachment('blob:https://example.com/empty', 1024))
    .toEqual({ ok: false, reason: 'failed' });
  expect(readBytes).not.toHaveBeenCalled();
});
