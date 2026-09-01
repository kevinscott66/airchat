/**
 * Зашифрованный транспорт через VK API (messages.send / messages.getHistory).
 * Текст сообщения — только opaque JSON/Base64; VK не расшифровывает.
 * Ограничение: одно сообщение ≤ ~3900 символов (иначе отправка отклоняется).
 */
import type { KeyPairBytes } from '../../crypto/keyManager';
import { log } from '../../logger';
import { EncryptedWhitelistTransport } from './EncryptedWhitelistTransport';

export type VKConfig = {
  token: string;
  /** Числовой peer_id собеседника для receiveRaw (диалог). */
  peerId?: string;
};

const PREFIX = 'ACENC1:';
const MAX_VK_MSG = 3900;

export class VKTransport extends EncryptedWhitelistTransport {
  private readonly config: VKConfig;
  private readonly baseUrl = 'https://api.vk.com/method';

  constructor(pair: KeyPairBytes, config: VKConfig) {
    super(pair);
    this.config = config;
  }

  protected async sendRaw(encryptedData: string, recipientId: string): Promise<boolean> {
    try {
      // v4.32.204 (Round-34 #4): require numeric peer_id. Non-numeric would
      // be VK-API noise at best; worse, future base-URL templates could make
      // this an SSRF vector.
      if (!/^-?\d{1,20}$/.test(recipientId)) {
        log.warn('vk_send_bad_peer_id', {});
        return false;
      }
      const body = `${PREFIX}${encryptedData}`;
      if (body.length > MAX_VK_MSG) {
        log.warn('vk_payload_too_long', { len: body.length, max: MAX_VK_MSG });
        return false;
      }
      const params = new URLSearchParams({
        access_token: this.config.token,
        peer_id: recipientId,
        message: body,
        random_id: String(Date.now()),
        v: '5.131',
      });
      const res = await fetch(`${this.baseUrl}/messages.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const json = (await res.json()) as { error?: { error_msg: string }; response?: number };
      if (json.error) {
        log.warn('vk_api_error', { msg: json.error.error_msg });
        return false;
      }
      return true;
    } catch (e) {
      log.warn('vk_send_failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  protected async receiveRaw(): Promise<{ data: string; fromId: string } | null> {
    try {
      const peerId = this.config.peerId?.trim();
      if (!peerId) {
        log.warn('vk_receive_no_peer', {});
        return null;
      }
      const url = `${this.baseUrl}/messages.getHistory?access_token=${encodeURIComponent(
        this.config.token
      )}&peer_id=${encodeURIComponent(peerId)}&count=10&v=5.131`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        error?: { error_msg: string };
        response?: { items?: Array<{ text?: string; from_id?: number }> };
      };
      if (json.error || !json.response?.items?.length) return null;
      for (const msg of json.response.items) {
        const t = msg.text?.trim() ?? '';
        if (!t.startsWith(PREFIX)) continue;
        const data = t.slice(PREFIX.length);
        // v4.32.204 (Round-34 #3): cap raw body before handing to decrypt
        // layer. VK server (or compromised account) can otherwise return
        // arbitrary large text; EncryptedWhitelistTransport caps at 256KB
        // but peer crypto work happens before that check.
        if (data.length > 256 * 1024) continue;
        return { data, fromId: String(msg.from_id ?? peerId) };
      }
      return null;
    } catch (e) {
      log.warn('vk_receive_failed', { err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}
