import { downloadWebAttachment } from '../downloadWebAttachment';

it('downloads bytes as a file without navigating, and revokes the URL after Safari can consume it', () => {
  jest.useFakeTimers();
  const originalDocument = global.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const anchor = { href: '', download: '', style: { display: '' }, click: jest.fn(), remove: jest.fn() };
  const create = jest.fn(() => 'blob:download');
  const revoke = jest.fn();
  const append = jest.fn();
  global.document = { createElement: jest.fn(() => anchor), body: { appendChild: append } } as unknown as Document;
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  try {
    downloadWebAttachment('aGVsbG8=', '../отчёт.txt');
    expect(create.mock.calls).toHaveLength(1);
    expect((create.mock.calls[0] as unknown as [Blob])[0].type).toBe('application/octet-stream');
    expect(anchor.href).toBe('blob:download');
    expect(anchor.download).toBe('.._отчёт.txt');
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:download');
    expect(() => downloadWebAttachment('', 'empty')).toThrow('empty_attachment');
  } finally {
    global.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    jest.useRealTimers();
  }
});
