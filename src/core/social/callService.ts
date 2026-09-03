/**
 * callService — голосовые и видеозвонки через WebRTC.
 *
 * Сигнализация через Socket.IO signaling server (тот же, что и для P2P-сообщений).
 * Room ID = sorted join обоих pubB64.
 * ICE через STUN (stun.l.google.com по умолчанию).
 */

import { Platform, PermissionsAndroid } from 'react-native';
import { log } from '../logger';
import {
  shouldNotifyPeer,
  ringingTimeoutMs,
  INCOMING_RINGING_TIMEOUT_MS,
  OUTGOING_RINGING_TIMEOUT_MS,
  type TeardownOrigin,
} from './callTeardown';
import { WebRTCSignaling, getIceServers } from '../transport/webrtc/signaling';
import { loadConfig } from '../config';
import { rateLimiter } from '../security/rateLimiter';
import { isPubKeyB64 } from '../crypto/pubKeyFormat';
import { didFromPubB64 } from '../identity/did';
import { callBannerId, newCallId } from '../../notifications/callPush';
import { randomBytes } from '@noble/hashes/utils.js';
import type { KeyPairBytes } from '../crypto/keyManager';

/**
 * v4.32.124 (AUDIT P0 #4): explicit Android RECORD_AUDIO / CAMERA check before
 * react-native-webrtc's getUserMedia. On Android, getUserMedia throws a native
 * SecurityException on denial that surfaces as an async reject; we want a
 * clean boolean answer BEFORE committing state changes + UI side-effects.
 */
async function ensureCallPermissions(isVideo: boolean): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const perms: Array<(typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS]> = [
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ];
    if (isVideo) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
    const res = await PermissionsAndroid.requestMultiple(perms);
    return perms.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch (e) {
    log.warn('call_permission_request_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connected' | 'ended';

export type CallInfo = {
  state: CallState;
  peerPubB64: string;
  peerName: string;
  isVideo: boolean;
  connectedAt: number | null;
  /**
   * Кто кому позвонил (v4.32.441). Проставляется в момент появления звонка и
   * дальше только переносится: `state` к концу разговора равен 'connected' у
   * обеих сторон, и восстановить направление по нему нельзя. Раньше журнал
   * именно это и делал — поэтому КАЖДЫЙ принятый входящий звонок попадал в
   * список как исходящий, со стрелкой «вы позвонили».
   */
  direction: 'outgoing' | 'incoming';
  /**
   * Когда звонок начался — не когда соединился (v4.32.441). В журнал шло
   * время соединения, а у несостоявшегося звонка — время его окончания.
   */
  startedAt: number;
};

/**
 * Media is intentionally exposed as a small UI-facing layer. The signaling
 * and handshake remain private to this service; consumers only observe the
 * streams and toggle local tracks.
 */
export type CallMediaStream = {
  toURL?: () => string;
  getTracks?: () => Array<{ stop(): void }>;
  getAudioTracks?: () => Array<{ enabled: boolean }>;
  getVideoTracks?: () => Array<{ enabled: boolean; facing?: string; _switchCamera?: () => void }>;
};

export type CallMediaState = {
  localStream: CallMediaStream | null;
  remoteStream: CallMediaStream | null;
  localAudioEnabled: boolean;
  localVideoEnabled: boolean;
};

/**
 * Почему звонок кончился, если разговор так и не начался (v4.32.441).
 *
 * Известно на месте, где звонок завершают, и только там: отказ собеседника
 * приходит отдельным сигналом, отказ свой — нажатием кнопки на входящем.
 * Раньше это не передавалось вовсе, а восстанавливалось из направления —
 * и выходило, что исходящий, который никто не взял, значился «отклонён»
 * (будто собеседник сбросил), а входящий, который человек сам отклонил, —
 * «пропущен».
 */
export type CallEndCause = 'declined' | 'unanswered';

type CallListener = (info: CallInfo | null) => void;
type CallMediaListener = (media: CallMediaState) => void;

type CallSignaling = {
  sendHangup?: (targetPeerId: string) => void;
  onHangup?: (handler: (msg: { fromPeerId?: string }) => void) => void;
  // The current transport predates the typed hangup methods. Keep this small
  // optional adapter until all transport implementations expose them.
  socket?: {
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (msg: { fromPeerId?: string }) => void): void;
    off?(event: string): void;
  };
};

type WrtcModule = {
  RTCPeerConnection: new (cfg: RTCConfiguration) => RTCPeerConnection;
  RTCSessionDescription: new (init: RTCSessionDescriptionInit) => RTCSessionDescription;
  RTCIceCandidate: new (init: RTCIceCandidateInit) => RTCIceCandidate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mediaDevices: { getUserMedia(constraints: any): Promise<any> };
};

function loadWebRtc(): WrtcModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-webrtc') as WrtcModule;
  } catch {
    return null;
  }
}

// ─── Call log ─────────────────────────────────────────────────────────────────

export type CallLogEntry = {
  id: string;
  peerPubB64: string;
  peerName: string;
  isVideo: boolean;
  direction: 'outgoing' | 'incoming';
  /** 'answered' = connected, 'missed' = never connected, 'declined' = rejected */
  outcome: 'answered' | 'missed' | 'declined';
  startedAt: number;
  durationMs: number | null;
};

/**
 * Сколько звонков помним. v4.32.277: число было записано трижды — 100 в
 * памяти, 50 при сохранении и ещё раз 50 при разборе прочитанного. То есть
 * половина видимой истории исчезала при перезапуске без всякой причины.
 */
const MAX_LOG = 100;

/** Ключ журнала звонков. Глобальный `call_log` — legacy до v4.32.177. */
const LEGACY_CALL_LOG_KEY = 'call_log';
const callLogKey = (pid: number): string => `p${pid}:${LEGACY_CALL_LOG_KEY}`;

let callLog: CallLogEntry[] = [];
let callProfileId: number | null = null;
const callLogListeners = new Set<(log: CallLogEntry[]) => void>();
const callLogPersistenceQueues = new Map<number, Promise<void>>();

function emitCallLog(): void {
  for (const cb of callLogListeners) {
    try { cb([...callLog]); } catch { /* ignore */ }
  }
}

export function getCallLog(): CallLogEntry[] {
  return [...callLog];
}

export function subscribeCallLog(cb: (log: CallLogEntry[]) => void): () => void {
  callLogListeners.add(cb);
  return () => { callLogListeners.delete(cb); };
}

function recordCallEnd(info: CallInfo, endedAt: number, cause: CallEndCause): void {
  const connectedAt = info.connectedAt;
  const outcome: CallLogEntry['outcome'] = connectedAt
    ? 'answered'
    : (cause === 'declined' ? 'declined' : 'missed');
  const entry: CallLogEntry = {
    // v4.32.188 (Round-18 #9): endedAt_peerSuffix collides when two calls
    // end in the same ms with the same peer (and a clock rewind via NTP
    // breaks ordering). Use a random id to guarantee dedup in kvSet.
    id: `${endedAt}_${Math.random().toString(36).slice(2, 10)}`,
    peerPubB64: info.peerPubB64,
    peerName: info.peerName,
    isVideo: info.isVideo,
    direction: info.direction,
    outcome,
    startedAt: info.startedAt,
    durationMs: connectedAt ? endedAt - connectedAt : null,
  };
  callLog = [entry, ...callLog].slice(0, MAX_LOG);
  emitCallLog();
  // v4.32.177: scoped по профилю — раньше call_log был глобальным ключом,
  // после смены профиля / wipe следующий пользователь видел звонки предыдущего.
  const profileId = callProfileId;
  if (profileId !== null) void persistCallLog(profileId, callLog);
}

