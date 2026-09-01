/**
 * Заглушка «Domain Fronting».
 *
 * Реальный domain fronting зависит от CDN/провайдера и TLS; подмена Host в `fetch` к чужим
 * доменам без согласования — небезопасна и часто невозможна в RN. Не реализовано намеренно.
 */
export class DomainFrontingTransport {
  async send(_data: Uint8Array, _targetDid: string): Promise<boolean> {
    return false;
  }

  async checkAvailability(): Promise<boolean> {
    return false;
  }
}
