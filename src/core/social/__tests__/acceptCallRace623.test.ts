/**
 * Ответ на звонок не уходит по отменённому звонку (v4.32.623).
 *
 * `acceptCall` проверяет поколение и состояние перед каждым await — кроме
 * последнего: конверт с ответом запечатывался и тут же отправлялся, без
 * проверки. За эти миллисекунды человек успевал нажать «сбросить»: ответ уходил
 * уже отменённому звонку, а следующая строка воскрешала его из `currentCall`,
 * ставшего к тому моменту null. `{...null}` — это объект без собеседника и без
 * направления: «разговор» на экране с пустым именем, который нечем завершить.
 *
 * Проверяется форма исходника: callService тянет за собой WebRTC и сокет, а
 * порядок «запечатать → проверить → отправить» виден прямо в вызове.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'callService.ts'), 'utf8');
const GUARD =
  "if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'incoming') return false;";

/** Хвост acceptCall — от setLocalDescription до присвоения connected. */
function tail(): string {
  const from = SRC.indexOf("if (!mySigningPair) throw new Error('call_no_signing_key');");
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('pendingOffer = null;', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to);
}

it('между запечатыванием конверта и отправкой стоит проверка', () => {
  const body = tail();
  const sealAt = body.indexOf('const sealedAnswer = await sealCallEnvelope(');
  const guardAt = body.indexOf(GUARD);
  const sendAt = body.indexOf('sig.sendAnswer(fromPubB64, sealedAnswer);');
  expect(sealAt).toBeGreaterThanOrEqual(0);
  expect(guardAt).toBeGreaterThan(sealAt);
  expect(sendAt).toBeGreaterThan(guardAt);
  // Прежняя форма: запечатали и отправили одним выражением, проверять нечего.
  expect(SRC).not.toContain('sig.sendAnswer(fromPubB64, await sealCallEnvelope(mySigningPair');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: та же проверка стоит и у остальных await приёма', () => {
  const from = SRC.indexOf('await pc.setRemoteDescription(new wrtc.RTCSessionDescription');
  expect(from).toBeGreaterThan(0);
  const body = SRC.slice(from, SRC.indexOf('pendingOffer = null;', from));
  // setRemoteDescription, flushPendingIce, createAnswer, setLocalDescription,
  // sealCallEnvelope — по проверке после каждого.
  expect(body.split(GUARD).length - 1).toBe(5);
});

it('сгоревший номер звонка возвращается, если ответить «занято» не вышло', () => {
  expect(SRC).toContain('function forgetOffer(callId: string): void {');
  expect(SRC).toContain('seenOfferCallIds.delete(callId);');
  const from = SRC.indexOf("// Busy — decline automatically");
  expect(from).toBeGreaterThan(0);
  const busy = SRC.slice(from, SRC.indexOf('\n      return;', from));
  expect(busy).toContain('forgetOffer(offerEnvelope.callId);');
  expect(busy).toContain('throw e;');
});
