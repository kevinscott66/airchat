/**
 * The embedded channel is a local SOCKS proxy, not a device-wide VpnService.
 * These tests lock down the boundary where a routed request could otherwise
 * silently fall back to React Native fetch and disclose the user's IP.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('airchat-vpn', () => ({
  isRunning: jest.fn(async () => true),
  fetchGet: jest.fn(async () => ({ ok: true, status: 200, bodyBase64: 'b2s=' })),
  postMultipartFile: jest.fn(),
}));
jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({ vpn: { enabled: true, routeHttp: true } })),
}));
jest.mock('../../logger', () => ({ log: { warn: jest.fn() } }));

import {
  fetchWithEmbeddedVpnIfNeeded,
  isPrivateOrLoopbackHost,
  shouldRouteUrlThroughVpn,
} from '../ipfsFetch';
import AirChatVpn from 'airchat-vpn';
import { Platform } from 'react-native';

const mockNative = AirChatVpn as unknown as {
  isRunning: jest.Mock;
  fetchGet: jest.Mock;
  postMultipartFile: jest.Mock;
};

describe('embedded SOCKS privacy boundary', () => {
  const realFetch = global.fetch;
  const directFetch = jest.fn(async () => new Response('direct'));

  beforeEach(() => {
    mockNative.isRunning.mockClear();
    mockNative.fetchGet.mockClear();
    directFetch.mockClear();
    global.fetch = directFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it.each([
    'localhost', 'api.local', '127.0.0.1', '10.1.2.3', '172.16.0.1',
    '192.168.1.1', '169.254.1.1', '[::1]', '[fe80::1]', '[fd00::1]',
  ])('does not send local address %s to the remote SOCKS channel', (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it('does route a public hostname that merely starts with an IPv6 prefix', async () => {
    expect(Platform.OS).toBe('android');
    expect(AirChatVpn).toBe(mockNative);
    expect(isPrivateOrLoopbackHost('fcm.googleapis.com')).toBe(false);
    await expect(shouldRouteUrlThroughVpn('https://fcm.googleapis.com/fcm/send')).resolves.toBe(true);
  });

  it('uses SOCKS for GET with no direct-fallback permission', async () => {
    const response = await fetchWithEmbeddedVpnIfNeeded('https://gateway.example/ipfs/cid');

    await expect(response.text()).resolves.toBe('ok');
    expect(mockNative.fetchGet).toHaveBeenCalledWith('https://gateway.example/ipfs/cid', false);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('fails closed for a routed method that the native proxy cannot support', async () => {
    const response = await fetchWithEmbeddedVpnIfNeeded('https://gateway.example/api/v0/add', {
      method: 'POST', body: 'payload',
    });

    expect(response.status).toBe(503);
    expect(mockNative.fetchGet).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });
});
