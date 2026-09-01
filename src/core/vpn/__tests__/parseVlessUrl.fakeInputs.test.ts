/**
 * "What happens if a user pastes a FAKE or INVALID vless:// link?"
 *
 * This is a behaviour-demonstration suite, written in answer to exactly that
 * question. It exercises the layered defence the app has against bad input:
 *
 *   Layer 1 — parseVlessUrl(): garbage in → `null` out. The UI catches the null
 *             and shows «Не удалось разобрать ссылку. Проверьте формат vless://».
 *             Nothing is ever saved.
 *
 *   Layer 2 — the "looks valid but is incomplete" trap. Some strings DO parse
 *             (they have uuid@host:port) yet omit the Reality crypto params
 *             (pbk/sid). The parser cannot reject these — they are structurally
 *             fine — so it returns a partial object. The Save-time validation in
 *             VpnSettingsSection is what stops them («Заполните адрес, UUID,
 *             publicKey и shortId»), and the VPN controller's own
 *             `airchat_vpn_incomplete_config` check is the final backstop.
 *
 * The point of the suite is to make that two-layer behaviour explicit and
 * regression-proof: no fake link may ever silently become a saved, half-broken
 * tunnel.
 *
 * Pure function, no mocks.
 */
import { parseVlessUrl } from '../parseVlessUrl';

/** Reality config is only usable if all four of these are present. */
const isUsableRealityConfig = (
  p: ReturnType<typeof parseVlessUrl>,
): boolean =>
  !!p && !!p.address && !!p.uuid && !!p.publicKey && !!p.shortId;

describe('FAKE / garbage links → parser returns null (Layer 1)', () => {
  // Each entry is something a confused or malicious user might paste.
  it.each([
    ['plain typo, no scheme at all', 'just some text'],
    ['a normal website URL', 'https://google.com'],
    ['http with creds-looking junk', 'http://user:pass@host:443'],
    ['right host shape, wrong scheme', 'vmess://u@host:443?pbk=K&sid=S'],
    ['scheme only', 'vless://'],
    ['scheme + slashes only', 'vless://   '],
    ['no @ separator', 'vless://example.com:443?pbk=K&sid=S'],
    ['empty uuid before @', 'vless://@example.com:443?pbk=K&sid=S'],
    ['no port', 'vless://uuid@example.com?pbk=K&sid=S'],
    ['port is letters', 'vless://uuid@example.com:https'],
    ['port = 0', 'vless://uuid@example.com:0'],
    ['port out of range', 'vless://uuid@example.com:99999'],
    ['negative port', 'vless://uuid@example.com:-443'],
    ['unterminated IPv6 bracket', 'vless://uuid@[2001:db8::1:443'],
    ['emoji soup', '🦊🔒vless😈'],
  ])('rejects (%s) → null', (_why, link) => {
    const parsed = parseVlessUrl(link);
    expect(parsed).toBeNull();
    // Because it is null, isUsableRealityConfig is false → UI shows the
    // "could not parse" error and saves nothing.
    expect(isUsableRealityConfig(parsed)).toBe(false);
  });

  it('also rejects non-string inputs without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVlessUrl(null as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVlessUrl(42 as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseVlessUrl({} as any)).toBeNull();
  });
});

describe('SNEAKY links: parse OK but are incomplete (Layer 2)', () => {
  it('a bare uuid@host:port parses, but is NOT a usable Reality config', () => {
    const parsed = parseVlessUrl('vless://uuid-1@example.com:443');
    // Structurally valid — parser cannot reject it.
    expect(parsed).toEqual({ uuid: 'uuid-1', address: 'example.com', port: 443 });
    // But the crypto params are missing, so Save-time validation must block it.
    expect(isUsableRealityConfig(parsed)).toBe(false);
  });

  it('a link with pbk but no sid is still incomplete', () => {
    const parsed = parseVlessUrl('vless://uuid-1@example.com:443?pbk=K');
    expect(parsed).toMatchObject({ uuid: 'uuid-1', address: 'example.com', port: 443, publicKey: 'K' });
    expect(parsed?.shortId).toBeUndefined();
    expect(isUsableRealityConfig(parsed)).toBe(false); // missing sid
  });

  it('a link with sid but no pbk is still incomplete', () => {
    const parsed = parseVlessUrl('vless://uuid-1@example.com:443?sid=ab12');
    expect(parsed).toMatchObject({ uuid: 'uuid-1', address: 'example.com', port: 443, shortId: 'ab12' });
    expect(parsed?.publicKey).toBeUndefined();
    expect(isUsableRealityConfig(parsed)).toBe(false); // missing pbk
  });

  it('ONLY a link carrying uuid+host+port+pbk+sid counts as usable', () => {
    const parsed = parseVlessUrl('vless://uuid-1@example.com:443?pbk=K&sid=ab12');
    expect(isUsableRealityConfig(parsed)).toBe(true);
  });
});
