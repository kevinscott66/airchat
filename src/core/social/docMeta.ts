/**
 * docMeta — разбор конверта документа вместе с проверкой самого CID.
 *
 * v4.32.534. В шапке docEnvelope.ts сказано прямо: «Проверка самого CID
 * (обычный IPFS или зашифрованный blob 'nb:') осталась у вызывающего — она
 * тянет core/media». Вызывающим был ChatScreen.tsx, и оттуда же за этой
 * проверкой ходили DocBubble и ChatSharedMediaModal — то есть экран диалога
 * работал бочкой ре-экспортов для двух компонентов, которые к нему отношения
 * не имеют.
 *
 * Граница остаётся ровно там, где её провёл автор docEnvelope: чистый разбор
 * конверта — там, зависимость от core/media — здесь. Проверки не менялись.
 */

import { isPlainCid } from '../cid';
import { isNbCid, parseNbCid } from '../media/blobRef';
import { parseDocEnvelope } from './docEnvelope';

export function parseDocMeta(text: string): { name: string; size: number; cid: string } | null {
  const meta = parseDocEnvelope(text);
  if (!meta) return null;
  // v4.32.190 (Round-20 #2): strict CID shape so a peer can't splice URL path
  // chars into `${gateway}/ipfs/${cid}` (Linking.openURL redirect).
  // v4.32.226: accept either a plain IPFS CID or an `nb:` encrypted-blob
  // descriptor (mobile path). nb refs are shape-validated via parseNbCid so a
  // peer still can't splice arbitrary URL chars into the gateway path —
  // DocBubble never builds a gateway URL for nb refs.
  if (isNbCid(meta.cid)) {
    if (!parseNbCid(meta.cid)) return null;
  } else if (!isPlainCid(meta.cid)) {
    return null;
  }
  return meta;
}
