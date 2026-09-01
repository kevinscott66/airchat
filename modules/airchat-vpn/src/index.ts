import { requireOptionalNativeModule } from 'expo-modules-core';

export type AirChatVpnNative = {
  isSupported: () => Promise<boolean>;
  start: (configJson: string, localSocksPort: number) => Promise<boolean>;
  stop: () => Promise<boolean>;
  isRunning: () => Promise<boolean>;
  /** GET через SOCKS (127.0.0.1:localPort) — только когда Xray запущен */
  fetchGet: (
    url: string,
    allowDirectFallback?: boolean
  ) => Promise<{ ok: boolean; status: number; bodyBase64: string }>;
  /** multipart/form-data POST с одним файлом (путь file://) */
  postMultipartFile: (
    url: string,
    fileUri: string,
    fieldName?: string,
    allowDirectFallback?: boolean
  ) => Promise<{ ok: boolean; status: number; bodyText: string }>;
};

export default requireOptionalNativeModule<AirChatVpnNative | null>('AirChatVpn');
