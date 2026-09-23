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

/**
 * Трое: заведомо ниже, середина и заведомо выше (v4.32.724).
 *
 * Встречный звонок обе стороны разрешают сравнением ключей, поэтому тесту
 * нужна определённая сторона, а не та, что выпадет.
 *
 * Прежний makePeerRelativeTo брал чужой ключ как данность и добирал соседа
 * выборкой наугад: двести попыток, а не нашлось — исключение. Оценка «попадание
 * примерно каждый второй раз» верна только для среднего ключа. Ключ-то случаен:
 * доля ключей ниже него — это равномерная величина от нуля до единицы, и полный
 * промах случается с вероятностью ∫(1−p)²⁰⁰dp = 1/201. Примерно один прогон из
 * двухсот падал на месте, не имеющем отношения к тому, что проверяется, — и
 * падал не тестом, а набором целиком, на разборе файла.
 *
 * Здесь выборки нет вовсе: три ключа, разложенные по порядку, дают обе стороны
 * сразу. Середина и есть «я». Совпадение двух ключей из трёх невозможно
 * практически, но проверяется — иначе «ниже» молча стало бы «столько же».
 */
export function makePeerLadder(): { lesser: TestPeer; me: TestPeer; greater: TestPeer } {
  const [lesser, me, greater] = [makePeer(), makePeer(), makePeer()].sort((a, b) =>
    a.pub < b.pub ? -1 : a.pub > b.pub ? 1 : 0,
  );
  if (lesser.pub === me.pub || me.pub === greater.pub) throw new Error('makePeerLadder: ключи совпали');
  return { lesser, me, greater };
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

/** Завершение звонка (v4.32.615): ни SDP, ни причины — только номер звонка. */
export function sealHangup(
  from: TestPeer,
  to: TestPeer | string,
  opts: { callId?: string } = {}
): Promise<string> {
  return sealCallEnvelope(from.pair, from.pub, {
    kind: 'hangup',
    to: pubOf(to),
    callId: opts.callId ?? testCallId(),
  });
}

/** Расписка о непринятом звонке (v4.32.615): содержимого нет, время — своё. */
export function sealMissed(
  from: TestPeer,
  to: TestPeer | string,
  opts: { callId?: string; now?: number } = {}
): Promise<string> {
  return sealCallEnvelope(from.pair, from.pub, {
    kind: 'missed',
    to: pubOf(to),
    callId: opts.callId ?? testCallId(),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/** Содержимое конверта без проверки подписи — тесту довольно и этого. */
export function envelopeBody(raw: unknown): Record<string, unknown> {
  const outer = JSON.parse(String(raw)) as { payload?: string };
  return JSON.parse(String(outer.payload ?? '{}')) as Record<string, unknown>;
}
