/**
 * ctlRetryPayload — служебные операции в очереди неотправленного (v4.32.431).
 *
 * Строка приходит из своей же базы, но разбирается как чужая: её мог оставить
 * предыдущий формат, и дальше она уходит собеседнику.
 */
import { parseCtlRetryPayload, serializeCtlRetryPayload } from '../ctlRetryPayload';

const PUB = 'A'.repeat(44);

describe('ctlRetryPayload', () => {
  it('удаление переживает круг сериализации', () => {
    const p = { op: 'delete', contactPubB64: PUB, targetMessageId: 'msg-1' } as const;
    expect(parseCtlRetryPayload(serializeCtlRetryPayload(p))).toEqual(p);
  });

  it('правка переживает круг сериализации вместе с текстом', () => {
    const p = { op: 'edit', contactPubB64: PUB, targetMessageId: 'msg-1', newText: 'исправил' } as const;
    expect(parseCtlRetryPayload(serializeCtlRetryPayload(p))).toEqual(p);
  });

  it('лишние поля в строке не попадают в разобранную нагрузку', () => {
    const raw = JSON.stringify({
      op: 'delete',
      contactPubB64: PUB,
      targetMessageId: 'msg-1',
      newText: 'этого тут быть не должно',
      somethingElse: 42,
    });
    expect(parseCtlRetryPayload(raw)).toEqual({ op: 'delete', contactPubB64: PUB, targetMessageId: 'msg-1' });
  });

  it('непригодная строка — null, а не половина нагрузки', () => {
    expect(parseCtlRetryPayload('не json')).toBeNull();
    expect(parseCtlRetryPayload('null')).toBeNull();
    expect(parseCtlRetryPayload('[]')).toBeNull();
    expect(parseCtlRetryPayload('"строка"')).toBeNull();
    // Неизвестная операция: молча выполнить «что-то похожее» нельзя.
    expect(parseCtlRetryPayload(JSON.stringify({ op: 'wipe', contactPubB64: PUB, targetMessageId: 'm' }))).toBeNull();
    expect(parseCtlRetryPayload(JSON.stringify({ contactPubB64: PUB, targetMessageId: 'm' }))).toBeNull();
  });

  it('ключ собеседника проверяется по длине', () => {
    const bad = (pub: string): string => JSON.stringify({ op: 'delete', contactPubB64: pub, targetMessageId: 'm' });
    expect(parseCtlRetryPayload(bad('короткий'))).toBeNull();
    expect(parseCtlRetryPayload(bad('A'.repeat(200)))).toBeNull();
    expect(parseCtlRetryPayload(bad('A'.repeat(43)))).not.toBeNull();
    expect(parseCtlRetryPayload(bad('A'.repeat(44)))).not.toBeNull();
  });

  it('id цели обязателен и непустой', () => {
    const raw = (id: unknown): string => JSON.stringify({ op: 'delete', contactPubB64: PUB, targetMessageId: id });
    expect(parseCtlRetryPayload(raw(''))).toBeNull();
    expect(parseCtlRetryPayload(raw(null))).toBeNull();
    expect(parseCtlRetryPayload(raw(123))).toBeNull();
    expect(parseCtlRetryPayload(raw('x'.repeat(129)))).toBeNull();
  });

  it('правка без текста отбрасывается, а не превращается в стирание', () => {
    const raw = (t: unknown): string =>
      JSON.stringify({ op: 'edit', contactPubB64: PUB, targetMessageId: 'm', newText: t });
    expect(parseCtlRetryPayload(raw(''))).toBeNull();
    expect(parseCtlRetryPayload(raw(undefined))).toBeNull();
    expect(parseCtlRetryPayload(raw(0))).toBeNull();
    expect(parseCtlRetryPayload(raw('x'.repeat(64_001)))).toBeNull();
    expect(parseCtlRetryPayload(raw('x'.repeat(64_000)))).not.toBeNull();
  });
});
