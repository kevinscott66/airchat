declare module 'react-native-zeroconf' {
  import type { EventEmitter } from 'events';

  export const ImplType: {
    readonly NSD: 'NSD';
    readonly DNSSD: 'DNSSD';
  };

  export type ZeroconfService = {
    name: string;
    host?: string;
    port: number;
    addresses?: string[];
    txt?: Record<string, string>;
  };

  export default class Zeroconf extends EventEmitter {
    scan(type?: string, protocol?: string, domain?: string, implType?: string): void;
    stop(implType?: string): void;
    publishService(
      type: string,
      protocol: string,
      domain: string,
      name: string,
      port: number,
      txt?: Record<string, string>,
      implType?: string
    ): void;
    unpublishService(name: string, implType?: string): void;
    removeDeviceListeners(): void;
    getServices(): Record<string, ZeroconfService>;
  }
}