/**
 * Звонки, которых человек не видел, потому что телефона не было в сети
 * (v4.32.558).
 *
 * Повтор предложения (OFFER_RETRY_INTERVAL_MS) выручает только того, кто успел
 * появиться за 45 секунд звонка. Кто не успел — не узнавал о звонке ничего:
 * сокета нет, push на iOS нет тоже. Теперь сервер придерживает несостоявшийся
 * звонок и отдаёт его первым событием после регистрации, а здесь он ложится
 * в журнал звонков — ровно там же, где лежат все остальные пропущенные.
 *
 * Имени в записи нет: с сервера приезжает только открытый ключ, и подписью
 * ему служит тот же обрезок ключа, что и у входящего звонка, — имя подставит
 * экран истории из контактов.
 */
export function recordMissedCalls(calls: Array<{ fromPeerId: string; at: number; attempts: number }>): number {
  let added = 0;
  for (const call of calls) {
    if (!isPubKeyB64(call.fromPeerId)) continue;
    const at = Number.isFinite(call.at) ? Math.min(Number(call.at), Date.now()) : Date.now();
    // Разговор с этим человеком идёт прямо сейчас — «вам звонили» о нём было
    // бы неправдой.
    if (currentCall && currentCall.peerPubB64 === call.fromPeerId
      && currentCall.state !== 'idle' && currentCall.state !== 'ended') continue;
    // Сервер стирает запись при доставке, но повторная доставка не должна
    // раздваивать звонок в истории.
    if (callLog.some((e) => e.peerPubB64 === call.fromPeerId && e.startedAt === at)) continue;
    const entry: CallLogEntry = {
      id: `${at}_${Math.random().toString(36).slice(2, 10)}`,
      peerPubB64: call.fromPeerId,
      peerName: call.fromPeerId.slice(0, 12),
      isVideo: false,
      direction: 'incoming',
      outcome: 'missed',
      startedAt: at,
      durationMs: null,
    };
    callLog = [entry, ...callLog].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_LOG);
    added += 1;
  }
  if (added === 0) return 0;
  emitCallLog();
  const profileId = callProfileId;
  if (profileId !== null) void persistCallLog(profileId, callLog);
  return added;
}

/**
 * v4.32.277: журнал звонков лежал в kv открытым текстом — кому звонил, когда и
 * чем кончилось. Это метаданные переписки, и защищены они должны быть так же,
 * как её текст: тот же общий DEK через kvSetSecret.
 */
function enqueueCallLogPersistence(profileId: number, operation: () => Promise<void>): Promise<void> {
  const previous = callLogPersistenceQueues.get(profileId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  callLogPersistenceQueues.set(profileId, current);
  return current.finally(() => {
    if (callLogPersistenceQueues.get(profileId) === current) callLogPersistenceQueues.delete(profileId);
  });
}

function persistCallLog(profileId: number, entries = callLog): Promise<void> {
  const snapshot = entries.slice(0, MAX_LOG);
  return enqueueCallLogPersistence(profileId, async () => {
    try {
      const { kvSetSecret } = await import('../storage/local');
      await kvSetSecret(callLogKey(profileId), JSON.stringify(snapshot));
    } catch { /* ignore */ }
  });
}

/**
 * Очистить журнал звонков.
 *
 * v4.32.277: кнопка «Очистить» в истории звонков писала `[]` в глобальный
 * legacy-ключ — не в тот, откуда журнал читается, и не в память сервиса.
 * Список на экране пустел, а после перезапуска приложения возвращался целиком.
 */
export async function clearCallLog(): Promise<void> {
  callLog = [];
  emitCallLog();
  const { profileManager } = await import('../identity/profileManager');
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  await enqueueCallLogPersistence(pid, async () => {
    try {
      const { kvDelete } = await import('../storage/local');
      await kvDelete(callLogKey(pid));
      // И legacy-ключ: иначе следующий loadCallLog поднимет старый журнал как
      // «миграцию» и очистка отменится сама собой.
      await kvDelete(LEGACY_CALL_LOG_KEY);
    } catch { /* ignore */ }
  });
}

export async function loadCallLog(): Promise<void> {
  try {
    const { kvGetSecret, kvSetSecret, kvDelete } = await import('../storage/local');
    const { profileManager } = await import('../identity/profileManager');
    const pid = profileManager.getActiveProfile()?.id ?? 1;
    let raw = await kvGetSecret(callLogKey(pid));
    // Миграция с legacy (глобального) ключа — разово копируем в scoped.
    // kvGetSecret пропускает старую незашифрованную строку насквозь, поэтому
    // тот же путь заодно перешифровывает журнал, записанный до v4.32.277.
    if (!raw) {
      const legacy = await kvGetSecret(LEGACY_CALL_LOG_KEY);
      if (legacy) {
        raw = legacy;
        await kvSetSecret(callLogKey(pid), legacy);
        // v4.32.278: и убрать глобальный ключ. Без этого «разовая» миграция
        // повторялась бы у каждого профиля — второй аккаунт на том же
        // устройстве поднимал бы журнал звонков первого как свой.
        await kvDelete(LEGACY_CALL_LOG_KEY);
      }
    }
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        // v4.32.197 (Round-27 #7): validate each row. Corrupt or imported kv
        // values flow straight into UI render / export — per-row filter keeps
        // only plausible entries and caps the log to MAX_LOG.
        const clean: CallLogEntry[] = [];
        for (const e of parsed as unknown[]) {
          if (clean.length >= MAX_LOG) break;
          if (!e || typeof e !== 'object') continue;
          const r = e as Record<string, unknown>;
          if (typeof r.peerPubB64 !== 'string' || r.peerPubB64.length < 43 || r.peerPubB64.length > 48) continue;
          if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) continue;
          if (r.direction !== 'outgoing' && r.direction !== 'incoming') continue;
          if (r.outcome !== 'answered' && r.outcome !== 'missed' && r.outcome !== 'declined') continue;
          const entry = e as CallLogEntry;
          entry.peerName = typeof entry.peerName === 'string' ? entry.peerName.slice(0, 128) : '';
          clean.push(entry);
        }
        callLog = clean;
        emitCallLog();
        // Журнал, записанный до v4.32.277, лежит открытым текстом. Прочитали —
        // сразу перезаписываем шифртекстом: иначе он оставался бы открытым до
        // следующего звонка, а у того, кто больше не звонит, — навсегда.
        if (clean.length > 0) await persistCallLog(pid, clean);
      }
    }
  } catch { /* ignore */ }
}

// ─── Internal state ──────────────────────────────────────────────────────────

const listeners = new Set<CallListener>();
let currentCall: CallInfo | null = null;
let callGeneration = 0;
let myPubB64Global: string | null = null;
let mySigningPair: KeyPairBytes | null = null;

