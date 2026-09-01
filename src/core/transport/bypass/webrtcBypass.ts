/**
 * Заглушка «WebRTC bypass».
 *
 * Для реального P2P используйте существующий стек `src/core/transport/webrtc/` и signaling.
 */
export class WebRTCBypassTransport {
  async send(_data: Uint8Array, _targetDid: string): Promise<boolean> {
    void _data;
    void _targetDid;
    return false;
  }

  async checkAvailability(): Promise<boolean> {
    return false;
  }
}
