/**
 * ctlRetryPayload — «удалить у всех» и «изменить у всех» в очереди неотправленного.
 *
 * v4.32.431. До этого раунда служебные конверты вообще не умели ждать связи.
 * Обычное сообщение при недоступном собеседнике проходит четыре ступени
 * (IPFS → self-inbox → прямой транспорт → gossip → outbox), а удаление и
 * правка обрывались на первой: `publishMessageWithRetry` на Android и iOS
 * всегда возвращает null (IPFS выключен, см. heliaNode.isIpfsEnabled), и обе
 * функции выходили по `if (!cid) return null` — не пробуя ни один из
 * оставшихся путей и, в случае удаления, не успевая удалить сообщение даже у
 * себя, потому что локальное удаление стояло последней строкой.
 *
 * Нагрузка здесь — не готовый конверт, а его исходные данные. Конверт
 * запечатан симметричным ключом пары и привязан к моменту отправки; пролежав
 * сутки в очереди, он ушёл бы с меткой времени суточной давности. Поэтому
 * очередь хранит намерение, а конверт собирается заново на каждой попытке.
 *
 * Строку в очереди мог оставить предыдущий формат или испорченная миграция, а
 * дальше она уходит собеседнику — поэтому своя же нагрузка проверяется как
 * чужая, тем же правилом, что и dmRetryPayload.
 */

import { MAX_MESSAGE_TEXT } from './messageTextLimit';

export type CtlRetryPayload =
  | { op: 'delete'; contactPubB64: string; targetMessageId: string }
  | { op: 'edit'; contactPubB64: string; targetMessageId: string; newText: string };

/** Ed25519-ключ в base64 — 43 или 44 символа; допуск на пару лишних. */
const PUB_B64_MIN = 43;
const PUB_B64_MAX = 48;
const ID_MAX = 128;
/** Общий потолок текста сообщения — см. messageTextLimit. */
const TEXT_MAX = MAX_MESSAGE_TEXT;

/**
 * Разбор строки из очереди. `null` — строка непригодна, её нужно выбросить, а
 * не перекладывать в следующую попытку.
 */
export function parseCtlRetryPayload(raw: string): CtlRetryPayload | null {
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    p = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const contactPubB64 = p.contactPubB64;
  if (
    typeof contactPubB64 !== 'string' ||
    contactPubB64.length < PUB_B64_MIN ||
    contactPubB64.length > PUB_B64_MAX
  ) {
    return null;
  }

  const targetMessageId = p.targetMessageId;
  if (typeof targetMessageId !== 'string' || targetMessageId.length === 0 || targetMessageId.length > ID_MAX) {
    return null;
  }

  if (p.op === 'delete') {
    return { op: 'delete', contactPubB64, targetMessageId };
  }
  if (p.op === 'edit') {
    // Правка без текста бессмысленна: применить у собеседника нечего, а
    // пустой строкой она превратилась бы в молчаливое стирание содержимого.
    const newText = p.newText;
    if (typeof newText !== 'string' || newText.length === 0 || newText.length > TEXT_MAX) return null;
    return { op: 'edit', contactPubB64, targetMessageId, newText };
  }
  return null;
}

/** Строка для очереди. Единственное место, где решается её состав. */
export function serializeCtlRetryPayload(payload: CtlRetryPayload): string {
  return payload.op === 'delete'
    ? JSON.stringify({
        op: 'delete',
        contactPubB64: payload.contactPubB64,
        targetMessageId: payload.targetMessageId,
      })
    : JSON.stringify({
        op: 'edit',
        contactPubB64: payload.contactPubB64,
        targetMessageId: payload.targetMessageId,
        newText: payload.newText,
      });
}