// WebRTC state
let pc: RTCPeerConnection | null = null;
let localStream: CallMediaStream | null = null;
let remoteStream: CallMediaStream | null = null;
let signaling: WebRTCSignaling | null = null;
let signalingRegistered = false;
let serviceEpoch = 0;

const mediaListeners = new Set<CallMediaListener>();

// Pending incoming offer (stored until user accepts)
let pendingOffer: { fromPubB64: string; fromName: string; sdp: string; isVideo: boolean } | null = null;

// v4.32.142 (AUDIT P1 T2): handle to the 2500ms 'ended'→null reset timer armed
// by _hangup. A new incoming OFFER that arrives during this post-hangup window
// lands in state 'ended' (which onOffer treats as "not busy"), but the already-
// armed reset timer then fires and silently nulls the fresh `currentCall`,
// erasing the new incoming call from UI. Store the handle at module scope so
// onOffer / initiateCall / acceptCall can cancel it before mutating state.
let endedResetTimer: ReturnType<typeof setTimeout> | null = null;
let outgoingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Повтор предложения звонка, пока телефон не появится в сети (v4.32.573).
 *
 * Раньше сервер отвечал звонящему `peer_unavailable`, и звонок обрывался на
 * первой же секунде словом «Недоступен» — дозвониться можно было только до
 * человека, который и так смотрит в телефон. Теперь push будит устройство, а
 * предложение повторяется по сокету, пока не доедет или пока не выйдет срок
 * звонка (45 с). На сервере при этом не оседает ничего: sdp несёт адреса
 * устройства, и оставлять его там на хранение нельзя (см. notifications/callPush).
 */
let outgoingRetryTimer: ReturnType<typeof setInterval> | null = null;
let outgoingOffer: { myPub: string; peerPubB64: string; body: string } | null = null;
/** Как часто повторять предложение звонка тому, кого не было в сети. */
const OFFER_RETRY_INTERVAL_MS = 3000;

function stopOfferRetry(): void {
  if (outgoingRetryTimer) { clearInterval(outgoingRetryTimer); outgoingRetryTimer = null; }
  outgoingOffer = null;
}
/**
 * Срок входящего звонка, которого не берут (v4.32.549).
 *
 * Раньше его не было вовсе: если звонивший исчез, не успев положить трубку,
 * входящий оставался на экране навсегда.
 */
let incomingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

// v4.32.139 (AUDIT P0 T1): buffer remote ICE candidates that arrive before the
// peer connection exists or before setRemoteDescription resolves. Previously
// candidates were silently dropped (when pc===null) or rejected with
// InvalidStateError and swallowed by .catch(()=>{}) — either path lost ICE
// data, causing outgoing calls to hang up to the 45s timeout.
const pendingRemoteIce: RTCIceCandidateInit[] = [];

