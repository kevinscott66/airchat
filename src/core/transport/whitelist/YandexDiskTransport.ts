/**
 * Зашифрованный транспорт через Яндекс.Диск (REST API).
 * Файлы — непрозрачные blob; Яндекс не может извлечь plaintext без ключа.
 */
import type { KeyPairBytes } from '../../crypto/keyManager';
import { log } from '../../logger';
import { EncryptedWhitelistTransport } from './EncryptedWhitelistTransport';

export type YandexDiskConfig = {
  token: string;
  /** Базовый каталог, например /airchat */
  basePath?: string;
  /** Папка входящих для receiveRaw */
  incomingPath?: string;
};

const API = 'https://cloud-api.yandex.net/v1/disk';

export class YandexDiskTransport extends EncryptedWhitelistTransport {
  private readonly config: YandexDiskConfig;

  constructor(pair: KeyPairBytes, config: YandexDiskConfig) {
    super(pair);
    this.config = config;
  }

  private authHeaders(): HeadersInit {
    return { Authorization: `OAuth ${this.config.token}` };
  }

  protected async sendRaw(encryptedData: string, recipientId: string): Promise<boolean> {
    try {
      const base = (this.config.basePath ?? '/airchat').replace(/\/$/, '');
      const filename = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.json`;
      const path = `${base}/${recipientId}/${filename}`;
      const uploadUrl = await this.getUploadUrl(path);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encryptedData,
      });
      if (!res.ok) {
        log.warn('yandex_upload_http', { status: res.status });
        return false;
      }
      return true;
    } catch (e) {
      log.warn('yandex_send_failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  protected async receiveRaw(): Promise<{ data: string; fromId: string } | null> {
    try {
      const incoming = this.config.incomingPath ?? '/airchat/incoming';
      const listUrl = `${API}/resources?path=${encodeURIComponent(incoming)}&limit=20`;
      const listRes = await fetch(listUrl, { headers: this.authHeaders() });
      if (!listRes.ok) return null;
      const listJson = (await listRes.json()) as {
        _embedded?: { items?: Array<{ path: string; type: string; name: string }> };
      };
      const items = listJson._embedded?.items?.filter((i) => i.type === 'file') ?? [];
      if (items.length === 0) return null;
      const file = items.sort((a, b) => a.path.localeCompare(b.path))[0];
      const text = await this.downloadFileText(file.path);
      await this.deleteResource(file.path);
      const parts = file.path.split('/').filter(Boolean);
      const fromId = parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
      // v4.32.201 (Round-31 #6): strict DID regex on path-derived sender.
      // A compromised Yandex token or attacker-written file at
      // /<recipient>/../victimDid/msg_*.json would otherwise yield a spoofed
      // fromId used downstream as sender identity.
      if (!/^did:[a-z0-9]+:[A-Za-z0-9._-]{1,128}$/.test(fromId)) {
        log.warn('yandex_receive_bad_fromid', {});
        return null;
      }
      return { data: text, fromId };
    } catch (e) {
      log.warn('yandex_receive_failed', { err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async getUploadUrl(path: string): Promise<string> {
    const url = `${API}/resources/upload?path=${encodeURIComponent(path)}&overwrite=true`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`upload url ${res.status}`);
    const j = (await res.json()) as { href?: string };
    if (!j.href) throw new Error('no href');
    return j.href;
  }

  private async downloadFileText(path: string): Promise<string> {
    const url = `${API}/resources/download?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`download meta ${res.status}`);
    const j = (await res.json()) as { href?: string };
    if (!j.href) throw new Error('no download href');
    const fileRes = await fetch(j.href);
    if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
    return fileRes.text();
  }

  private async deleteResource(path: string): Promise<void> {
    const url = `${API}/resources?path=${encodeURIComponent(path)}&permanently=true`;
    await fetch(url, { method: 'DELETE', headers: this.authHeaders() });
  }
}
