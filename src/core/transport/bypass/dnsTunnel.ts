/**
 * Заглушка «DNS-туннель».
 *
 * Передача полезной нагрузки через публичные DoH/имена зон — злоупотребление инфраструктурой
 * и нарушение типичных ToS. Не реализовано намеренно.
 */
export class DNSTunnelTransport {
  async send(_data: Uint8Array, _targetDid: string): Promise<boolean> {
    return false;
  }

  async receive(): Promise<Uint8Array | null> {
    return null;
  }

  async checkAvailability(): Promise<boolean> {
    return false;
  }
}