async function flushPendingIce(pcRef: RTCPeerConnection): Promise<void> {
  const wrtc = loadWebRtc();
  if (!wrtc) return;
  while (pendingRemoteIce.length > 0) {
    const cand = pendingRemoteIce.shift()!;
    try {
      await pcRef.addIceCandidate(new wrtc.RTCIceCandidate(cand));
    } catch (e) {
      log.warn('ice_flush_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emit(): void {
  for (const cb of listeners) {
    try { cb(currentCall); } catch { /* ignore */ }
  }
}

function mediaEnabled(stream: CallMediaStream | null, kind: 'audio' | 'video'): boolean {
  const tracks = kind === 'audio' ? stream?.getAudioTracks?.() : stream?.getVideoTracks?.();
  return tracks?.[0]?.enabled ?? true;
}

function getMediaSnapshot(): CallMediaState {
  return {
    localStream,
    remoteStream,
    localAudioEnabled: mediaEnabled(localStream, 'audio'),
    localVideoEnabled: mediaEnabled(localStream, 'video'),
  };
}

function emitMedia(): void {
  const snapshot = getMediaSnapshot();
  for (const cb of mediaListeners) {
    try { cb(snapshot); } catch { /* ignore */ }
  }
}

function stopStream(stream: CallMediaStream | null): void {
  if (!stream?.getTracks) return;
  try {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* ignore individual native track failures */ }
    }
  } catch { /* ignore malformed native stream objects */ }
}

function clearRemoteStream(): void {
  stopStream(remoteStream);
  remoteStream = null;
  emitMedia();
}

function cleanupCallResources(): void {
  const oldLocalStream = localStream;
  const oldRemoteStream = remoteStream;
  const oldPc = pc;
  localStream = null;
  remoteStream = null;
  pc = null;
  pendingRemoteIce.length = 0;

  if (oldPc) {
    try { oldPc.ontrack = null; } catch { /* ignore */ }
    try { oldPc.onicecandidate = null; } catch { /* ignore */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (oldPc as any).oniceconnectionstatechange = null; } catch { /* ignore */ }
    try { oldPc.close(); } catch { /* ignore */ }
  }
  stopStream(oldLocalStream);
  if (oldRemoteStream !== oldLocalStream) stopStream(oldRemoteStream);
  if (oldLocalStream || oldRemoteStream) emitMedia();
}

function setState(state: CallState, extra?: Partial<CallInfo>): void {
  if (!currentCall) return;
  currentCall = { ...currentCall, state, ...extra };
  emit();
}

async function getSignaling(): Promise<WebRTCSignaling | null> {
  if (signaling) return signaling;
  const cfg = await loadConfig();
  // v4.32.381: адрес уже приведён к пригодному для запроса виду в core/config
  // (см. normalizeEndpoints). Здесь остаётся только «задан или нет»: своя
  // нормализация тут расходилась с той, что делали push и диагностика, и все
  // три расходились с той, что делает экран настроек.
  const url = cfg.webrtc.signalingUrl;
  if (!url) return null;
  signaling = new WebRTCSignaling(url);
  return signaling;
}

/**
 * v4.32.124 (AUDIT P1): serialize concurrent ensureRegistered() calls via an
 * in-flight promise. Previously two callers (e.g. initCallService + an
 * incoming-offer trigger) could both observe signalingRegistered=false and
 * each run connect() + _setupIncomingHandlers, duplicating onOffer/onAnswer/
 * onIceCandidate subscriptions — every incoming signalling event then fired
 * twice.
 */
let ensureRegisteredInFlight: Promise<WebRTCSignaling | null> | null = null;
let ensureRegisteredInFlightEpoch = -1;
async function ensureRegistered(myPub: string, epoch = serviceEpoch): Promise<WebRTCSignaling | null> {
  if (ensureRegisteredInFlight && ensureRegisteredInFlightEpoch === epoch) return ensureRegisteredInFlight;
  const doIt = async (): Promise<WebRTCSignaling | null> => {
    const sig = await getSignaling();
    if (!sig) return null;
    if (serviceEpoch !== epoch || myPubB64Global !== myPub) return null;
    const transportRegistered = typeof sig.isRegistered === 'function' ? sig.isRegistered() : signalingRegistered;
    if (!signalingRegistered || !transportRegistered) {
      signalingRegistered = false;
      try {
        await sig.connect();
        if (serviceEpoch !== epoch || myPubB64Global !== myPub) return null;
        if (!mySigningPair) throw new Error('call_signaling_key_missing');
        await sig.register(myPub, myPub, mySigningPair); // roomId=myPub, peerId=myPub for call routing
        if (serviceEpoch !== epoch || myPubB64Global !== myPub) {
          try { sig.disconnect?.(); } catch { /* stale session */ }
          return null;
        }
        signalingRegistered = true;
        _setupIncomingHandlers(sig, myPub);
      } catch (e) {
        log.warn('call_signaling_register_failed', { err: e instanceof Error ? e.message : String(e) });
        return null;
      }
    }
    return sig;
  };
  ensureRegisteredInFlightEpoch = epoch;
  ensureRegisteredInFlight = doIt().finally(() => {
    if (ensureRegisteredInFlightEpoch === epoch) {
      ensureRegisteredInFlight = null;
      ensureRegisteredInFlightEpoch = -1;
    }
  });
  return ensureRegisteredInFlight;
}

// v4.32.192 (Round-22 #2): shape-validate signaling payloads. A rogue/MITM
// signaling server can send oversized fromPeerId or sdp to corrupt state or
// OOM. fromPeerId must look like a base64 pubkey (43-48 chars); sdp capped.
//
// v4.32.427: своя копия правила уехала в pubKeyFormat. Копия разошлась с
// собственным комментарием: тот обещал 43–48 символов, а код принимал до 64 —
// то есть строку в полтора ключа длиной сигнальный сервер мог выдать за
// идентификатор собеседника.
const MAX_SDP_LEN = 64 * 1024;
const isValidPeerId = isPubKeyB64;
function isValidSdp(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_SDP_LEN;
}

function _setupIncomingHandlers(sig: WebRTCSignaling, myPub: string): void {
  sig.onOffer(async (msg) => {
    if (!isValidPeerId(msg.fromPeerId) || msg.fromPeerId === myPub) return;
    if (!isValidSdp(msg.sdp)) return;
    // v4.32.318: заблокированный контакт до сих пор мог звонить. Сообщения от
    // него не доходили, «печатает…» не показывалось, отметки о прочтении не
    // уходили — а видеозвонок звонил на весь дом. Блокировка означает «этот
    // человек со мной не связывается», и звонок из неё не исключение.
    //
    // Молча: ни «занято», ни «отклонён». Любой ответ отсюда — это сигнал, что
    // устройство на связи и приложение работает; звонящему полагается видеть
    // ровно то же, что и при выключенном телефоне.
    await rateLimiter.whenReady();
    if (rateLimiter.isBlocked(msg.fromPeerId)) {
      log.info('call_blocked_drop', { from: msg.fromPeerId.slice(0, 8) });
      return;
    }
    // v4.32.573: повтор того же предложения — не «занято». Звонящий повторяет
    // его, пока телефон не появится в сети, и первый же дошедший повтор ставит
    // звонок в состояние «входящий». Ответить на следующий повтор «занято»
    // значило бы обрывать ровно тот звонок, который только что зазвонил.
    if (currentCall
      && (currentCall.state === 'incoming' || currentCall.state === 'connected')
      && currentCall.peerPubB64 === msg.fromPeerId) {
      return;
    }
    if (currentCall && currentCall.state !== 'idle' && currentCall.state !== 'ended') {
      // Busy — decline automatically
      sig.sendAnswer(msg.fromPeerId, 'busy');
      return;
    }

    // v4.32.142 (AUDIT P1 T2): if we're in the post-hangup 'ended' window, the
    // reset timer is armed and would nuke the fresh incoming call we're about
    // to install 2500ms from now. Cancel it before overwriting state.
    if (currentCall?.state === 'ended' && endedResetTimer) {
      clearTimeout(endedResetTimer);
      endedResetTimer = null;
    }

    const fromPubB64 = msg.fromPeerId;
    const sdpStr = msg.sdp;
    let isVideo = false;
    try {
      const parsed = JSON.parse(sdpStr) as unknown;
      // v4.32.202 (Round-32 #6): validate inner sdp shape before storing on
      // pendingOffer — it's later handed to setRemoteDescription on accept.
      // A successfully parsed envelope with an invalid inner SDP is rejected;
      // otherwise the JSON envelope itself could be passed to WebRTC as SDP.
      if (!parsed || typeof parsed !== 'object' || !isValidSdp((parsed as { sdp?: unknown }).sdp)) {
        log.warn('call_offer_invalid_envelope_sdp', { from: fromPubB64.slice(0, 8) });
        return;
      }
      isVideo = (parsed as { isVideo?: unknown }).isVideo === true;
      pendingOffer = { fromPubB64, fromName: fromPubB64.slice(0, 12), isVideo, sdp: (parsed as { sdp: string }).sdp };
      // v4.32.573: предложение доехало — баннер из шторки больше не нужен.
      const wokenBy = (parsed as { callId?: unknown }).callId;
      if (typeof wokenBy === 'string' && /^[a-f0-9]{16,128}$/i.test(wokenBy)) dismissCallBanner(wokenBy);
    } catch {
      pendingOffer = { fromPubB64, fromName: fromPubB64.slice(0, 12), isVideo: false, sdp: sdpStr };
    }

    currentCall = {
      state: 'incoming',
      peerPubB64: fromPubB64,
      peerName: fromPubB64.slice(0, 12),
      isVideo,
      connectedAt: null,
      direction: 'incoming',
      startedAt: Date.now(),
    };
    callGeneration += 1;
    // v4.32.549: у входящего звонка появился срок. Без него исчезнувший
    // звонящий (упало приложение, пропала сеть) оставлял звонок на экране
    // навсегда — гасить его было нечем.
    if (incomingTimeoutTimer) { clearTimeout(incomingTimeoutTimer); incomingTimeoutTimer = null; }
    incomingTimeoutTimer = setTimeout(() => {
      incomingTimeoutTimer = null;
      if (currentCall?.state === 'incoming') {
        void _hangup('unanswered', 'ringing_timeout');
      }
    }, ringingTimeoutMs('incoming') ?? INCOMING_RINGING_TIMEOUT_MS);
    emit();
  });

  sig.onAnswer(async (msg) => {
    if (!currentCall || currentCall.state !== 'outgoing') return;
    if (msg.fromPeerId && msg.fromPeerId !== currentCall.peerPubB64) return;
    if (msg.sdp === 'busy' || msg.sdp === 'declined') {
      // И «занято», и «отклонён» — отказ собеседника, а не «не дозвонились».
      await _hangup('declined', msg.sdp === 'busy' ? 'Занято' : 'Отклонён', 'remote');
      return;
    }
    // v4.32.192 (Round-22 #2): reject oversized/non-string sdp payloads.
    if (!isValidSdp(msg.sdp)) return;
    try {
      const wrtc = loadWebRtc();
      const answerPc = pc;
      const generation = callGeneration;
      if (!answerPc || !wrtc) return;
      await answerPc.setRemoteDescription(new wrtc.RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      if (callGeneration !== generation || pc !== answerPc || currentCall?.state !== 'outgoing') return;
      await flushPendingIce(answerPc);
      if (callGeneration !== generation || pc !== answerPc || currentCall?.state !== 'outgoing') return;
      setState('connected', { connectedAt: Date.now() });
    } catch (e) {
      log.warn('call_set_remote_answer_failed', { err: e instanceof Error ? e.message : String(e) });
    }
  });

  sig.onIceCandidate((msg) => {
    if (msg.fromPeerId && msg.fromPeerId !== currentCall?.peerPubB64) return;
    // Keep the sentinel branch for older signaling servers during rollout.
    if (msg.candidate && (msg.candidate as { type?: string }).type === 'hangup') {
      log.info('call_remote_hangup_received');
      // Собеседник положил трубку. Если разговор ещё не начался, для нас это
      // несостоявшийся звонок, а не наш отказ.
      void _hangup('unanswered', 'Завершён', 'remote');
      return;
    }
    if (!msg.candidate) return;
    const wrtc = loadWebRtc();
    if (!wrtc) return;
    // v4.32.139 (AUDIT P0 T1): buffer if pc not yet created (callee hasn't
    // accepted) or remoteDescription not yet set (caller awaiting answer).
    // Flushed in initiateCall/onAnswer + acceptCall after setRemoteDescription.
    if (!pc || !pc.remoteDescription) {
      // v4.32.193 (Round-23 #3): cap pending-ICE buffer. A rogue signaling
      // server can flood candidates before pc/remoteDescription exists, OOM
      // the heap, and produce a multi-second flushPendingIce microtask storm
      // on accept. 64 candidates is far above any legitimate ICE gather.
      if (pendingRemoteIce.length >= 64) return;
      pendingRemoteIce.push(msg.candidate as RTCIceCandidateInit);
      return;
    }
    try {
      void pc.addIceCandidate(new wrtc.RTCIceCandidate(msg.candidate)).catch((e: unknown) => {
        log.warn('ice_add_failed', { err: e instanceof Error ? e.message : String(e) });
      });
    } catch { /* ignore */ }
  });

  const handleRemoteHangup = (msg: { fromPeerId?: string }): void => {
    const peer = currentCall?.peerPubB64;
    if (!peer || (msg.fromPeerId && msg.fromPeerId !== peer)) return;
    log.info('call_remote_hangup_received');
    void _hangup('unanswered', 'remote_hangup', 'remote');
  };
  const callSig = sig as unknown as CallSignaling;
  if (typeof callSig.onHangup === 'function') {
    callSig.onHangup(handleRemoteHangup);
  } else if (callSig.socket) {
    callSig.socket.off?.('hangup');
    callSig.socket.on('hangup', handleRemoteHangup);
  }

  sig.onMissedCalls((msg) => {
    const calls = Array.isArray(msg?.calls) ? msg.calls.slice(0, 50) : [];
    const added = recordMissedCalls(calls);
    if (added === 0) return;
    log.info('call_missed_delivered', { count: added });
    try {
      // Тот же приём, что и у dismissCallBanner: модуль уведомлений тянется
      // по требованию, чтобы звонки не зависели от него на старте.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const notifications = require('../../notifications/pushNotifications') as {
        notifyMissedCall(opts: { count: number }): Promise<void>;
      };
      void notifications.notifyMissedCall({ count: added }).catch(() => { /* журнал уже пополнен */ });
    } catch { /* notifee не подключён (тесты, Expo Go) */ }
  });

  sig.onPeerUnavailable((msg) => {
    if (!currentCall || currentCall.peerPubB64 !== msg.targetPeerId) return;
    // v4.32.573: «нет в сети» больше не значит «недоступен». У закрытого
    // приложения сокета нет по определению, и прежний обрыв означал, что
    // дозвониться до свёрнутого телефона нельзя вовсе. Push уже отправлен —
    // остаётся повторять предложение, пока телефон не появится; не появится
    // за 45 секунд — звонок кончится обычным «Нет ответа».
    if (currentCall.state === 'outgoing') {
      if (!outgoingRetryTimer && outgoingOffer) {
        log.info('call_awaiting_wake', { to: msg.targetPeerId.slice(0, 8) });
        outgoingRetryTimer = setInterval(() => {
          const pending = outgoingOffer;
          if (!pending || currentCall?.state !== 'outgoing') { stopOfferRetry(); return; }
          void (async () => {
            try {
              const s2 = await getSignaling();
              s2?.sendOffer(pending.myPub, pending.peerPubB64, pending.body);
            } catch { /* следующая попытка через интервал */ }
          })();
        }, OFFER_RETRY_INTERVAL_MS);
      }
      return;
    }
    if (currentCall.state === 'incoming' || currentCall.state === 'connected') {
      void _hangup('unanswered', 'Недоступен');
    }
  });
}

async function _createPc(myPub: string, remotePub: string): Promise<RTCPeerConnection | null> {
  const wrtc = loadWebRtc();
  if (!wrtc) return null;
  const iceServers = await getIceServers();
  const newPc = new wrtc.RTCPeerConnection({ iceServers });
  const sig = await getSignaling();
  if (sig) {
    newPc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        sig.sendIceCandidate(remotePub, ev.candidate.toJSON() as Record<string, unknown>);
      }
    };
  }
  // v4.32.124 (AUDIT P0 #6): ICE failure / disconnect watchdog. Without this,
  // a silent mid-call network drop leaves the call stuck in `connected`
  // forever (UI shows "active" while no media flows). On `failed` we tear
  // down immediately; on `disconnected` we give ICE a 10s grace to recover
  // before hanging up.
  let iceGraceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = (): void => {
    if (iceGraceTimer) { clearTimeout(iceGraceTimer); iceGraceTimer = null; }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (newPc as any).oniceconnectionstatechange = () => {
    if (pc !== newPc) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (newPc as any).iceConnectionState as string | undefined;
    if (st === 'failed') {
      clearGrace();
      void _hangup('unanswered', 'ice_failed');
    } else if (st === 'disconnected') {
      clearGrace();
      iceGraceTimer = setTimeout(() => {
        // v4.32.192 (Round-22 #4): guard pc generation. If _hangup already
        // ran and a NEW pc was created for a follow-up call, this stale
        // timer must NOT terminate the new call.
        if (pc !== newPc) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cur = (newPc as any).iceConnectionState as string | undefined;
        if (cur === 'disconnected' || cur === 'failed') {
          void _hangup('unanswered', 'ice_disconnected_timeout');
        }
      }, 10_000);
    } else if (st === 'connected' || st === 'completed') {
      clearGrace();
    } else if (st === 'closed') {
      clearGrace();
    }
  };
  newPc.ontrack = (event: RTCTrackEvent) => {
    if (pc !== newPc) return;
    const stream = event.streams?.[0] as CallMediaStream | undefined;
    if (!stream || remoteStream === stream) return;
    remoteStream = stream;
    emitMedia();
  };
  return newPc;
}

