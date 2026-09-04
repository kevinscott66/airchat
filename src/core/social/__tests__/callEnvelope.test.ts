import { ed25519 } from '@noble/curves/ed25519.js';
import {
  sealCallEnvelope,
  openCallEnvelope,
  CALL_ENVELOPE_MAX_AGE_MS,
  CALL_ENVELOPE_MAX_SKEW_MS,
} from '../callEnvelope';
import { publicKeyToB64 } from '../../crypto/pubKeyFormat';
import type { KeyPairBytes } from '../../crypto/keyManager';

/**
 * v4.32.585: сигнальный сервер недоверенный, и до этой версии он мог сесть
 * посередине звонка — отпечаток DTLS ехал в SDP без подписи. Тесты держат
 * ровно ту границу, которая это закрывает: конверт годится только от того,
 * кого ждали, только тому, кому адресован, только того вида и только к
 * своему звонку.
 */

function keys(): { pair: KeyPairBytes; pub: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pair: { secretKey, publicKey }, pub: publicKeyToB64(publicKey) };
}

const ALICE = keys();
const BOB = keys();
const MALLORY = keys();

const CALL_ID = 'a1b2c3d4e5f60718';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';

const offerFromAlice = () =>
  sealCallEnvelope(ALICE.pair, ALICE.pub, {
    kind: 'offer',
    to: BOB.pub,
    callId: CALL_ID,
    sdp: SDP,
    isVideo: true,
  });

const expectOffer = { kind: 'offer' as const, from: ALICE.pub, to: BOB.pub };

describe('конверт звонка: свой проходит', () => {
  it('предложение доезжает целиком', async () => {
    const body = await openCallEnvelope(await offerFromAlice(), expectOffer);
    expect(body).not.toBeNull();
    expect(body?.sdp).toBe(SDP);
    expect(body?.isVideo).toBe(true);
    expect(body?.callId).toBe(CALL_ID);
    expect(body?.from).toBe(ALICE.pub);
  });

  it('ответ доезжает и привязан к номеру звонка', async () => {
    const raw = await sealCallEnvelope(BOB.pair, BOB.pub, {
      kind: 'answer',
      to: ALICE.pub,
      callId: CALL_ID,
      sdp: SDP,
    });
    const body = await openCallEnvelope(raw, {
      kind: 'answer',
      from: BOB.pub,
      to: ALICE.pub,
      callId: CALL_ID,
    });
    expect(body?.sdp).toBe(SDP);
    expect(body?.isVideo).toBeUndefined();
  });

  it('отказ и «занято» доезжают без SDP', async () => {
    for (const control of ['busy', 'declined'] as const) {
      const raw = await sealCallEnvelope(BOB.pair, BOB.pub, {
        kind: 'answer',
        to: ALICE.pub,
        callId: CALL_ID,
        control,
      });
      const body = await openCallEnvelope(raw, {
        kind: 'answer',
        from: BOB.pub,
        to: ALICE.pub,
        callId: CALL_ID,
      });
      expect(body?.control).toBe(control);
      expect(body?.sdp).toBeUndefined();
    }
  });
});

