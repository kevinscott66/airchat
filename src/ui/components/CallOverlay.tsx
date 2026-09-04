/**
 * CallOverlay - full-screen UI for voice and video calls.
 * WebRTC ownership stays in callService; this component renders its snapshots.
 *
 * v4.32.587. Оформление приведено к языку приложения — «жидкому стеклу».
 *
 * Стекло здесь не косметика поверх прежнего экрана, а два разных рецепта,
 * и разделены они не по вкусу, а по тому, ЧТО лежит под панелью:
 *
 *   • над чужим кадром (видео собеседника) заливка панели — `mediaScrim.bar`.
 *     Кадр произвольный, худший случай белый, и единственная величина, о
 *     которой в этом файле есть доказанное утверждение, — это 0.6 чёрного:
 *     она даёт белым чернилам 5.2:1 даже поверх белой фотографии (см. токен и
 *     themeContrast.test.ts). Выводить прозрачность «на глаз» над кадром
 *     нельзя — там не из чего выводить.
 *
 *   • над собственным фоном звонка заливка выводится из `callTone`. Итоговый
 *     цвет полупрозрачной панели лежит МЕЖДУ токеном и фоном, а фон темнее
 *     токена (и `chip`, и `chipActive` — это осветление `fill`). То есть
 *     эффективная подложка не светлее той, на которой themeContrast мерил
 *     подписи, и порог 4.5:1 сохраняется в ту сторону, в какую он должен
 *     сохраняться.
 *
 * И главное: размытие показывает то, что под ним. Над РОВНОЙ заливкой под ним
 * нет ничего, и «стеклянная» панель над ней — просто панель другого оттенка.
 * Поэтому у звука появилась подложка `CallBackdrop`: два мягких пятна из
 * `tone.washA/washB`, которые размытию есть что размывать. Без неё стекло
 * пришлось бы рисовать, а не получать.
 *
 * Системное «уменьшить прозрачность» выключает размытие целиком и делает
 * заливки глухими — ровно как в `GlassSurface`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View, Text, StyleSheet, StatusBar, Vibration, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import { AppPressable } from './AppPressable';
import { avatarShape, callTone, callWash, font, glass, mediaScrim, radius, spacing, withAlpha, type CallTone } from '../theme';
import { AppModal as Modal } from './AppModal';
import { useReducedMotion, useReducedTransparency } from '../motionPrefs';
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
  // На web `react-native-webrtc` подменяется на web/shims/react-native-webrtc.tsx
  // (см. WEB_SHIMS в metro.config.js): там RTCView — это <video srcObject>,
  // то есть настоящее видео, а не заглушка. Раньше здесь стоял безусловный
  // выход по Platform.OS === 'web', потому что нативного модуля в браузере нет
  // и require падал; теперь есть что грузить, и ветка не нужна — try/catch
  // ниже по-прежнему держит случай, когда модуля нет совсем.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-webrtc').RTCView as RtcViewComponent;
  } catch {
    return null;
  }
}

const RtcView = loadRtcView();

/**
 * Подсветка под фоном звонка: то, что размывает стекло.
 *
 * Живёт ВНУТРИ сцены (портрет и имя), а не в корне экрана, и это не вёрстка,
 * а требование контраста. Фон идущего звонка выведен из того же зелёного, что
 * и кнопка «принять», и подходит к порогу графики 3:1 впритык: любое
 * осветление под круглыми кнопками уводит их за порог. Поэтому область
 * действий остаётся на ровной заливке, а светится только верх экрана.
 *
 * Слой — во всю страницу, БЕЗ отступов контейнера. В 587-й он лежал внутри
 * `s.audioStage`, у которого сверху 56 точек паддинга родителя, а снизу —
 * панель кнопок; SVG режется по своему вьюпорту, и поперёк экрана шёл
 * видимый шов ровно по этой границе. Границу теперь держит геометрия пятен
 * (`callWash.bottomPct`), а не обрезка.
 *
 * И геометрия, и пиковые непрозрачности живут в `callWash` — там же записано,
 * из каких замеров они взяты. Проверяется в themeContrast.test.ts.
 */