async function sendHangupSignal(peer: string, state: CallState): Promise<void> {
  // Prefer a dedicated event when the transport exposes it. The current
  // WebRTCSignaling wrapper predates that API, so its Socket.IO socket is also
  // supported here while the ICE sentinel remains the compatibility path.
  const sig = signaling ?? await getSignaling();
  if (!sig) return;
  if (state === 'incoming') {
    try { sig.sendAnswer(peer, 'declined'); } catch { /* ignore */ }
    return;
  }
  if (state !== 'outgoing' && state !== 'connected') return;

  const callSig = sig as unknown as CallSignaling;
  try {
    if (typeof callSig.sendHangup === 'function') {
      callSig.sendHangup(peer);
    } else {
      callSig.socket?.emit('hangup', { targetPeerId: peer });
    }
  } catch { /* legacy signaling fallback still runs */ }
  try { sig.sendIceCandidate(peer, { type: 'hangup' }); } catch { /* ignore */ }
}

/**
 * Завершить звонок.
 *
 * v4.32.549: у завершения появился источник. Раньше сигнал собеседнику слал
 * только `hangupCall`, то есть нажатие человека, а все внутренние завершения —
 * сорок пять секунд без ответа, отказ ICE, разрыв, неудачный запуск — рвали
 * звонок молча. На исходящем это значило, что мы бросали дозваниваться, а
 * телефон собеседника продолжал звонить: остановить его было нечем.
 */
