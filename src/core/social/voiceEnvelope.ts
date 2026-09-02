/**
 * voiceEnvelope — конверт голосового сообщения '\x01voice:'.
 *
 * v4.32.534. Кодек лежал в хвосте ChatScreen.tsx, а читали его четверо:
 * GroupsScreen, MediaStrip, GroupMessageInfoModal и сам экран диалога. Экран
 * стал для них бочкой ре-экспортов — импорт формата сообщений через файл с
 * версткой ленты. Соседние конверты (docEnvelope, locationEnvelope,
 * forwardEnvelope, contactCardEnvelope) уже переехали сюда по этой же
 * причине; этот остался последним.
 *
 * Проверки полей ниже — те же, что стояли в экране, вместе с их разбором.
 * Изменилось одно: общее начало разбора идёт через readEnvelopeBody, как у
 * всех соседей, — то есть у конверта появился потолок длины ДО JSON.parse,
 * которого у него не было (см. шапку envelopeBody.ts).
 */

import { isBlobRef, type BlobRef } from '../media/blobRef';
import { readEnvelopeBody } from './envelopeBody';

export const VOICE_PREFIX = '\x01voice:';

/**
 * Потолок всей строки до JSON.parse. Настоящий конверт — адрес до 2048
 * символов, число и необязательный blob-дескриптор (ключ base64 + адрес ntfy
 * + 32 hex): около трёх килобайт в самом худшем случае. Восьми хватает с
 * запасом, а мегабайтный текст от чужого клиента до JSON.parse не доходит.
 */
export const MAX_VOICE_ENVELOPE = 8192;

export function isVoiceMessage(text: string): boolean {
  return text.startsWith(VOICE_PREFIX);
}

export function parseVoiceMeta(text: string): { uri: string; durationMs: number; blob?: BlobRef } | null {
  // v4.32.190 (Round-20 #3): strict shape + http(s) allowlist on uri
  // (mirror GroupChatScreen v4.32.185) so a peer can't feed `file://`,
  // `data:`, `content://` into the audio player when mediaCids are
  // absent. durationMs must be a finite non-negative number.
  const o = readEnvelopeBody(text, VOICE_PREFIX, MAX_VOICE_ENVELOPE);
  if (!o) return null;
  if (typeof o.uri !== 'string' || o.uri.length === 0 || o.uri.length > 2048) return null;
  if (typeof o.durationMs !== 'number' || !isFinite(o.durationMs) || o.durationMs < 0 || o.durationMs > 24 * 3600_000) return null;
  // NOTE: uri scheme check (http(s)/ipfs vs local file://) is done at
  // the renderer level (MediaStrip) because the sender's own outgoing
  // bubble legitimately stores file:// pointing at the recording.
  // v4.32.226: optional `b` = E2E-encrypted-blob descriptor (ntfy attachment)
  // so the recipient can fetch the audio bytes when IPFS is unavailable.
  const blob = isBlobRef(o.b) ? (o.b as BlobRef) : undefined;
  return { uri: o.uri, durationMs: o.durationMs, blob };
}

export function makeVoiceText(localUri: string, durationMs: number, blob?: BlobRef): string {
  return `${VOICE_PREFIX}${JSON.stringify(blob ? { uri: localUri, durationMs, b: blob } : { uri: localUri, durationMs })}`;
}
