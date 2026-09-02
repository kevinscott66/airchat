import { parseDidKey } from '../core/identity/did';
import { loadKeyPair } from '../core/crypto/keyManager';
import { signJson } from '../core/crypto/signature';
import { ED25519_PUBLIC_KEY_BYTES, publicKeyToB64 } from '../core/crypto/pubKeyFormat';

/**
 * v4.32.537: подписанные конверты для ретранслятора push.
 *
 * Раньше в `/register-token` и `/send-push` уходил голый JSON. Кто угодно, зная
 * чужой did, мог перебить его токен своим и тем самым выключить человеку
 * уведомления — или, наоборот, будить чужое устройство сколько угодно раз.
 * Подпись тем же ключом Ed25519, которым подписывается вход в комнату
 * сигналинга, закрывает оба случая, и другого ключа для этого заводить не надо.
 */

/**
 * did:key → peerId ретранслятора: сырой публичный ключ в base64.
 *
 * Сигналинг говорит о людях именно так — 32 байта в base64, — и push-ручки
 * обязаны говорить так же. Разбирать did:key на сервере нечем и незачем:
 * преобразование однозначное, и делать его на устройстве дешевле.
 */
export function peerIdFromDid(did: unknown): string | null {
  if (typeof did !== 'string' || did.length === 0) return null;
  const raw = parseDidKey(did);
  if (!raw || raw.length !== ED25519_PUBLIC_KEY_BYTES) return null;
  return publicKeyToB64(raw);
}

export type PushEnvelope = { payload: string; signature: string };

/**
 * Подписать нагрузку ключом текущей личности.
 *
 * Возвращает null, когда ключа нет: хранилище заперто или личность ещё не
 * создана. Это не ошибка — это повод промолчать, а не отправить неподписанное.
 */
export async function signPushPayload(
  payload: Record<string, unknown>
): Promise<PushEnvelope | null> {
  const pair = await loadKeyPair();
  if (!pair) return null;
  return signJson(pair, payload);
}