async function _hangup(
  cause: CallEndCause,
  note?: string,
  origin: TeardownOrigin = 'local'
): Promise<void> {
  // v4.32.177: clear outgoing timeout — чтобы он не выстрелил на следующий
  // звонок, запущенный в пределах 45-секундного окна предыдущего.
  if (outgoingTimeoutTimer) { clearTimeout(outgoingTimeoutTimer); outgoingTimeoutTimer = null; }
  if (incomingTimeoutTimer) { clearTimeout(incomingTimeoutTimer); incomingTimeoutTimer = null; }
  stopOfferRetry();
  // v4.32.124 (AUDIT P0 #5): guard against null currentCall. Reachable via
  // the catch in initiateCall after early abort, or if _hangup runs twice
  // (ICE watchdog + user hangup + 45s timeout all racing). Previously the
  // non-null assertion `currentCall!` crashed. Also idempotent re-entry
  // on state === 'ended' — don't re-record, don't re-tear-down.
  if (!currentCall) {
    pendingOffer = null;
    cleanupCallResources();
    return;
  }
  if (currentCall.state === 'ended') {
    cleanupCallResources();
    return;
  }
  // Сигнал уходит ДО того, как мы разберём своё состояние: собеседнику надо
  // сказать, в каком виде звонок был у нас (звонящий входящий — это отказ,
  // исходящий или разговор — обычная трубка).
  const notifyPromise =
    myPubB64Global && shouldNotifyPeer(currentCall.state, origin)
      ? sendHangupSignal(currentCall.peerPubB64, currentCall.state)
      : null;
  // v4.32.139 (AUDIT P0 T1): clear buffered remote ICE to prevent leak
  // between calls.
  pendingRemoteIce.length = 0;
  // Record call in log before clearing state
  if (currentCall.state !== 'idle') {
    log.info('call_hangup', {
      cause,
      note: note ?? null,
      state: currentCall.state,
      direction: currentCall.direction,
      connected: currentCall.connectedAt !== null,
    });
    recordCallEnd(currentCall, Date.now(), cause);
  }
  callGeneration += 1;
  cleanupCallResources();

  currentCall = { ...currentCall, state: 'ended' };
  emit();
  // Reset to idle after short delay.
  // v4.32.142 (AUDIT P1 T2): cancel any prior armed reset (e.g. back-to-back
  // hangups) and store the handle so a new incoming OFFER during the 2500ms
  // window can cancel it before installing a fresh `currentCall`.
  if (endedResetTimer) {
    clearTimeout(endedResetTimer);
    endedResetTimer = null;
  }
  endedResetTimer = setTimeout(() => {
    endedResetTimer = null;
    currentCall = null;
    pendingOffer = null;
    emit();
  }, 2500);
  if (notifyPromise) await notifyPromise;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call this once after the key pair is known so the service can register on the signaling server.
 */
export async function initCallService(myPub: string, pair: KeyPairBytes, profileId = 1): Promise<void> {
  const epoch = ++serviceEpoch;
  myPubB64Global = myPub;
  mySigningPair = pair;
  callProfileId = Number.isSafeInteger(profileId) && profileId > 0 ? profileId : 1;
  await loadCallLog();
  if (serviceEpoch !== epoch || myPubB64Global !== myPub) return;
  await ensureRegistered(myPub, epoch);
}

/**
 * v4.32.124 (AUDIT P1): tear down call service on logout / wallet wipe.
 * Clears myPubB64Global (so the next identity doesn't sign calls as the
 * previous one) and resets the signalling-registered flag so
 * ensureRegistered reconnects cleanly for the new user.
 */
export async function disposeCallService(): Promise<void> {
  serviceEpoch += 1;
  try {
    const call = currentCall;
    if (call && call.state !== 'idle' && call.state !== 'ended') {
      const cause: CallEndCause = call.state === 'incoming' ? 'declined' : 'unanswered';
      // Local teardown runs synchronously inside _hangup; the awaited promise
      // lets profile switching wait for signaling cleanup before installing the
      // next identity. v4.32.549: сигнал собеседнику шлёт сам `_hangup`.
      await _hangup(cause, 'service_disposed');
    } else {
      cleanupCallResources();
    }
  } catch { /* ignore */ }
  try { signaling?.disconnect?.(); } catch { /* ignore */ }
  myPubB64Global = null;
  mySigningPair = null;
  signaling = null;
  signalingRegistered = false;
  ensureRegisteredInFlight = null;
  pendingOffer = null;
  currentCall = null;
  callProfileId = null;
  if (outgoingTimeoutTimer) {
    clearTimeout(outgoingTimeoutTimer);
    outgoingTimeoutTimer = null;
  }
  if (incomingTimeoutTimer) {
    clearTimeout(incomingTimeoutTimer);
    incomingTimeoutTimer = null;
  }
  stopOfferRetry();
  emitMedia();
  if (endedResetTimer) {
    clearTimeout(endedResetTimer);
    endedResetTimer = null;
  }
  callLog = [];
  emit();
  emitCallLog();
  log.info('call_service_disposed');
}

/**
 * Update the display name of an incoming call (once the caller's name is resolved).
 */
export function updateIncomingCallerName(peerPubB64: string, name: string): void {
  if (pendingOffer && pendingOffer.fromPubB64 === peerPubB64) {
    pendingOffer.fromName = name;
  }
  if (currentCall && currentCall.peerPubB64 === peerPubB64) {
    currentCall = { ...currentCall, peerName: name };
    emit();
  }
}

/**
 * Subscribe to call state changes. Returns unsubscribe function.
 */
export function subscribeCall(cb: CallListener): () => void {
  listeners.add(cb);
  cb(currentCall); // immediate snapshot
  return () => listeners.delete(cb);
}

/** Subscribe to local/remote media changes without exposing signaling state. */
export function subscribeCallMedia(cb: CallMediaListener): () => void {
  mediaListeners.add(cb);
  cb(getMediaSnapshot());
  return () => mediaListeners.delete(cb);
}

/** Return the current local and remote media snapshot. */
export function getCallMedia(): CallMediaState {
  return getMediaSnapshot();
}

/** Return the current media streams for RTCView or other call surfaces. */
export function getCallMediaStreams(): Pick<CallMediaState, 'localStream' | 'remoteStream'> {
  const media = getMediaSnapshot();
  return { localStream: media.localStream, remoteStream: media.remoteStream };
}

/** Whether the active call has a local video track that can be controlled. */
export function hasLocalVideoTrack(): boolean {
  return (localStream?.getVideoTracks?.().length ?? 0) > 0;
}

/**
 * Get current call info.
 */
export function getCurrentCall(): CallInfo | null {
  return currentCall;
}

/**
 * Разбудить телефон того, кому звонят (v4.32.573).
 *
 * Импорт отложенный: слой уведомлений тянет за собой Firebase и notifee, и
 * статическая связка звонков с ним замкнула бы модули друг на друга. Тот же
 * приём, что и у отправки сообщений (см. social/messaging).
 *
 * Ошибка здесь ничего не отменяет: push — это только будильник, а сам звонок
 * едет по сокету и повторяется, пока не доедет.
 */
async function sendCallWake(myPub: string, peerPubB64: string, callId: string): Promise<void> {
  try {
    const myDid = didFromPubB64(myPub);
    const peerDid = didFromPubB64(peerPubB64);
    if (!myDid || !peerDid) return;
    // require, а не import(): слой уведомлений тянет за собой firebase и
    // notifee, и держать его в статическом графе звонков незачем — но и
    // асинхронный import здесь лишний, будить надо в тот же миг.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pushNotificationService } =
      require('../../notifications/pushNotifications') as typeof import('../../notifications/pushNotifications');
    await pushNotificationService.sendCallPush(peerDid, callId, myDid);
  } catch (e) {
    log.info('call_wake_push_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Погасить баннер звонка, показанный фоновым обработчиком push (v4.32.573).
 *
 * Баннер живёт до минуты и не смахивается сам — иначе окно звонка исчезало бы
 * с экрана блокировки от случайного касания. Когда предложение доехало и
 * звонок зазвонил уже в приложении, баннер лишний: номер звонка приезжает
 * вместе с предложением ровно ради этого.
 */
function dismissCallBanner(callId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require('@notifee/react-native').default as {
      cancelNotification(id: string): Promise<void>;
    };
    void notifee.cancelNotification(callBannerId(callId)).catch(() => { /* уже погашен */ });
  } catch { /* notifee не подключён (тесты, Expo Go) */ }
}

/**
 * Initiate an outgoing call to a peer.
 */
export async function initiateCall(peerPubB64: string, peerName: string, isVideo = false): Promise<boolean> {
  const myPub = myPubB64Global;
  if (!myPub) { log.warn('call_no_my_pub'); return false; }
  // v4.32.318: заблокированному не пишут (sendMessage возвращает отказ) —
  // значит и не звонят. Иначе разговор с тем, кого сам же и заблокировал,
  // начинался бы с половины, которую он не услышит: его ответ не дойдёт.
  await rateLimiter.whenReady();
  if (rateLimiter.isBlocked(peerPubB64)) {
    log.info('call_out_blocked', { to: peerPubB64.slice(0, 8) });
    return false;
  }
  if (currentCall && currentCall.state !== 'idle' && currentCall.state !== 'ended') {
    log.warn('call_already_active');
    return false;
  }
  // v4.32.142 (AUDIT P1 T2): if a user initiates a new call during the
  // post-hangup 'ended' window, cancel the pending reset timer so it doesn't
  // fire later and null out the freshly-installed `currentCall`.
  if (endedResetTimer) {
    clearTimeout(endedResetTimer);
    endedResetTimer = null;
  }

  const wrtc = loadWebRtc();
  if (!wrtc) {
    log.warn('call_webrtc_unavailable');
    return false;
  }

  const sig = await ensureRegistered(myPub);
  if (!sig) { log.warn('call_no_signaling'); return false; }

  // v4.32.124 (AUDIT P0 #4): verify RECORD_AUDIO / CAMERA BEFORE state flips.
  // Denial used to crash inside getUserMedia; now we fail fast with no
  // half-initialised `outgoing` state leaking to the UI.
  const permsOk = await ensureCallPermissions(isVideo);
  if (!permsOk) {
    log.warn('call_permissions_denied', { isVideo });
    return false;
  }

  const generation = callGeneration + 1;
  callGeneration = generation;
  currentCall = {
    state: 'outgoing',
    peerPubB64,
    peerName,
    isVideo,
    connectedAt: null,
    direction: 'outgoing',
    startedAt: Date.now(),
  };
  clearRemoteStream();
  emit();

  try {
    // Get local media
    const freshStream = await wrtc.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    // v4.32.177: stale-check. Если между getUserMedia и этой точкой юзер hangup'нул
    // (currentCall сброшен в _hangup), микрофон/камера должны остаться выключены.
    // Раньше мы всё равно присваивали localStream и треки продолжали стримить.
    if (callGeneration !== generation || !currentCall || currentCall.state !== 'outgoing') {
      try {
        (freshStream as { getTracks(): Array<{ stop(): void }> }).getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      } catch { /* ignore */ }
      log.info('call_initiate_stale_abort');
      return false;
    }
    localStream = freshStream as CallMediaStream;
    emitMedia();
    const createdPc = await _createPc(myPub, peerPubB64);
    if (callGeneration !== generation || !currentCall || currentCall.state !== 'outgoing') {
      try { createdPc?.close(); } catch { /* ignore */ }
      return false;
    }
    pc = createdPc;
    if (!pc) throw new Error('no_pc');

    // Add local tracks
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    localStream?.getTracks?.().forEach((track) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (pc as any).addTrack(track, localStream);
    });

    // Create offer
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideo });
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'outgoing') return false;
    await pc.setLocalDescription(offer);
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'outgoing') return false;

    // The signaling server authorizes offers against the sender's registered
    // room. Each peer is registered in its own room, so using the target's
    // room here makes the server reject every offer with room_mismatch.
    // v4.32.573: номер звонка. Он ничего не значит и ни с чем не связан — он
    // нужен, чтобы push о звонке не склеился с прошлым баннером и чтобы
    // разбудившийся телефон погасил баннер, когда предложение доедет.
    const callId = newCallId(randomBytes(16));
    const offerBody = JSON.stringify({ sdp: offer.sdp, isVideo, callId });
    sig.sendOffer(myPub, peerPubB64, offerBody);
    outgoingOffer = { myPub, peerPubB64, body: offerBody };
    // Разбудить телефон, которого может не быть в сети. Уходят только номер
    // звонка и DID звонящего: sdp несёт адреса устройства и в push не едет.
    void sendCallWake(myPub, peerPubB64, callId);

    // Auto-timeout after 45s. v4.32.177: держим handle и очищаем при hangup
    // чтобы не срабатывал на новый звонок, запущенный в течение окна.
    if (outgoingTimeoutTimer) { clearTimeout(outgoingTimeoutTimer); outgoingTimeoutTimer = null; }
    outgoingTimeoutTimer = setTimeout(() => {
      outgoingTimeoutTimer = null;
      if (currentCall?.state === 'outgoing') {
        void _hangup('unanswered', 'Нет ответа');
      }
    }, ringingTimeoutMs('outgoing') ?? OUTGOING_RINGING_TIMEOUT_MS);

    return true;
  } catch (e) {
    log.warn('call_initiate_failed', { err: e instanceof Error ? e.message : String(e) });
    void _hangup('unanswered', 'initiate_failed');
    return false;
  }
}