describe('конверт звонка: чужой не проходит', () => {
  it('подпись не того ключа — сервер выдаёт себя за собеседника', async () => {
    // Мэллори подписывает своим ключом, но пишет в конверт имя Алисы.
    const raw = await sealCallEnvelope(MALLORY.pair, ALICE.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
      sdp: SDP,
    });
    expect(await openCallEnvelope(raw, expectOffer)).toBeNull();
  });

  it('честно подписанный конверт Мэллори не сойдёт за конверт Алисы', async () => {
    const raw = await sealCallEnvelope(MALLORY.pair, MALLORY.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
      sdp: SDP,
    });
    expect(await openCallEnvelope(raw, expectOffer)).toBeNull();
  });

  it('отражение: конверт для Бориса не годится Мэллори', async () => {
    const raw = await offerFromAlice();
    expect(
      await openCallEnvelope(raw, { kind: 'offer', from: ALICE.pub, to: MALLORY.pub })
    ).toBeNull();
  });

  it('подмена вида: предложение не принимают за ответ', async () => {
    const raw = await offerFromAlice();
    expect(
      await openCallEnvelope(raw, { kind: 'answer', from: ALICE.pub, to: BOB.pub })
    ).toBeNull();
  });

  it('ответ от прошлого звонка не годится текущему', async () => {
    const raw = await sealCallEnvelope(BOB.pair, BOB.pub, {
      kind: 'answer',
      to: ALICE.pub,
      callId: CALL_ID,
      sdp: SDP,
    });
    expect(
      await openCallEnvelope(raw, {
        kind: 'answer',
        from: BOB.pub,
        to: ALICE.pub,
        callId: 'ffffffffffffffff',
      })
    ).toBeNull();
  });

  it('записанный когда-то конверт не проигрывается заново', async () => {
    const now = Date.now();
    const raw = await sealCallEnvelope(ALICE.pair, ALICE.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
      sdp: SDP,
      now: now - CALL_ENVELOPE_MAX_AGE_MS - 1000,
    });
    expect(await openCallEnvelope(raw, { ...expectOffer, now })).toBeNull();
  });

  it('конверт из будущего тоже отсекается', async () => {
    const now = Date.now();
    const raw = await sealCallEnvelope(ALICE.pair, ALICE.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
      sdp: SDP,
      now: now + CALL_ENVELOPE_MAX_SKEW_MS + 1000,
    });
    expect(await openCallEnvelope(raw, { ...expectOffer, now })).toBeNull();
  });

  it('правка тела ломает подпись', async () => {
    const raw = await offerFromAlice();
    const outer = JSON.parse(raw) as { payload: string; signature: string };
    // Сервер меняет отпечаток DTLS на свой — ровно та подмена, ради которой
    // всё это и написано.
    outer.payload = outer.payload.replace('AA:BB', 'CC:DD');
    expect(await openCallEnvelope(JSON.stringify(outer), expectOffer)).toBeNull();
  });

  it('«отклонён» без подписи выдумать нельзя', async () => {
    const forged = JSON.stringify({
      payload: JSON.stringify({
        v: 1,
        kind: 'answer',
        from: BOB.pub,
        to: ALICE.pub,
        callId: CALL_ID,
        control: 'declined',
        ts: Date.now(),
      }),
      signature: Buffer.alloc(64).toString('base64'),
    });
    expect(
      await openCallEnvelope(forged, { kind: 'answer', from: BOB.pub, to: ALICE.pub })
    ).toBeNull();
  });

  it('«занято» в предложении не принимается', async () => {
    const raw = await sealCallEnvelope(ALICE.pair, ALICE.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
      control: 'busy',
    });
    expect(await openCallEnvelope(raw, expectOffer)).toBeNull();
  });

  it('предложение без SDP бессмысленно и отвергается', async () => {
    const raw = await sealCallEnvelope(ALICE.pair, ALICE.pub, {
      kind: 'offer',
      to: BOB.pub,
      callId: CALL_ID,
    });
    expect(await openCallEnvelope(raw, expectOffer)).toBeNull();
  });

  it('мусор вместо конверта не роняет разбор', async () => {
    for (const junk of ['', 'не json', '{}', '[]', 'null', JSON.stringify({ payload: 1 })]) {
      expect(await openCallEnvelope(junk, expectOffer)).toBeNull();
    }
    expect(await openCallEnvelope(undefined, expectOffer)).toBeNull();
    expect(await openCallEnvelope(42, expectOffer)).toBeNull();
  });

  it('нерабочий ключ собеседника — не повод что-то принять', async () => {
    const raw = await offerFromAlice();
    expect(
      await openCallEnvelope(raw, { kind: 'offer', from: 'не-ключ', to: BOB.pub })
    ).toBeNull();
  });
});
