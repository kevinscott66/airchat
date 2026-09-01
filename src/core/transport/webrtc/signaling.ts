import { io, type Socket } from 'socket.io-client';
import { loadConfig } from '../../config';
import { log } from '../../logger';
import { signBytes } from '../../crypto/signature';
import type { KeyPairBytes } from '../../crypto/keyManager';
import {
  CHALLENGE_ABORTED_REASON,
  CHALLENGE_TIMEOUT_MS,
  CHALLENGE_TIMEOUT_REASON,
  classifyHandshake,
  isReusableConnection,
  needsTeardown,
  type HandshakeState,
} from './handshakeState';

export type IceServer = { urls: string; username?: string; credential?: string };

export async function getIceServers(): Promise<IceServer[]> {
  try {
    const cfg = await loadConfig();
    const stun = cfg.webrtc.stunServers.map((s) => ({ urls: s.urls }));
    const turn = cfg.webrtc.turnServers.map((t) => ({
      urls: t.urls,
      username: t.username,
      credential: t.credential,
    }));
    return [...stun, ...turn];
  } catch (e) {
    log.warn('webrtc_ice_config_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

export type SignalMessage = { type: 'offer' | 'answer' | 'candidate'; payload: string };

export type OfferPayload = { fromPeerId?: string; sdp: string };
export type AnswerPayload = { fromPeerId?: string; sdp: string };
export type IcePayload = { fromPeerId?: string; candidate: Record<string, unknown> };
export type HangupPayload = { fromPeerId?: string };

/**
 * Socket.IO signaling aligned with `signaling-server/index.js`.
 * Register with `roomId` (e.g. sorted DIDs) and your `peerId` (e.g. did:key).
 */
export class WebRTCSignaling {
  private socket: Socket | null = null;
  private readonly url: string;
  private registrationChallenge: string | null = null;
  private registration: { roomId: string; peerId: string; pair: KeyPairBytes } | null = null;
  private registered = false;
  private connectInFlight: Promise<void> | null = null;
  private registerInFlight: Promise<void> | null = null;
  private challengeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  /** Текущее состояние рукопожатия — см. `handshakeState.ts`. */
  private handshakeState(): HandshakeState {
    return classifyHandshake({
      hasSocket: this.socket !== null,
      connected: this.socket?.connected === true,
      challengeReceived: this.registrationChallenge !== null,
    });
  }

  /**
   * Разбудить всех ожидающих challenge с честной причиной.
   *
   * v4.32.551: без этого ожидающие висели до своего пятисекундного таймера
   * даже после того, как сокет отвалился и присылать challenge стало некому.
   */
  private failChallengeWaiters(reason: string): void {
    const waiters = this.challengeWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  private resolveChallenge(challenge: unknown): void {
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > 128) return;
    this.registrationChallenge = challenge;
    const waiters = this.challengeWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private waitForChallenge(): Promise<void> {
    if (this.registrationChallenge) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.challengeWaiters = this.challengeWaiters.filter((current) => current !== waiter);
        reject(new Error(CHALLENGE_TIMEOUT_REASON));
      }, CHALLENGE_TIMEOUT_MS);
      this.challengeWaiters.push(waiter);
    });
  }

  private async reregisterAfterReconnect(socket: Socket): Promise<void> {
    if (!this.registration || socket !== this.socket) return;
    try {
      await this.waitForChallenge();
      if (socket !== this.socket || !socket.connected || !this.registration) return;
      await this.register(this.registration.roomId, this.registration.peerId, this.registration.pair);
      log.info('webrtc_signaling_reregistered');
    } catch (e) {
      log.warn('webrtc_signaling_reregister_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async openConnection(): Promise<void> {
    if (!this.url) {
      log.warn('webrtc_signaling_no_url');
      return;
    }
    if (this.socket?.connected) return;
    if (this.socket) {
      try { this.socket.disconnect(); } catch { /* ignore stale socket */ }
      this.socket = null;
    }
    this.registrationChallenge = null;
    const socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      timeout: 15000,
    });
    this.socket = socket;
    socket.on('registration_challenge', (value: { challenge?: unknown }) => {
      this.resolveChallenge(value?.challenge);
    });
    socket.on('disconnect', () => {
      if (socket === this.socket) {
        this.registrationChallenge = null;
        this.registered = false;
        this.failChallengeWaiters(CHALLENGE_ABORTED_REASON);
      }
    });
    socket.on('connect', () => {
      // The initial connect happens before register() stores registration. On
      // later reconnects the server has forgotten the peer, so re-register.
      if (this.registration) void this.reregisterAfterReconnect(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => { cleanup(); resolve(); };
      const onError = (err: Error): void => {
        cleanup();
        try { socket.disconnect(); } catch { /* ignore */ }
        if (this.socket === socket) this.socket = null;
        reject(err);
      };
      const cleanup = (): void => {
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };
      socket.once('connect', onConnect);
      socket.once('connect_error', onError);
    });
    try {
      await this.waitForChallenge();
    } catch (e) {
      // v4.32.551: рукопожатие не состоялось — убираем за собой ровно так же,
      // как на `connect_error` выше. Прежде сокет оставался подключённым и
      // присвоенным, `connect()` считал его готовым, и приложение навсегда
      // застревало в «соединён, но зарегистрироваться нельзя».
      this.discardHalfOpenSocket(socket);
      throw e;
    }
  }

  /**
   * Разорвать подключённый сокет, на котором не состоялось рукопожатие.
   *
   * Только его: сокет в процессе подключения socket.io доводит сам.
   */
  private discardHalfOpenSocket(socket: Socket): void {
    if (this.socket !== socket) return;
    log.warn('webrtc_signaling_handshake_incomplete', { state: this.handshakeState() });
    try { socket.disconnect(); } catch { /* ignore */ }
    this.socket = null;
    this.registrationChallenge = null;
    this.registered = false;
  }

  constructor(signalingUrl?: string) {
    this.url = signalingUrl?.trim() ?? '';
  }

  async connect(): Promise<void> {
    // v4.32.551: готовым считается только состояние `ready` — сокет подключён
    // И challenge получен. Прежнее «сокет подключён» возвращало успех на
    // половинчатом соединении, после чего `register()` падал вечно.
    const state = this.handshakeState();
    if (isReusableConnection(state)) return;
    if (needsTeardown(state) && this.socket) this.discardHalfOpenSocket(this.socket);
    if (this.connectInFlight) return this.connectInFlight;
    this.connectInFlight = this.openConnection().finally(() => {
      this.connectInFlight = null;
    });
    return this.connectInFlight;
  }

  async register(roomId: string, peerId: string, pair: KeyPairBytes): Promise<void> {
    if (this.registered && this.registration?.roomId === roomId && this.registration.peerId === peerId && this.socket?.connected) return;
    if (this.registerInFlight) return this.registerInFlight;
    this.registerInFlight = (async () => {
      await this.connect();
      if (!this.socket || !this.registrationChallenge) throw new Error('registration_challenge_missing');
      const message = new TextEncoder().encode(`${this.registrationChallenge}\n${roomId}\n${peerId}`);
      const signature = Buffer.from(await signBytes(pair.secretKey, message)).toString('base64');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('registration_timeout')), 5000);
        this.socket?.emit(
          'register',
          { roomId, peerId, signature },
          (reply: { ok?: boolean; error?: string }) => {
            clearTimeout(timer);
            if (reply?.ok) resolve();
            else reject(new Error(reply?.error || 'registration_rejected'));
          },
        );
      });
      this.registration = { roomId, peerId, pair };
      this.registered = true;
    })().finally(() => {
      this.registerInFlight = null;
    });
    return this.registerInFlight;
  }

  isRegistered(): boolean {
    return this.registered && !!this.socket?.connected;
  }

  sendOffer(roomId: string, targetPeerId: string, sdp: string): void {
    this.socket?.emit('offer', { roomId, targetPeerId, sdp });
  }

  sendAnswer(targetPeerId: string, sdp: string): void {
    this.socket?.emit('answer', { targetPeerId, sdp });
  }

  sendIceCandidate(targetPeerId: string, candidate: Record<string, unknown>): void {
    this.socket?.emit('ice-candidate', { targetPeerId, candidate });
  }

  sendHangup(targetPeerId: string): void {
    this.socket?.emit('hangup', { targetPeerId });
  }

  onOffer(handler: (msg: OfferPayload) => void): void {
    this.socket?.off('offer');
    this.socket?.on('offer', handler);
  }

  onAnswer(handler: (msg: AnswerPayload) => void): void {
    this.socket?.off('answer');
    this.socket?.on('answer', handler);
  }

  onIceCandidate(handler: (msg: IcePayload) => void): void {
    this.socket?.off('ice-candidate');
    this.socket?.on('ice-candidate', handler);
  }

  onHangup(handler: (msg: HangupPayload) => void): void {
    this.socket?.off('hangup');
    this.socket?.on('hangup', handler);
  }

  onPeerUnavailable(handler: (msg: { targetPeerId: string; roomId: string }) => void): void {
    this.socket?.off('peer_unavailable');
    this.socket?.on('peer_unavailable', handler);
  }

  /** @deprecated use register(roomId, peerId) */
  async registerPeer(_peerId: string): Promise<void> {
    throw new Error('registerPeer requires an authenticated key pair');
  }

  /** @deprecated not used with new server */
  async findPeer(_peerId: string): Promise<boolean> {
    return false;
  }

  /** @deprecated Use onOffer() instead. Replaces any existing offer listener. */
  onRemoteSignal(handler: (fromPeerId: string, msg: SignalMessage) => void): void {
    this.socket?.off('offer');
    this.socket?.on('offer', (msg: OfferPayload) => {
      handler(msg.fromPeerId ?? '', { type: 'offer', payload: msg.sdp });
    });
  }

  async sendSignal(targetPeerId: string, msg: SignalMessage): Promise<void> {
    await this.connect();
    if (msg.type === 'offer') {
      this.socket?.emit('offer', { roomId: 'default', targetPeerId, sdp: msg.payload });
    } else if (msg.type === 'answer') {
      this.sendAnswer(targetPeerId, msg.payload);
    } else {
      // v4.32.186 (Round-16 #8): guard legacy candidate path against malformed JSON;
      // a single bad payload no longer crashes the signaling pipeline.
      let cand: Record<string, unknown> | null = null;
      // v4.32.198 (Round-28 #10): byte-cap ICE candidate payload before
      // JSON.parse. A compromised signaling server could inject multi-MB
      // JSON and stall the JS thread; legit ICE candidates are <1 KB.
      if (typeof msg.payload !== 'string' || msg.payload.length > 8192) {
        log.warn('webrtc_signal_candidate_oversize', { size: typeof msg.payload === 'string' ? msg.payload.length : -1 });
        return;
      }
      try {
        const parsed = JSON.parse(msg.payload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cand = parsed as Record<string, unknown>;
        }
      } catch (e) {
        log.warn('webrtc_signal_candidate_parse_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      if (cand) this.sendIceCandidate(targetPeerId, cand);
    }
  }

  disconnect(): void {
    this.registration = null;
    this.registered = false;
    this.registrationChallenge = null;
    for (const waiter of this.challengeWaiters.splice(0)) {
      waiter.reject(new Error('signaling_disconnected'));
    }
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

// v4.32.377: здесь стояли createSignalingFromConfig (свой, второй способ
// собрать WebRTCSignaling из конфига — callService собирает его сам) и
// publishSignal, который ничего не публиковал, а логировал
// 'webrtc_signaling_legacy_stub' и возвращал false. Не вызывал ни один из них
// никто.