/**
 * Accept an incoming call.
 */
export async function acceptCall(): Promise<boolean> {
  const myPub = myPubB64Global;
  if (!myPub || !pendingOffer || !currentCall || currentCall.state !== 'incoming') return false;
  // v4.32.142 (AUDIT P1 T2): defensive cancel — onOffer already clears the
  // reset timer when transitioning from 'ended'→'incoming', but if acceptCall
  // is reached via any other path (stale UI, race) ensure no stale reset
  // lingers to null `currentCall` mid-handshake.
  if (endedResetTimer) {
    clearTimeout(endedResetTimer);
    endedResetTimer = null;
  }
  // Трубку взяли — срок ожидания больше не нужен.
  if (incomingTimeoutTimer) { clearTimeout(incomingTimeoutTimer); incomingTimeoutTimer = null; }

  const wrtc = loadWebRtc();
  if (!wrtc) {
    void declineCall();
    return false;
  }

  const sig = await getSignaling();
  if (!sig) {
    void declineCall();
    return false;
  }

  const { fromPubB64, fromName, sdp: offerSdp, isVideo } = pendingOffer;
  const generation = callGeneration;

  // v4.32.124 (AUDIT P0 #4): permission gate BEFORE any media device call.
  // On denial decline cleanly — caller's retry/decline UX still works.
  const permsOk = await ensureCallPermissions(isVideo);
  if (!permsOk) {
    log.warn('call_accept_permissions_denied', { isVideo });
    void declineCall();
    return false;
  }

  try {
    localStream = await wrtc.mediaDevices.getUserMedia({ audio: true, video: isVideo }) as CallMediaStream;
    emitMedia();
    // v4.32.128 (AUDIT): re-check call state after async getUserMedia —
    // permission dialog can take seconds, during which a second incoming
    // OFFER (different peer) or a remote hangup can overwrite `pendingOffer`
    // and `currentCall`. Without this guard, setRemoteDescription below would
    // answer the *wrong* peer using the ORIGINAL captured SDP, and the later
    // `currentCall = { state: 'connected', peerPubB64: fromPubB64 }` would
    // silently drop the newer incoming call from UI.
    if (
      callGeneration !== generation ||
      !pendingOffer ||
      pendingOffer.fromPubB64 !== fromPubB64 ||
      !currentCall ||
      currentCall.state !== 'incoming' ||
      currentCall.peerPubB64 !== fromPubB64
    ) {
      log.warn('call_accept_stale_after_perms', {
        hadPending: !!pendingOffer,
        curState: currentCall?.state,
      });
      stopStream(localStream);
      localStream = null;
      emitMedia();
      return false;
    }
    const createdPc = await _createPc(myPub, fromPubB64);
    if (
      callGeneration !== generation ||
      !pendingOffer ||
      !currentCall ||
      currentCall.state !== 'incoming' ||
      currentCall.peerPubB64 !== fromPubB64
    ) {
      try { createdPc?.close(); } catch { /* ignore */ }
      return false;
    }
    pc = createdPc;
    if (!pc) throw new Error('no_pc');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    localStream?.getTracks?.().forEach((track) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (pc as any).addTrack(track, localStream);
    });

    await pc.setRemoteDescription(new wrtc.RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'incoming') return false;
    await flushPendingIce(pc);
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'incoming') return false;
    const answer = await pc.createAnswer();
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'incoming') return false;
    await pc.setLocalDescription(answer);
    if (callGeneration !== generation || pc !== createdPc || currentCall?.state !== 'incoming') return false;

    sig.sendAnswer(fromPubB64, answer.sdp ?? '');

    // Направление и время начала переносятся из строки входящего звонка
    // (проверка выше гарантирует, что это она же), а не проставляются заново.
    currentCall = { ...currentCall, state: 'connected', peerName: fromName, isVideo, connectedAt: Date.now() };
    pendingOffer = null;
    emit();
    return true;
  } catch (e) {
    log.warn('call_accept_failed', { err: e instanceof Error ? e.message : String(e) });
    if (callGeneration === generation && currentCall?.state === 'incoming') void declineCall();
    return false;
  }
}

