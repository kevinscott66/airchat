/**
 * Образовательный модуль: зашифрованный транспорт через официальные API из белого списка.
 * Сервис видит только ciphertext (Base64), не plaintext.
 */
import { Buffer } from 'buffer';
import type { KeyPairBytes } from '../../crypto/keyManager';
import { log } from '../../logger';
import { publicKeyToDidKey } from '../../identity/did';
import { encryptWhitelistUtf8, decryptWhitelistUtf8 } from './whitelistCrypto';

export type EncryptedWhitelistPayloadV1 = {
  v: 1;
  /** Base64: nonce || ciphertext (формат encryptSymmetric) */
  ct: string;
  senderDid: string;
  recipientDid: string;
  ts: number;
};

export abstract class EncryptedWhitelistTransport {
  protected readonly pair: KeyPairBytes;

  constructor(pair: KeyPairBytes) {
    this.pair = pair;
  }

  protected abstract sendRaw(data: string, recipientServiceId: string): Promise<boolean>;

  protected abstract receiveRaw(): Promise<{ data: string; fromId: string } | null>;

  async send(plaintext: string, recipientDid: string, recipientServiceId: string): Promise<boolean> {
    try {
      const myDid = publicKeyToDidKey(this.pair.publicKey);
      const enc = encryptWhitelistUtf8(this.pair, recipientDid, plaintext);
      if (!enc) {
        log.warn('whitelist_encrypt_failed', { transport: this.constructor.name });
        return false;
      }
      const payload: EncryptedWhitelistPayloadV1 = {
        v: 1,
        ct: Buffer.from(enc).toString('base64'),
        senderDid: myDid,
        recipientDid,
        ts: Date.now(),
      };
      const ok = await this.sendRaw(JSON.stringify(payload), recipientServiceId);
      log.info('whitelist_transport_send', {
        transport: this.constructor.name,
        ok,
        recipientDid,
      });
      return ok;
    } catch (e) {
      log.warn('whitelist_transport_send_err', {
        transport: this.constructor.name,
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * Получить и расшифровать одно сообщение (отправитель в payload).
   */
  async receiveMessage(): Promise<{ text: string; senderDid: string } | null> {
    try {
      const raw = await this.receiveRaw();
      if (!raw) return null;
      // v4.32.200 (Round-30 #4): cap frame + strict field-shape before
      // Buffer.from(base64) allocation. Without these, a 100MB base64 string
      // forces a huge allocation before decryption rejects it.
      if (typeof raw.data !== 'string' || raw.data.length > 256 * 1024) return null;
      const payload = JSON.parse(raw.data) as EncryptedWhitelistPayloadV1;
      if (payload.v !== 1) return null;
      if (typeof payload.ct !== 'string' || payload.ct.length === 0 || payload.ct.length > 180 * 1024) return null;
      if (typeof payload.senderDid !== 'string' || payload.senderDid.length === 0 || payload.senderDid.length > 512) return null;
      if (typeof payload.recipientDid !== 'string' || payload.recipientDid.length === 0 || payload.recipientDid.length > 512) return null;
      // v4.32.202 (Round-32 #5): strict DID regex parity with internetTransport.
      // A hostile VK/MailRu relay can otherwise return a payload with
      // arbitrary senderDid used as identity by callers downstream.
      const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._-]{1,128}$/;
      if (!DID_RE.test(payload.senderDid) || !DID_RE.test(payload.recipientDid)) return null;
      if (payload.ts != null && (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts))) return null;
      const myDid = publicKeyToDidKey(this.pair.publicKey);
      if (payload.recipientDid !== myDid) {
        log.warn('whitelist_recipient_mismatch', {});
        return null;
      }
      const blob = new Uint8Array(Buffer.from(payload.ct, 'base64'));
      const text = decryptWhitelistUtf8(this.pair, payload.senderDid, blob);
      if (text == null) {
        log.warn('whitelist_decrypt_failed', { transport: this.constructor.name });
        return null;
      }
      log.info('whitelist_transport_receive', {
        transport: this.constructor.name,
        senderDid: payload.senderDid,
      });
      return { text, senderDid: payload.senderDid };
    } catch (e) {
      log.warn('whitelist_transport_receive_err', {
        transport: this.constructor.name,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
}