function CallBackdrop({ tone }: { tone: CallTone }): React.ReactElement {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <RadialGradient id="call-wash-a" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={tone.washA} stopOpacity={callWash.a.peak} />
          <Stop offset="0.55" stopColor={tone.washA} stopOpacity={callWash.a.mid} />
          <Stop offset="1" stopColor={tone.washA} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="call-wash-b" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={tone.washB} stopOpacity={callWash.b.peak} />
          <Stop offset="0.55" stopColor={tone.washB} stopOpacity={callWash.b.mid} />
          <Stop offset="1" stopColor={tone.washB} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* Пятна шире экрана и выходят за его левый, правый и верхний края:
          иначе виден край самого пятна, а он должен быть незаметен. Снизу
          наоборот — край обязан остаться внутри экрана и выше кнопок. */}
      <Ellipse cx={`${callWash.a.cx}%`} cy={`${callWash.a.cy}%`} rx={`${callWash.a.rx}%`} ry={`${callWash.a.ry}%`} fill="url(#call-wash-a)" />
      <Ellipse cx={`${callWash.b.cx}%`} cy={`${callWash.b.cy}%`} rx={`${callWash.b.rx}%`} ry={`${callWash.b.ry}%`} fill="url(#call-wash-b)" />
    </Svg>
  );
}

/**
 * Стеклянная панель экрана звонка: размытие, полупрозрачная заливка и кромки.
 *
 * `overMedia` выбирает рецепт (см. шапку файла). Кромки — те же, что у
 * `GlassSurface`: светлая сверху, тёмная снизу; именно они и отличают стекло
 * от матового окна, показывая толщину.
 */
function CallGlass({ tone, fill, overMedia = false, style, children, ...viewProps }: ViewProps & {
  tone: CallTone;
  fill: string;
  overMedia?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}): React.ReactElement {
  const solid = useReducedTransparency();
  const background = solid || overMedia ? fill : withAlpha(fill, glass.fill.prominent);
  return (
    <View {...viewProps} style={[cg.panel, { backgroundColor: background, borderColor: withAlpha(tone.ink, glass.rim) }, style]}>
      {solid ? null : (
        <BlurView pointerEvents="none" intensity={glass.intensity.prominent} tint="dark" style={StyleSheet.absoluteFill} />
      )}
      <View pointerEvents="none" style={[cg.rim, { backgroundColor: withAlpha(tone.ink, glass.rim) }]} />
      <View pointerEvents="none" style={[cg.shade, { backgroundColor: withAlpha(glass.shadeInk, glass.shade) }]} />
      {children}
    </View>
  );
}

const cg = StyleSheet.create({
  panel: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  rim: { position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth * 2 },
  shade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth * 2 },
});

function CallerAvatar({ name, tone, compact = false }: { name: string; tone: CallTone; compact?: boolean }): React.ReactElement {
  const initials = nameInitials(name);
  return (
    <View style={[av.circle, compact && av.compactCircle, { backgroundColor: tone.avatarFill, borderColor: withAlpha(tone.ink, glass.rim) }]}>
      <Text style={[av.text, compact && av.compactText, { color: tone.avatarInk }]}>{initials}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  circle: { ...avatarShape(100), alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl, borderWidth: StyleSheet.hairlineWidth },
  compactCircle: { ...avatarShape(64), marginBottom: 0 },
  text: { fontSize: 36, fontWeight: '700' },
  compactText: { fontSize: font.xxl },
});

/**
 * Кольца входящего вызова.
 *
 * Кольца ПУЛЬСИРУЮТ: входящий звонок — единственное состояние экрана, которое
 * требует ответа прямо сейчас, и движение здесь несёт этот смысл, а не украшает.
 * При системном «уменьшить движение» пульсация не запускается вовсе, и кольца
 * остаются такими же, какими были до 587-й, — статичными.
 */
