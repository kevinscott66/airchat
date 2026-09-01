/**
 * CallOverlay - full-screen UI for voice and video calls.
 * WebRTC ownership stays in callService; this component renders its snapshots.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, StatusBar, Vibration, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { AppPressable } from './AppPressable';
import { callTone, mediaScrim, type CallTone } from '../theme';
import { AppModal as Modal } from './AppModal';
import { setAudioModeAsync } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import {
  subscribeCall,
  subscribeCallMedia,
  getCallMediaStreams,
  acceptCall,
  hangupCall,
  toggleMute,
  toggleCamera,
  switchCamera,
  hasLocalVideoTrack,
  updateIncomingCallerName,
  type CallInfo,
  type CallMediaState,
  type CallMediaStream,
} from '../../core/social/callService';
import { listContacts } from '../../core/social/contacts';
import { log } from '../../core/logger';
import { formatClockDuration } from '../time/durationLabel';
import { nameInitials } from '../../core/social/contactLabel';
import { rawErrorText } from './userErrorText';
import { showError } from './userFeedback';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

type RtcViewProps = {
  style?: StyleProp<ViewStyle>;
  streamURL?: string;
  objectFit?: 'contain' | 'cover';
  mirror?: boolean;
  zOrder?: number;
  accessibilityLabel?: string;
};

type RtcViewComponent = React.ComponentType<RtcViewProps>;

function loadRtcView(): RtcViewComponent | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-webrtc').RTCView as RtcViewComponent;
  } catch {
    return null;
  }
}

const RtcView = loadRtcView();

function CallerAvatar({ name, tone, compact = false }: { name: string; tone: CallTone; compact?: boolean }): React.ReactElement {
  const initials = nameInitials(name);
  return (
    <View style={[av.circle, compact && av.compactCircle, { backgroundColor: tone.avatarFill }]}>
      <Text style={[av.text, compact && av.compactText, { color: tone.avatarInk }]}>{initials}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  circle: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  compactCircle: { width: 64, height: 64, borderRadius: 32, marginBottom: 0 },
  text: { fontSize: 36, fontWeight: '700' },
  compactText: { fontSize: 24 },
});

function RingingRings({ tone }: { tone: CallTone }): React.ReactElement {
  return (
    <View style={ring.rings} pointerEvents="none">
      {[1, 0.7, 0.45].map((scale, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            width: 160 * scale,
            height: 160 * scale,
            borderRadius: 80 * scale,
            borderWidth: 1.5,
            borderColor: tone.ring,
          }}
        />
      ))}
    </View>
  );
}

function streamUrl(stream: CallMediaStream | null): string | null {
  if (!stream?.toURL) return null;
  try {
    const url = stream.toURL();
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function CallControl({ icon, label, tone, active = false, onPress }: {
  icon: IoniconName;
  label: string;
  tone: CallTone;
  active?: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <AppPressable
      style={[s.controlBtn, { backgroundColor: active ? tone.chipActive : tone.chip }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={icon} size={24} color={tone.ink} />
      <Text style={[s.controlLabel, { color: tone.ink }]}>{label}</Text>
    </AppPressable>
  );
}

function VideoFallback({ call, tone, stateLabel, incoming }: { call: CallInfo; tone: CallTone; stateLabel: string; incoming: boolean }): React.ReactElement {
  return (
    <View style={s.videoFallback}>
      {incoming && <RingingRings tone={tone} />}
      <CallerAvatar name={call.peerName} tone={tone} />
      <Text style={[s.videoFallbackName, { color: mediaScrim.ink }]}>{call.peerName}</Text>
      <Text style={[s.videoFallbackLabel, { color: mediaScrim.inkMuted }]}>{stateLabel}</Text>
    </View>
  );
}

export function CallOverlay(): React.ReactElement | null {
  const [call, setCall] = useState<CallInfo | null>(null);
  const [media, setMedia] = useState<CallMediaState>(() => ({
    ...getCallMediaStreams(),
    localAudioEnabled: true,
    localVideoEnabled: true,
  }));
  const [speakerOn, setSpeakerOn] = useState(false);
  const [frontCamera, setFrontCamera] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => subscribeCallMedia(setMedia), []);

  useEffect(() => {
    const unsubscribe = subscribeCall((info) => {
      setCall(info);
      if (info?.state === 'incoming') Vibration.vibrate([0, 500, 500, 500, 500, 500], true);
      else Vibration.cancel();

      if (info?.state === 'connected' && info.connectedAt) {
        if (timerRef.current) clearInterval(timerRef.current);
        setElapsed(Date.now() - info.connectedAt);
        timerRef.current = setInterval(() => setElapsed(Date.now() - (info.connectedAt ?? Date.now())), 1000);
      } else {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setElapsed(0);
      }

      if (!info || info.state === 'idle' || info.state === 'ended') {
        setSpeakerOn(false);
        setFrontCamera(true);
        void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: false }).catch(() => {});
      } else if (info.state === 'connected') {
        void setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: !speakerOn }).catch(() => {});
      }
    });
    return () => {
      unsubscribe();
      if (timerRef.current) clearInterval(timerRef.current);
      Vibration.cancel();
    };
  }, [speakerOn]);

  const nameResolvedForRef = useRef<string | null>(null);
  useEffect(() => {
    const peer = call?.peerPubB64;
    if (!peer) {
      nameResolvedForRef.current = null;
      return;
    }
    if (call?.state !== 'incoming' || nameResolvedForRef.current === peer) return;
    nameResolvedForRef.current = peer;
    let cancelled = false;
    void (async () => {
      try {
        const contacts = await listContacts();
        if (cancelled) return;
        const name = contacts.find((contact) => contact.peerPublicKey === peer)?.displayName?.trim();
        if (name) updateIncomingCallerName(peer, name);
      } catch (error) {
        log.warn('call_caller_name_resolve_failed', { err: rawErrorText(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [call?.peerPubB64, call?.state]);

  const onAccept = useCallback(() => {
    Vibration.cancel();
    void acceptCall()
      .then((ok) => { if (!ok) showError('Не удалось принять звонок'); })
      .catch((error) => {
        log.warn('call_accept_ui_failed', { err: rawErrorText(error) });
        showError('Не удалось принять звонок');
      });
  }, []);
  const onHangup = useCallback(() => { Vibration.cancel(); void hangupCall(); }, []);
  const onMute = useCallback(() => { toggleMute(); }, []);
  const onVideoToggle = useCallback(() => {
    if (!hasLocalVideoTrack()) {
      showError('Камера недоступна');
      return;
    }
    toggleCamera();
  }, []);
  const onCameraFlip = useCallback(() => {
    if (switchCamera()) setFrontCamera((current) => !current);
    else showError('Переключение камеры недоступно');
  }, []);
  const onSpeakerToggle = useCallback(() => {
    setSpeakerOn((current) => {
      const next = !current;
      void setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: !next }).catch(() => {});
      return next;
    });
  }, []);

  if (!call || call.state === 'idle') return null;

  const isIncoming = call.state === 'incoming';
  const isOutgoing = call.state === 'outgoing';
  const isConnected = call.state === 'connected';
  const isEnded = call.state === 'ended';
  const tone = callTone(isEnded ? 'ended' : 'active');
  const stateLabel = isIncoming
    ? (call.isVideo ? 'Входящий видеозвонок' : 'Входящий звонок…')
    : isOutgoing
      ? 'Подключение…'
      : isConnected
        ? formatClockDuration(elapsed)
        : 'Звонок завершён';
  const localUrl = streamUrl(media.localStream);
  const remoteUrl = streamUrl(media.remoteStream);
  const hasLocalVideo = call.isVideo && !!localUrl;
  const hasRemoteVideo = call.isVideo && !!remoteUrl && !!RtcView;
  const showCallControls = !isIncoming && !isEnded && !!media.localStream;

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={onHangup}>
      <StatusBar barStyle="light-content" backgroundColor={hasRemoteVideo ? mediaScrim.fill : tone.fill} />
      <View style={[s.container, { backgroundColor: hasRemoteVideo ? mediaScrim.fill : tone.fill }]}>
        {call.isVideo ? (
          <View style={s.videoStage}>
            {hasRemoteVideo && RtcView ? (
              <RtcView style={s.remoteVideo} streamURL={remoteUrl ?? undefined} objectFit="cover" zOrder={0} accessibilityLabel="Видео собеседника" />
            ) : (
              <VideoFallback call={call} tone={tone} stateLabel={stateLabel} incoming={isIncoming} />
            )}
            <View style={s.videoHeader} pointerEvents="none">
              <Text style={[s.videoPeerName, { color: mediaScrim.ink }]} numberOfLines={1}>{call.peerName}</Text>
              <Text style={[s.videoState, { color: mediaScrim.inkMuted }]}>{stateLabel}</Text>
            </View>
            {hasLocalVideo && media.localVideoEnabled && RtcView ? (
              <View style={s.localPreviewFrame}>
                <RtcView style={s.localPreview} streamURL={localUrl ?? undefined} objectFit="cover" mirror={frontCamera} zOrder={1} accessibilityLabel="Предпросмотр вашей камеры" />
              </View>
            ) : hasLocalVideo ? (
              <View style={[s.localPreviewFrame, s.localVideoOff, { backgroundColor: tone.chip }]}>
                <Ionicons name="videocam-off" size={24} color={tone.ink} />
                <Text style={[s.localVideoOffText, { color: tone.ink }]}>Камера выключена</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={s.audioStage}>
            {isIncoming && <RingingRings tone={tone} />}
            <CallerAvatar name={call.peerName} tone={tone} />
            <Text style={[s.callerName, { color: tone.ink }]}>{call.peerName}</Text>
            <Text style={[s.stateLabel, { color: tone.inkMuted }]}>{stateLabel}</Text>
          </View>
        )}

        <View style={[s.controls, call.isVideo && s.videoControls]}>
          {showCallControls && (
            <View style={s.controlRow}>
              <CallControl icon={media.localAudioEnabled ? 'mic' : 'mic-off'} label={media.localAudioEnabled ? 'Микрофон' : 'Без звука'} tone={tone} active={!media.localAudioEnabled} onPress={onMute} />
              <CallControl icon={speakerOn ? 'volume-high' : 'volume-medium'} label={speakerOn ? 'Динамик' : 'Трубка'} tone={tone} active={speakerOn} onPress={onSpeakerToggle} />
              {call.isVideo && (
                <>
                  <CallControl icon={media.localVideoEnabled ? 'videocam' : 'videocam-off'} label={media.localVideoEnabled ? 'Камера' : 'Без видео'} tone={tone} active={!media.localVideoEnabled} onPress={onVideoToggle} />
                  <CallControl icon="camera-reverse" label="Сменить камеру" tone={tone} onPress={onCameraFlip} />
                </>
              )}
            </View>
          )}

          <View style={s.hangupRow}>
            {isIncoming && (
              <View style={s.answerAction}>
                <AppPressable style={[s.roundBtn, { backgroundColor: tone.accept }]} onPress={onAccept} accessibilityRole="button" accessibilityLabel="Принять">
                  <Ionicons name="call" size={30} color={tone.acceptInk} />
                </AppPressable>
                <Text style={[s.incomingLabel, { color: tone.inkMuted }]}>Принять</Text>
              </View>
            )}
            <View style={s.answerAction}>
              <AppPressable style={[s.roundBtn, { backgroundColor: tone.hangup }]} onPress={onHangup} accessibilityRole="button" accessibilityLabel={isEnded ? 'Закрыть' : 'Отклонить'}>
                <Ionicons name={isEnded ? 'close' : 'call'} size={30} color={tone.hangupInk} style={isEnded ? undefined : s.rotateIcon} />
              </AppPressable>
              {isIncoming && <Text style={[s.incomingLabel, { color: tone.inkMuted }]}>Отклонить</Text>}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ring = StyleSheet.create({
  rings: { position: 'absolute', width: 160, height: 160, alignItems: 'center', justifyContent: 'center' },
});

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingTop: 56, paddingBottom: 40 },
  audioStage: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  callerName: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  stateLabel: { fontSize: 16, textAlign: 'center' },
  videoStage: { flex: 1, width: '100%', overflow: 'hidden', backgroundColor: mediaScrim.fill },
  remoteVideo: { ...StyleSheet.absoluteFillObject },
  videoFallback: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: mediaScrim.fill },
  videoFallbackName: { fontSize: 24, fontWeight: '700', marginTop: 16 },
  videoFallbackLabel: { fontSize: 16, marginTop: 8 },
  videoHeader: { position: 'absolute', top: 18, left: 20, right: 20 },
  videoPeerName: { fontSize: 20, fontWeight: '700' },
  videoState: { fontSize: 14, marginTop: 4 },
  localPreviewFrame: { position: 'absolute', right: 16, bottom: 18, width: 112, height: 164, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: mediaScrim.ink, backgroundColor: mediaScrim.fill },
  localPreview: { flex: 1 },
  localVideoOff: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  localVideoOffText: { fontSize: 12, textAlign: 'center', marginTop: 8 },
  controls: { width: '100%', alignItems: 'center', gap: 18 },
  videoControls: { paddingTop: 16, paddingBottom: 4, backgroundColor: mediaScrim.bar },
  controlRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap', columnGap: 14, rowGap: 12, paddingHorizontal: 12 },
  controlBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: 36, minWidth: 76, minHeight: 72 },
  controlLabel: { fontSize: 11, marginTop: 5, textAlign: 'center' },
  hangupRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', columnGap: 48 },
  answerAction: { alignItems: 'center' },
  incomingLabel: { fontSize: 13, minWidth: 72, textAlign: 'center', marginTop: 8 },
  roundBtn: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  rotateIcon: { transform: [{ rotate: '135deg' }] },
});
