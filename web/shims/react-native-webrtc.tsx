/**
 * Веб-замена `react-native-webrtc`.
 *
 * Сам `react-native-webrtc` — это порт браузерного WebRTC на нативные
 * платформы, поэтому в браузере он не нужен: `RTCPeerConnection`,
 * `RTCSessionDescription`, `RTCIceCandidate` и `navigator.mediaDevices` уже
 * есть как глобальные. Модуль лишь отдаёт их под теми же именами и добавляет
 * две вещи, которых в вебе нет по-другому:
 *
 *   1. `MediaStream.prototype.toURL()` — на нативе им пользуется UI, чтобы
 *      передать поток в `RTCView` строкой. Здесь строка становится ключом в
 *      реестре потоков, а не blob-URL: `URL.createObjectURL(MediaStream)`
 *      удалён из браузеров, `<video srcObject>` — единственный рабочий путь.
 *   2. `RTCView` — компонент поверх `<video>`, повторяющий пропсы нативного
 *      (`streamURL`, `objectFit`, `mirror`, `zOrder`).
 *
 * Ограничение: getUserMedia работает только в secure context (https или
 * localhost). В обычном http `navigator.mediaDevices` отсутствует вовсе —
 * `getUserMedia` тогда отклоняется явной ошибкой, а не падает на undefined.
 */
import React, { useEffect, useRef } from 'react';

type StyleProp = Record<string, unknown> | Array<unknown> | undefined;

/**
 * Реестр «строка → поток» для RTCView.
 *
 * Ключом служит `MediaStream.id` — он уникален в пределах документа и живёт
 * ровно столько же, сколько сам поток. Записи снимаются в `removeStream`,
 * который зовёт RTCView при размонтировании.
 */
const streamRegistry = new Map<string, MediaStream>();

const STREAM_URL_PREFIX = 'airchat-stream:';

function registerStream(stream: MediaStream): string {
  const url = `${STREAM_URL_PREFIX}${stream.id}`;
  streamRegistry.set(url, stream);
  return url;
}

function resolveStream(url: string | undefined): MediaStream | null {
  if (!url) return null;
  return streamRegistry.get(url) ?? null;
}

// Патч ставится один раз на прототип, а не на каждый поток: удалённый поток
// приходит из события `track` уже готовым объектом, обернуть его негде.
if (typeof MediaStream !== 'undefined') {
  const proto = MediaStream.prototype as MediaStream & { toURL?: () => string };
  if (typeof proto.toURL !== 'function') {
    proto.toURL = function toURL(this: MediaStream): string {
      return registerStream(this);
    };
  }
}

export type RTCViewProps = {
  style?: StyleProp;
  streamURL?: string;
  objectFit?: 'contain' | 'cover';
  mirror?: boolean;
  zOrder?: number;
  accessibilityLabel?: string;
};

export function RTCView({
  style,
  streamURL,
  objectFit = 'cover',
  mirror = false,
  zOrder,
  accessibilityLabel,
}: RTCViewProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const stream = resolveStream(streamURL);
    el.srcObject = stream;
    if (stream) {
      // autoplay без явного play() блокируется, если вкладка ещё не получала
      // жеста; отказ здесь не фатален — кадр появится после первого клика.
      void el.play().catch(() => undefined);
    }
    return () => {
      el.srcObject = null;
    };
  }, [streamURL]);

  return (
    <video
      ref={videoRef}
      aria-label={accessibilityLabel}
      autoPlay
      playsInline
      // Локальный превью всегда без звука, иначе получается эхо; удалённый
      // поток звучит. Отличаем по mirror — им помечают именно свою камеру.
      muted={mirror}
      style={{
        objectFit,
        transform: mirror ? 'scaleX(-1)' : undefined,
        zIndex: zOrder,
        width: '100%',
        height: '100%',
        backgroundColor: 'transparent',
        ...(style as React.CSSProperties),
      }}
    />
  );
}

export const mediaDevices = {
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('getusermedia_requires_secure_context');
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Регистрируем сразу: UI зовёт toURL() уже после того, как отдал поток в
    // состояние, и лишний вызов не должен плодить второй ключ.
    registerStream(stream);
    return stream;
  },
  async getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('getdisplaymedia_unavailable');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    registerStream(stream);
    return stream;
  },
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    return navigator.mediaDevices.enumerateDevices();
  },
};

/**
 * Снять поток с реестра. Нативный модуль освобождает такие ссылки сам, здесь
 * это делает вызывающий — иначе Map держит завершённые потоки до перезагрузки.
 */
export function removeStream(streamURL: string): void {
  streamRegistry.delete(streamURL);
}

const G = globalThis as unknown as {
  RTCPeerConnection: typeof RTCPeerConnection;
  RTCSessionDescription: typeof RTCSessionDescription;
  RTCIceCandidate: typeof RTCIceCandidate;
  MediaStream: typeof MediaStream;
  MediaStreamTrack: typeof MediaStreamTrack;
};

export const RTCPeerConnectionShim = G.RTCPeerConnection;
export {
  RTCPeerConnectionShim as RTCPeerConnection,
};
export const RTCSessionDescriptionShim = G.RTCSessionDescription;
export { RTCSessionDescriptionShim as RTCSessionDescription };
export const RTCIceCandidateShim = G.RTCIceCandidate;
export { RTCIceCandidateShim as RTCIceCandidate };
export const MediaStreamShim = G.MediaStream;
export { MediaStreamShim as MediaStream };
export const MediaStreamTrackShim = G.MediaStreamTrack;
export { MediaStreamTrackShim as MediaStreamTrack };

/**
 * На нативе `registerGlobals()` подкладывает WebRTC-классы в globalThis.
 * В браузере они там изначально — вызов остаётся ради совместимости вызова.
 */
export function registerGlobals(): void {
  /* no-op: браузер уже всё зарегистрировал */
}

export default {
  RTCPeerConnection: G.RTCPeerConnection,
  RTCSessionDescription: G.RTCSessionDescription,
  RTCIceCandidate: G.RTCIceCandidate,
  MediaStream: G.MediaStream,
  MediaStreamTrack: G.MediaStreamTrack,
  RTCView,
  mediaDevices,
  registerGlobals,
};
