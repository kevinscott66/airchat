import { Platform } from 'react-native';
import AirChatVpn from 'airchat-vpn';
import type { AppConfig } from '../config';
import { log } from '../logger';
import { buildXrayMobileClientJson } from './buildXrayConfig';

export type AirChatVpnUiStatus = 'off' | 'starting' | 'on' | 'unsupported' | 'failed';

export async function maybeStartEmbeddedVpn(
  cfg: AppConfig,
  opts?: { force?: boolean }
): Promise<AirChatVpnUiStatus> {
  const v = cfg.vpn;
  if (!v?.enabled) {
    return 'off';
  }
  if (!opts?.force && !v.autoStart) {
    return 'off';
  }
  if (!v.address?.trim() || !v.uuid?.trim() || !v.publicKey?.trim() || !v.shortId?.trim()) {
    log.warn('airchat_vpn_incomplete_config');
    return 'failed';
  }
  if (v.mtproto?.enabled) {
    log.warn('vpn_mtproto_not_implemented', {
      note: 'MTProto proxy requires a native stack; use VLESS backup + SOCKS fallback instead.',
    });
  }
  if (Platform.OS !== 'android') {
    return 'unsupported';
  }
  const mod = AirChatVpn;
  if (!mod) {
    log.warn('airchat_vpn_module_missing');
    return 'unsupported';
  }
  try {
    const sup = await mod.isSupported();
    if (!sup) return 'unsupported';
  } catch {
    return 'unsupported';
  }

  const json = buildXrayMobileClientJson(cfg);
  const port = v.localSocksPort ?? 10809;
  try {
    const ok = await mod.start(json, port);
    return ok ? 'on' : 'failed';
  } catch (e) {
    log.warn('airchat_vpn_start_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

export async function stopEmbeddedVpn(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const mod = AirChatVpn;
  if (!mod) return;
  try {
    await mod.stop();
  } catch (e) {
    log.warn('airchat_vpn_stop_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function getEmbeddedVpnRunning(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = AirChatVpn;
  if (!mod) return false;
  try {
    return await mod.isRunning();
  } catch {
    return false;
  }
}

/** Остановить и несколько раз повторить старт (кнопка «Повторить»). */
export async function retryEmbeddedVpn(cfg: AppConfig): Promise<AirChatVpnUiStatus> {
  const v = cfg.vpn;
  if (!v?.enabled) {
    return 'off';
  }
  await stopEmbeddedVpn();
  const max = Math.max(1, v.startRetries ?? 3);
  const delayMs = v.retryDelayMs ?? 2000;
  let last: AirChatVpnUiStatus = 'failed';
  for (let i = 0; i < max; i++) {
    last = await maybeStartEmbeddedVpn(cfg, { force: true });
    if (last === 'on' || last === 'unsupported') {
      return last;
    }
    if (last === 'off') {
      return last;
    }
    if (i < max - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}
