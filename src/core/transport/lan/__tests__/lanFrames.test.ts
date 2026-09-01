/**
 * Unit tests for LAN binary framing (encode ↔ decode round-trip, accumulator, edge cases).
 */
import { encodeLanFrame, LanFrameAccumulator } from '../lanFrames';

describe('LanFrameAccumulator', () => {
  test('round-trips a single frame delivered at once', () => {
    const acc = new LanFrameAccumulator();
    const did = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const payload = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
    const frame = encodeLanFrame(did, payload);

    const results = acc.append(frame);
    expect(results).toHaveLength(1);
    expect(results[0].senderDid).toBe(did);
    expect(results[0].payload).toEqual(payload);
  });

  test('round-trips a frame delivered in two chunks', () => {
    const acc = new LanFrameAccumulator();
    const did = 'did:key:z6MksY62zEZ1h5ZS8BmCFRoC9EWREAaFU16P9oHiC1ViGP1V';
    const payload = new TextEncoder().encode('split frame payload');
    const frame = encodeLanFrame(did, payload);

    const half = Math.floor(frame.length / 2);
    const r1 = acc.append(frame.slice(0, half));
    expect(r1).toHaveLength(0); // incomplete

    const r2 = acc.append(frame.slice(half));
    expect(r2).toHaveLength(1);
    expect(r2[0].senderDid).toBe(did);
    expect(new TextDecoder().decode(r2[0].payload)).toBe('split frame payload');
  });

  test('parses two concatenated frames', () => {
    const acc = new LanFrameAccumulator();
    const did1 = 'did:key:z6MkA';
    const did2 = 'did:key:z6MkB';
    const p1 = new TextEncoder().encode('msg-1');
    const p2 = new TextEncoder().encode('msg-2');
    const combined = new Uint8Array([
      ...encodeLanFrame(did1, p1),
      ...encodeLanFrame(did2, p2),
    ]);

    const results = acc.append(combined);
    expect(results).toHaveLength(2);
    expect(results[0].senderDid).toBe(did1);
    expect(results[1].senderDid).toBe(did2);
  });

  test('skips invalid magic bytes without crashing', () => {
    const acc = new LanFrameAccumulator();
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const results = acc.append(garbage);
    expect(results).toHaveLength(0);
  });

  test('rejects frame claiming payload > 1 MB', () => {
    const acc = new LanFrameAccumulator();
    // Build a frame header with payloadLen = 2 MB
    const did = 'did:key:z1';
    const didBytes = new TextEncoder().encode(did);
    const header = new Uint8Array(4 + 1 + 2 + didBytes.length + 4);
    let o = 0;
    header.set([0x41, 0x43, 0x50, 0x54], o); o += 4; // magic
    header[o++] = 1; // version
    header[o++] = (didBytes.length >> 8) & 0xff;
    header[o++] = didBytes.length & 0xff;
    header.set(didBytes, o); o += didBytes.length;
    // payloadLen = 2_097_152 (2 MB) — well over 1 MB cap
    const plen = 2_097_152;
    new DataView(header.buffer, o, 4).setUint32(0, plen, false);

    const results = acc.append(header);
    expect(results).toHaveLength(0); // should be rejected, not crash
  });

  test('handles empty input', () => {
    const acc = new LanFrameAccumulator();
    expect(acc.append(new Uint8Array(0))).toHaveLength(0);
  });

  test('encodeLanFrame rejects did longer than 65535 bytes', () => {
    const longDid = 'x'.repeat(70000);
    expect(() => encodeLanFrame(longDid, new Uint8Array(1))).toThrow('lan_sender_did_too_long');
  });
});
