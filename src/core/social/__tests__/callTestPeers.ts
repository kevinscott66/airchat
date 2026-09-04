/**
 * Ключи и конверты для тестов звонков (v4.32.585).
 *
 * С тех пор как сигнализация звонка ходит под подписью, «предложение» в тесте
 * нельзя собрать из строки: сервис проверяет подпись раньше, чем смотрит на
 * содержимое. Поэтому у участника теста теперь настоящая пара ключей, а не
 * сорок три буквы «A».
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { publicKeyToB64 } from '../../crypto/pubKeyFormat';
import { sealCallEnvelope, type CallControl } from '../callEnvelope';
import type { KeyPairBytes } from '../../crypto/keyManager';

export type TestPeer = { pair: KeyPairBytes; pub: string };

export function makePeer(): TestPeer {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, pub: publicKeyToB64(publicKey) };
}

/** Номер звонка того же вида, что выдаёт сервис: 32 шестнадцатеричных знака. */
export function testCallId(hexDigit = 'a'): string {
  return hexDigit.repeat(32);
}

const pubOf = (to: TestPeer | string): string => (typeof to === 'string' ? to : to.pub);

export function sealOffer(
  from: TestPeer,
  to: TestPeer | string,
  opts: { sdp?: string; isVideo?: boolean; callId?: string } = {}
): Promise<string> {
  return sealCallEnvelope(from.pair, from.pub, {
    kind: 'offer',
    to: pubOf(to),
    callId: opts.callId ?? testCallId(),
    sdp: opts.sdp ?? 'remote-offer-sdp',
    ...(opts.isVideo !== undefined ? { isVideo: opts.isVideo } : {}),
  });
}

export function sealAnswer(
  from: TestPeer,
  to: TestPeer | string,
  opts: { sdp?: string; callId?: string; control?: CallControl } = {}
): Promise<string> {
  return sealCallEnvelope(from.pair, from.pub, {
    kind: 'answer',
    to: pubOf(to),
    callId: opts.callId ?? testCallId(),
    ...(opts.control !== undefined ? { control: opts.control } : { sdp: opts.sdp ?? 'answer-sdp' }),
  });
}

/** Содержимое конверта без проверки подписи — тесту довольно и этого. */
export function envelopeBody(raw: unknown): Record<string, unknown> {
  const outer = JSON.parse(String(raw)) as { payload?: string };
  return JSON.parse(String(outer.payload ?? '{}')) as Record<string, unknown>;
}
