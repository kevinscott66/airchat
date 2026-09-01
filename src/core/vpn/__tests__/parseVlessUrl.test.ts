/**
 * Unit tests for parseVlessUrl — the share-link parser that lets a user paste a
 * provider's `vless://` URL instead of hand-typing eight Reality fields.
 *
 * A wrong parse silently produces a half-configured tunnel that fails to start
 * (the controller then logs `airchat_vpn_incomplete_config`), so we lock the
 * happy path plus the fiddly edges: IPv6 authority, missing/extra query params,
 * URL-encoded values, fragment label, and the reject cases that must return
 * null rather than a bogus partial.
 *
 * Pure function, no mocks.
 */
import { parseVlessUrl } from '../parseVlessUrl';

const FULL =
  'vless://11111111-2222-3333-4444-555555555555@example.com:8443' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality' +
  '&sni=microsoft.com&fp=chrome&pbk=PUBKEY123&sid=ab12&type=tcp#My%20Server';

describe('parseVlessUrl — happy path', () => {
  it('extracts every Reality field from a full share link', () => {
    expect(parseVlessUrl(FULL)).toEqual({
      uuid: '11111111-2222-3333-4444-555555555555',
      address: 'example.com',
      port: 8443,
      flow: 'xtls-rprx-vision',
      sni: 'microsoft.com',
      publicKey: 'PUBKEY123',
      shortId: 'ab12',
      fingerprint: 'chrome',
      label: 'My Server',
    });
  });

  it('tolerates surrounding whitespace and an uppercase scheme', () => {
    const r = parseVlessUrl('  VLESS://uuid-x@1.2.3.4:443?pbk=K&sid=S  ');
    expect(r).toMatchObject({ uuid: 'uuid-x', address: '1.2.3.4', port: 443, publicKey: 'K', shortId: 'S' });
  });

  it('omits absent optional params rather than setting empty strings', () => {
    const r = parseVlessUrl('vless://u@host:443');
    expect(r).toEqual({ uuid: 'u', address: 'host', port: 443 });
    expect(r).not.toHaveProperty('flow');
    expect(r).not.toHaveProperty('publicKey');
  });

  it('parses an IPv6 bracketed authority', () => {
    const r = parseVlessUrl('vless://u@[2001:db8::1]:8443?pbk=K');
    expect(r).toMatchObject({ address: '2001:db8::1', port: 8443, publicKey: 'K' });
  });

  it('URL-decodes encoded param values and the label', () => {
    const r = parseVlessUrl('vless://u@host:443?sni=a%2Eb%2Ecom#%D0%9C%D0%BE%D0%B9');
    expect(r?.sni).toBe('a.b.com');
    expect(r?.label).toBe('Мой');
  });

  it('ignores unknown query parameters', () => {
    const r = parseVlessUrl('vless://u@host:443?foo=bar&pbk=K&headerType=none');
    expect(r).toMatchObject({ uuid: 'u', address: 'host', port: 443, publicKey: 'K' });
    expect(r).not.toHaveProperty('foo');
  });
});

describe('parseVlessUrl — reject cases (null, never a bogus partial)', () => {
  it.each([
    ['not a vless link', 'https://example.com:443'],
    ['empty string', ''],
    ['missing userinfo (@)', 'vless://host:443?pbk=K'],
    ['empty uuid', 'vless://@host:443'],
    ['missing port', 'vless://u@host?pbk=K'],
    ['non-numeric port', 'vless://u@host:abc'],
    ['out-of-range port', 'vless://u@host:70000'],
    ['unterminated IPv6 bracket', 'vless://u@[2001:db8::1:8443'],
  ])('returns null for %s', (_label, url) => {
    expect(parseVlessUrl(url)).toBeNull();
  });

  it('returns null for a non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVlessUrl(undefined as any)).toBeNull();
  });
});