function RingingRings({ tone }: { tone: CallTone }): React.ReactElement {
  const still = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 2200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, still]);

  return (
    <View style={ring.rings} pointerEvents="none">
      {[1, 0.7, 0.45].map((scale, i) => (
        <Animated.View
          key={i}
          style={[
            ring.circle,
            {
              width: 160 * scale,
              height: 160 * scale,
              borderRadius: radius.full,
              borderColor: tone.ring,
              opacity: still ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.15] }),
              transform: [{ scale: still ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
            },
          ]}
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

function CallControl({ icon, label, tone, overMedia, active = false, onPress }: {
  icon: IoniconName;
  label: string;
  tone: CallTone;
  overMedia: boolean;
  active?: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <AppPressable
      style={s.controlSlot}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <CallGlass
        tone={tone}
        fill={active ? tone.chipActive : tone.chip}
        // Над кадром нажатая кнопка обязана оставаться отличимой от ненажатой,
        // а прозрачная заливка поверх произвольного видео этого не гарантирует:
        // на пёстром кадре обе читаются как «немного мутное пятно». Поэтому
        // над видео заливка глухая — различие несёт она, а не подложка.
        overMedia={overMedia}
        style={s.controlBtn}
      >
        <Ionicons name={icon} size={24} color={tone.ink} />
        <Text style={[s.controlLabel, { color: tone.ink }]}>{label}</Text>
      </CallGlass>
    </AppPressable>
  );
}

function VideoFallback({ call, tone, stateLabel, incoming }: { call: CallInfo; tone: CallTone; stateLabel: string; incoming: boolean }): React.ReactElement {
  return (
    <View style={s.videoFallback}>
      <CallBackdrop tone={tone} />
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

  const phase = call?.state === 'ended' ? 'ended' : 'active';
  const tone = useMemo(() => callTone(phase), [phase]);

  if (!call || call.state === 'idle') return null;

  const isIncoming = call.state === 'incoming';
  const isOutgoing = call.state === 'outgoing';
  const isConnected = call.state === 'connected';
  const isEnded = call.state === 'ended';
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
      <View style={[s.root, { backgroundColor: hasRemoteVideo ? mediaScrim.fill : tone.fill }]}>
        {/* Подсветка — отдельным слоем НАД заливкой и ПОД содержимым, во всю
            страницу. Внутри `s.container` её держать нельзя: у того есть
            отступы, а SVG режется по вьюпорту — отсюда и был шов. */}
        {!call.isVideo && <CallBackdrop tone={tone} />}
        <View style={s.container}>
          {call.isVideo ? (
            <View style={s.videoStage}>
              {hasRemoteVideo && RtcView ? (
                <RtcView style={s.remoteVideo} streamURL={remoteUrl ?? undefined} objectFit="cover" zOrder={0} accessibilityLabel="Видео собеседника" />
              ) : (
                <VideoFallback call={call} tone={tone} stateLabel={stateLabel} incoming={isIncoming} />
              )}
              <CallGlass tone={tone} fill={mediaScrim.bar} overMedia={hasRemoteVideo} style={s.videoHeader} pointerEvents="none">
                <Text style={[s.videoPeerName, { color: mediaScrim.ink }]} numberOfLines={1}>{call.peerName}</Text>
                <Text style={[s.videoState, { color: mediaScrim.inkMuted }]}>{stateLabel}</Text>
              </CallGlass>
              {hasLocalVideo && media.localVideoEnabled && RtcView ? (
                <View style={[s.localPreviewFrame, { borderColor: withAlpha(mediaScrim.ink, glass.rim) }]}>
                  <RtcView style={s.localPreview} streamURL={localUrl ?? undefined} objectFit="cover" mirror={frontCamera} zOrder={1} accessibilityLabel="Предпросмотр вашей камеры" />
                </View>
              ) : hasLocalVideo ? (
                <CallGlass tone={tone} fill={tone.chip} overMedia={hasRemoteVideo} style={[s.localPreviewFrame, s.localVideoOff]}>
                  <Ionicons name="videocam-off" size={24} color={tone.ink} />
                  <Text style={[s.localVideoOffText, { color: tone.ink }]}>Камера выключена</Text>
                </CallGlass>
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

          <View style={s.controls}>
            {showCallControls && (
              <View style={s.controlRow}>
                <CallControl icon={media.localAudioEnabled ? 'mic' : 'mic-off'} label={media.localAudioEnabled ? 'Микрофон' : 'Без звука'} tone={tone} overMedia={hasRemoteVideo} active={!media.localAudioEnabled} onPress={onMute} />
                <CallControl icon={speakerOn ? 'volume-high' : 'volume-medium'} label={speakerOn ? 'Динамик' : 'Трубка'} tone={tone} overMedia={hasRemoteVideo} active={speakerOn} onPress={onSpeakerToggle} />
                {call.isVideo && (
                  <>
                    <CallControl icon={media.localVideoEnabled ? 'videocam' : 'videocam-off'} label={media.localVideoEnabled ? 'Камера' : 'Без видео'} tone={tone} overMedia={hasRemoteVideo} active={!media.localVideoEnabled} onPress={onVideoToggle} />
                    <CallControl icon="camera-reverse" label="Сменить камеру" tone={tone} overMedia={hasRemoteVideo} onPress={onCameraFlip} />
                  </>
                )}
              </View>
            )}

            <View style={s.hangupRow}>
              {isIncoming && (
                <View style={s.answerAction}>
                  <AppPressable style={[s.roundBtn, { backgroundColor: tone.accept, borderColor: withAlpha(tone.acceptInk, glass.rim) }]} onPress={onAccept} accessibilityRole="button" accessibilityLabel="Принять">
                    <Ionicons name="call" size={30} color={tone.acceptInk} />
                  </AppPressable>
                  <Text style={[s.incomingLabel, { color: tone.inkMuted }]}>Принять</Text>
                </View>
              )}
              <View style={s.answerAction}>
                <AppPressable style={[s.roundBtn, { backgroundColor: tone.hangup, borderColor: withAlpha(tone.hangupInk, glass.rim) }]} onPress={onHangup} accessibilityRole="button" accessibilityLabel={isEnded ? 'Закрыть' : 'Отклонить'}>
                  <Ionicons name={isEnded ? 'close' : 'call'} size={30} color={tone.hangupInk} style={isEnded ? undefined : s.rotateIcon} />
                </AppPressable>
                {isIncoming && <Text style={[s.incomingLabel, { color: tone.inkMuted }]}>Отклонить</Text>}
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ring = StyleSheet.create({
  rings: { position: 'absolute', width: 160, height: 160, alignItems: 'center', justifyContent: 'center' },
  circle: { position: 'absolute', borderWidth: 1.5 },
});

const s = StyleSheet.create({
  // `root` — заливка и подсветка во всю страницу; `container` — содержимое с
  // отступами. Разделены ровно ради этого: подсветке нужен полный экран.
  root: { flex: 1 },
  container: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingTop: 56, paddingBottom: 40 },
  audioStage: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  callerName: { fontSize: font.xxl, fontWeight: '700', textAlign: 'center', marginBottom: spacing.sm },
  stateLabel: { fontSize: font.md, textAlign: 'center' },
  videoStage: { flex: 1, width: '100%', overflow: 'hidden', backgroundColor: mediaScrim.fill },
  remoteVideo: { ...StyleSheet.absoluteFillObject },
  videoFallback: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: mediaScrim.fill },
  videoFallbackName: { fontSize: font.xxl, fontWeight: '700', marginTop: spacing.lg },
  videoFallbackLabel: { fontSize: font.md, marginTop: spacing.sm },
  videoHeader: { position: 'absolute', top: spacing.lg, left: spacing.lg, right: spacing.lg, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  videoPeerName: { fontSize: font.xl, fontWeight: '700' },
  videoState: { fontSize: font.sm, marginTop: spacing.xs },
  localPreviewFrame: { position: 'absolute', right: spacing.lg, bottom: spacing.lg, width: 112, height: 164, borderRadius: radius.lg, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, backgroundColor: mediaScrim.fill },
  localPreview: { flex: 1 },
  localVideoOff: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  localVideoOffText: { fontSize: font.xs, textAlign: 'center', marginTop: spacing.sm },
  controls: { width: '100%', alignItems: 'center', gap: spacing.xl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  controlRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap', columnGap: spacing.md, rowGap: spacing.md },
  controlSlot: { borderRadius: radius.lg },
  controlBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderRadius: radius.lg, minWidth: 76, minHeight: 72 },
  controlLabel: { fontSize: font.xs, marginTop: spacing.xs, textAlign: 'center' },
  hangupRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', columnGap: 48 },
  answerAction: { alignItems: 'center' },
  incomingLabel: { fontSize: font.sm, minWidth: 72, textAlign: 'center', marginTop: spacing.sm },
  roundBtn: { width: 68, height: 68, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  rotateIcon: { transform: [{ rotate: '135deg' }] },
});
