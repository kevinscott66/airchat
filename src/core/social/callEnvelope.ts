/**
 * Подписанные конверты сигнализации звонка (v4.32.585).
 *
 * Сигнальный сервер в модели угроз считается недоверенным — это записано в
 * самом callService. Но до сих пор недоверенным он был только на словах:
 * `fromPeerId` в событии проставлял он сам, а SDP шёл голым. Значит сервер мог
 * прислать Борису «предложение от Алисы» со своим `a=fingerprint`, а Алисе —
 * «ответ от Бориса» со вторым своим отпечатком, и оказаться посередине двух
 * совершенно исправных DTLS-соединений. Оба видят имя собеседника, оба видят
 * замок — и оба разговаривают через сервер, который слышит всё.
 *
 * Отпечаток DTLS лежит внутри SDP, поэтому подпись под SDP и есть привязка
 * ключа разговора к ключу личности: подменить отпечаток, не сломав подпись,
 * нельзя, а подписать своим ключом от чужого имени сервер не может.
 *
 * Подписывается не один SDP, а всё, что определяет смысл события:
 *   from     — чтобы сервер не выдал чужой конверт за конверт собеседника;
 *   to       — чтобы конверт, отправленный одному, нельзя было переслать
 *              другому (отражение);
 *   kind     — чтобы предложение не подсунули вместо ответа;
 *   callId   — чтобы ответ от прошлого звонка не приняли за ответ на текущий;
 *   ts       — чтобы записанный когда-то конверт не проигрывали заново.
 */
import { signJson, verifySignedJson } from '../crypto/signature';
import { isPubKeyB64, publicKeyFromB64 } from '../crypto/pubKeyFormat';
import type { KeyPairBytes } from '../crypto/keyManager';

export const CALL_ENVELOPE_VERSION = 1;

/** Окно свежести конверта. Щедрое: часы у собеседников расходятся. */
export const CALL_ENVELOPE_MAX_AGE_MS = 10 * 60 * 1000;
/** Столько же вперёд — на случай, если часы отправителя убежали. */
export const CALL_ENVELOPE_MAX_SKEW_MS = 10 * 60 * 1000;

/** Тот же предел, что и у голого SDP в callService. */
const MAX_SDP_LEN = 64 * 1024;

export type CallEnvelopeKind = 'offer' | 'answer';
export type CallControl = 'busy' | 'declined';

export type CallEnvelopeBody = {
  kind: CallEnvelopeKind;
  from: string;
  to: string;
  callId: string;
  /** SDP — у обычных предложений и ответов. У отказа его нет. */
  sdp?: string;
  /** Только у предложения. */
  isVideo?: boolean;
  /** Только у ответа: «занято» или «отклонён». */
  control?: CallControl;
  ts: number;
};

export type SealInput = {
  kind: CallEnvelopeKind;
  to: string;
  callId: string;
  sdp?: string;
  isVideo?: boolean;
  control?: CallControl;
  /** Подставляется в тестах; по умолчанию — текущее время. */
  now?: number;
};

function isValidCallId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{16,128}$/i.test(v);
}

function isValidSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP_LEN;
}

/** Запечатать конверт своим ключом. Возвращает строку для поля `sdp` сигнализации. */
export async function sealCallEnvelope(
  pair: KeyPairBytes,
  myPubB64: string,
  input: SealInput
): Promise<string> {
  const body: CallEnvelopeBody = {
    kind: input.kind,
    from: myPubB64,
    to: input.to,
    callId: input.callId,
    ts: input.now ?? Date.now(),
  };
  if (input.sdp !== undefined) body.sdp = input.sdp;
  if (input.isVideo !== undefined) body.isVideo = input.isVideo;
  if (input.control !== undefined) body.control = input.control;
  const signed = await signJson(pair, { v: CALL_ENVELOPE_VERSION, ...body });
  return JSON.stringify(signed);
}

export type OpenExpectation = {
  kind: CallEnvelopeKind;
  /** Кем конверт обязан быть подписан — `fromPeerId` из события. */
  from: string;
  /** Мой ключ: конверт, адресованный не мне, не принимается. */
  to: string;
  /** Для ответа — номер звонка, который мы начали. Для предложения не задаётся. */
  callId?: string;
  now?: number;
};

/**
 * Вскрыть и проверить конверт. `null` — конверт отвергнут; причину не
 * различаем намеренно: снаружи все отказы означают одно и то же — событию
 * верить нельзя.
 */
export async function openCallEnvelope(
  raw: unknown,
  expect: OpenExpectation
): Promise<CallEnvelopeBody | null> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SDP_LEN) return null;
  if (!isPubKeyB64(expect.from) || !isPubKeyB64(expect.to)) return null;
  const senderKey = publicKeyFromB64(expect.from);
  if (!senderKey) return null;

  let outer: unknown;
  try { outer = JSON.parse(raw); } catch { return null; }
  if (!outer || typeof outer !== 'object') return null;
  const { payload, signature } = outer as { payload?: unknown; signature?: unknown };
  if (typeof payload !== 'string' || typeof signature !== 'string') return null;

  const body = await verifySignedJson(senderKey, { payload, signature });
  if (!body) return null;

  if (body.v !== CALL_ENVELOPE_VERSION) return null;
  if (body.kind !== expect.kind) return null;
  // Подписал именно тот, кем событие представилось, и адресовано именно мне.
  if (body.from !== expect.from) return null;
  if (body.to !== expect.to) return null;
  if (!isValidCallId(body.callId)) return null;
  if (expect.callId !== undefined && body.callId !== expect.callId) return null;

  const ts = body.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const now = expect.now ?? Date.now();
  if (now - ts > CALL_ENVELOPE_MAX_AGE_MS) return null;
  if (ts - now > CALL_ENVELOPE_MAX_SKEW_MS) return null;

  const control = body.control;
  if (control !== undefined) {
    // Отказ — это ответ и только ответ, и SDP в нём быть не должно.
    if (expect.kind !== 'answer') return null;
    if (control !== 'busy' && control !== 'declined') return null;
    if (body.sdp !== undefined) return null;
    return {
      kind: 'answer', from: body.from as string, to: body.to as string,
      callId: body.callId as string, control, ts,
    };
  }

  if (!isValidSdp(body.sdp)) return null;
  const isVideo = body.isVideo;
  if (isVideo !== undefined && typeof isVideo !== 'boolean') return null;
  if (expect.kind === 'answer' && isVideo !== undefined) return null;

  return {
    kind: expect.kind,
    from: body.from as string,
    to: body.to as string,
    callId: body.callId as string,
    sdp: body.sdp,
    ...(isVideo !== undefined ? { isVideo } : {}),
    ts,
  };
}