/**
 * Decline or hang up the current call.
 */
export async function hangupCall(): Promise<void> {
  // Кнопку нажали на звонящем входящем — это отказ. На своём исходящем то же
  // нажатие значит «передумал звонить», и отказом собеседника это не было.
  const cause: CallEndCause = currentCall?.state === 'incoming' ? 'declined' : 'unanswered';
  // v4.32.549: сигнал собеседнику ушёл отсюда в `_hangup` — там он достаётся
  // и всем внутренним завершениям, которые прежде обрывали звонок молча.
  await _hangup(cause);
}

/**
 * Decline an incoming call without connecting.
 */
export async function declineCall(): Promise<void> {
  await hangupCall();
}

/**
 * Toggle mute on local audio tracks. Returns the NEW muted state.
 *
 * v4.32.126 (AUDIT P2): fix inverted return value. Prev impl named the
 * local `newMuted = track.enabled` (which actually captured the PREVIOUS
 * enabled state, not the new muted state), then returned `!newMuted` —
 * so when we muted the mic the caller got `false` and CallOverlay's
 * mute button icon desynced from reality. Rewritten with unambiguous
 * vars: `wasEnabled` (before flip) → `willBeMuted = wasEnabled`.
 */
export function toggleMute(): boolean {
  if (!localStream) return false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const audioTracks = (localStream as { getAudioTracks(): Array<{ enabled: boolean }> }).getAudioTracks();
  if (audioTracks.length === 0) return false;
  const wasEnabled = audioTracks[0].enabled; // true = mic was on (unmuted)
  const willBeMuted = wasEnabled;            // we're about to flip → muted iff was on
  audioTracks.forEach((t) => { t.enabled = !willBeMuted; });
  emitMedia();
  return willBeMuted;
}

/** Toggle the front-facing local camera track. Returns the NEW enabled state. */
export function toggleCamera(): boolean {
  if (!localStream) return false;
  const videoTracks = localStream.getVideoTracks?.() ?? [];
  if (videoTracks.length === 0) return false;
  const frontTrack = videoTracks.find((track) => track.facing === 'front') ?? videoTracks[0];
  const willBeEnabled = !frontTrack.enabled;
  frontTrack.enabled = willBeEnabled;
  emitMedia();
  return willBeEnabled;
}

/** @deprecated Use toggleCamera(). */
export function toggleVideo(): boolean {
  return toggleCamera();
}

/** Switch the active camera when the native WebRTC track supports it. */
export function switchCamera(): boolean {
  const videoTracks = localStream?.getVideoTracks?.() ?? [];
  const videoTrack = videoTracks.find((track) => track.facing === 'front') ?? videoTracks[0];
  if (!videoTrack?._switchCamera) return false;
  try {
    videoTrack._switchCamera();
    return true;
  } catch {
    return false;
  }
}

log.info('call_service_loaded');
