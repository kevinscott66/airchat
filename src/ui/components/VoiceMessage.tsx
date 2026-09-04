/**
 * VoiceMessage — компоненты для записи и воспроизведения голосовых сообщений.
 * VoiceRecorderButton: кнопка-микрофон в композере (зажать→запись, отпустить→отправить).
 * VoicePlayer: встроенный плеер для входящих/исходящих голосовых сообщений.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  ActivityIndicator,
  AppState,
  GestureResponderEvent,
  LayoutChangeEvent,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { AppPressable } from './AppPressable';
import {
  AudioModule,
  createAudioPlayer,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  RecordingPresets,
} from 'expo-audio';
import type { AudioRecorder, AudioPlayer } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../ThemeContext';
import { useBubbleSurface } from '../BubbleKindContext';
import { contrastingInk, fadedOn, font, radius } from '../theme';
import { deleteCachedFileUris, resolveBlobToLocalFile, type BlobRef } from '../../core/media/mediaBlob';
import { formatClockDuration } from '../time/durationLabel';
import { failed, IDLE_GATE, pressIn, pressOut, ready, type RecorderGate } from './recorderGate';
import { shouldAutoStopVoice, voiceCountdownSeconds, VOICE_MIN_MS } from './voiceLimit';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceRecordingResult = {
  uri: string;
  durationMs: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// VoiceRecorderButton
// Press-and-hold to record; release to finish.
// ─────────────────────────────────────────────────────────────────────────────

type RecorderProps = {
  onRecorded: (result: VoiceRecordingResult) => void;
  disabled?: boolean;
};

const LIVE_BARS = 20;

/**
 * Приглушение прошедших столбиков живой осциллограммы.
 *
 * v4.32.416: было `colors.error + (свежий ? 'ff' : 'aa')` — единственная
 * склейка цвета с прозрачностью, дожившая до 416-го. Уцелела она не по
 * причине, а по форме записи: храповик ищет кавычку сразу за плюсом, а здесь
 * между ними стоял тернар. Столбик — не украшение: он единственный признак
 * того, что звук вообще идёт в микрофон, поэтому порог у него графический.
 * Композер под ним — `colors.surface` и в переписке, и в группе.
 */
const TRAIL_ALPHA = 0xaa / 255;

export function VoiceRecorderButton({ onRecorded, disabled }: RecorderProps): React.ReactElement {
  const { colors } = useTheme();
  const [isRecording, setIsRecording] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [recDurationMs, setRecDurationMs] = useState(0);
  const [liveBars, setLiveBars] = useState<number[]>(Array(LIVE_BARS).fill(3));
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const startTs = useRef(0);
  const recTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const meterTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef<AudioRecorder | null>(null);
  // v4.32.493: нажатие и отпускание сверяются между собой, а не по ссылке на
  // рекордер — она появляется только после двух ожиданий (см. recorderGate).
  const gateRef = useRef<RecorderGate>(IDLE_GATE);
  // v4.32.562: запись заканчивает себя сама, дойдя до предела. Ссылка нужна
  // потому, что таймер заводится раньше, чем объявлено само окончание.
  const stopSelfRef = useRef<(() => void) | null>(null);

  // v4.32.174: check-only on mount. Раньше компонент на каждом монтировании чата
  // вызывал requestPermissionsAsync, что провоцировало системный диалог ещё до
  // того, как пользователь захотел записать голосовое. Теперь только read,
  // запрос будет при первом onPressIn.
  useEffect(() => {
    void getRecordingPermissionsAsync().then(({ granted }) => setPermissionGranted(granted));
  }, []);

  // v4.32.49: unmount cleanup — если юзер начал запись, а потом свернул
  // приложение / переключил таб / закрыл чат, setInterval'ы (recTickRef +
  // meterTickRef) и активная Audio.Recording оставались навсегда. Теперь
  // при unmount чистим таймеры и снимаем запись (stopAndUnloadAsync).
  useEffect(() => {
    return () => {
      // v4.32.493: снять намерение записывать — иначе запись, которая ещё
      // готовится, доготовится уже на мёртвом экране и останется работать.
      gateRef.current = pressOut(gateRef.current).gate;
      if (recTickRef.current) { clearInterval(recTickRef.current); recTickRef.current = null; }
      if (meterTickRef.current) { clearInterval(meterTickRef.current); meterTickRef.current = null; }
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) {
        void rec.stop()
          .then(() => rec.uri ? deleteCachedFileUris([rec.uri]) : undefined)
          .catch(() => {});
        void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      }
    };
  }, []);

  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 400, easing: Easing.ease, useNativeDriver: true, isInteraction: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 400, easing: Easing.ease, useNativeDriver: true, isInteraction: false }),
      ])
    ).start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
  }, [pulseAnim]);

  // A background transition must cancel the hold rather than submit a partial
  // recording. iOS can leave the component mounted while the app is inactive.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      gateRef.current = pressOut(gateRef.current).gate;
      stopPulse();
      setIsRecording(false);
      if (recTickRef.current) { clearInterval(recTickRef.current); recTickRef.current = null; }
      if (meterTickRef.current) { clearInterval(meterTickRef.current); meterTickRef.current = null; }
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) {
        void rec.stop()
          .then(() => rec.uri ? deleteCachedFileUris([rec.uri]) : undefined)
          .catch(() => {});
      }
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    });
    return () => subscription.remove();
  }, [stopPulse]);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    // v4.32.174: ленивый запрос. Если ещё не разрешено — просим сейчас. Отказ
    // → выходим молча, кнопка становится disabled.
    if (permissionGranted !== true) {
      const { granted } = await requestRecordingPermissionsAsync();
      setPermissionGranted(granted);
      // v4.32.228 (IB-04/IB-06): НЕ начинаем запись на том же нажатии, что вызвало
      // системный диалог разрешения. Диалог прерывает жест hold→release: палец
      // уходит на кнопку диалога, onPressOut теряется, и запись «зависала» без
      // достижимой отмены (приходилось перезапускать приложение). Поэтому первое
      // нажатие лишь запрашивает доступ; запись пойдёт со следующего осознанного
      // нажатия, когда разрешение уже выдано.
      return;
    }
    // v4.32.493: второе нажатие поверх незакрытого первого рекордера больше не
    // заводит — прежний остался бы работать, никем не остановленный.
    const press = pressIn(gateRef.current);
    gateRef.current = press.gate;
    if (!press.start) return;
    let rec: AudioRecorder | null = null;
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      rec = new AudioModule.AudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      await rec.prepareToRecordAsync();
      // v4.32.493: палец мог отпустить (или экран — закрыться), пока рекордер
      // готовился. Тогда записи здесь не место: свернуть и уйти молча.
      const ok = ready(gateRef.current, press.token);
      gateRef.current = ok.gate;
      if (!ok.keep) {
        try { await rec.stop(); } catch { /* ещё не начиналась */ }
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        return;
      }
      rec.record();
      recordingRef.current = rec;
      setIsRecording(true);
      setRecDurationMs(0);
      setLiveBars(Array(LIVE_BARS).fill(3));
      startTs.current = Date.now();
      recTickRef.current = setInterval(() => {
        const ms = Date.now() - startTs.current;
        setRecDurationMs(ms);
        // v4.32.562: дошли до предела — заканчиваем и ОТПРАВЛЯЕМ записанное.
        // Молча писать дальше значило бы готовить вложение, которое потом
        // некуда деть, и объяснять это отказом сети.
        if (shouldAutoStopVoice(ms)) stopSelfRef.current?.();
      }, 500);
      // Poll metering for live waveform
      meterTickRef.current = setInterval(() => {
        try {
          const status = recordingRef.current?.getStatus();
          if (!status?.isRecording) return;
          const level = status.metering ?? -60;
          // Map dBFS (-60..0) to bar height (3..28)
          const normalized = Math.max(0, Math.min(1, (level + 60) / 60));
          const barH = Math.round(3 + normalized * 25);
          setLiveBars((prev) => [...prev.slice(1), barH]);
        } catch { /* ignore */ }
      }, 100);
      startPulse();
    } catch {
      // permission or hardware unavailable — silently skip
      // v4.32.493: без возврата в исходное кнопка залипала бы навсегда: любое
      // следующее нажатие видело бы «уже записываю».
      gateRef.current = failed(gateRef.current, press.token);
      recordingRef.current = null;
      stopPulse();
      if (rec) {
        void rec.stop().then(() => rec?.uri ? deleteCachedFileUris([rec.uri]) : undefined).catch(() => {});
      }
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
  }, [disabled, permissionGranted, startPulse, stopPulse]);

  const stopRecording = useCallback(async () => {
    // v4.32.493: намерение снимается ПЕРВЫМ делом и независимо от того, успел
    // ли рекордер появиться. Раньше выход по пустой ссылке происходил раньше —
    // и отпускание, попавшее в окно подготовки, пропадало вместе с записью.
    const release = pressOut(gateRef.current);
    gateRef.current = release.gate;
    const rec = recordingRef.current;
    if (!release.stop || !rec) return;
    stopPulse();
    setIsRecording(false);
    if (recTickRef.current) { clearInterval(recTickRef.current); recTickRef.current = null; }
    if (meterTickRef.current) { clearInterval(meterTickRef.current); meterTickRef.current = null; }
    setRecDurationMs(0);
    setLiveBars(Array(LIVE_BARS).fill(3));
    recordingRef.current = null;
    try {
      await rec.stop();
      const uri = rec.uri;
      const durationMs = Date.now() - startTs.current;
      if (uri && durationMs > VOICE_MIN_MS) {
        onRecorded({ uri, durationMs });
      } else if (uri) {
        // A tap shorter than the minimum is not a message; do not leave its
        // plaintext audio in the cache waiting for the daily sweep.
        await deleteCachedFileUris([uri]);
      }
    } catch {
    }
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  }, [stopPulse, onRecorded]);

  // v4.32.562: таймер записи не видит стрелку остановки напрямую — она
  // пересоздаётся, а он заведён один раз на всю запись.
  useEffect(() => {
    stopSelfRef.current = () => { void stopRecording(); };
    return () => { stopSelfRef.current = null; };
  }, [stopRecording]);

  const countdown = voiceCountdownSeconds(recDurationMs);
  const trail = fadedOn(colors.error, colors.surface, TRAIL_ALPHA, 3);

  return (
    <AppPressable
      onPressIn={() => void startRecording()}
      onPressOut={() => void stopRecording()}
      disabled={disabled || permissionGranted === false}
      accessibilityRole="button"
      accessibilityLabel={isRecording ? 'Остановить запись голосового сообщения' : 'Записать голосовое сообщение'}
      accessibilityHint="Удерживайте кнопку для записи"
      accessibilityState={{ busy: isRecording, disabled: disabled || permissionGranted === false }}
      style={{ alignItems: 'center', justifyContent: 'center' }}
    >
      {isRecording ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.error }} />
          <Text style={{ color: colors.error, fontSize: 13, fontWeight: '600', minWidth: 36 }}>
            {countdown === null ? formatClockDuration(recDurationMs) : `−${countdown}\u00a0с`}
          </Text>
          {/* Live waveform */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 32, width: LIVE_BARS * 5 }}>
            {liveBars.map((h, i) => (
              <View key={i} style={{ width: 3, height: h, borderRadius: radius.sm, backgroundColor: i === LIVE_BARS - 1 ? colors.error : trail }} />
            ))}
          </View>
          <Animated.View
            style={[
              vrStyles.micCircle,
              { backgroundColor: colors.errorFill, transform: [{ scale: pulseAnim }] },
            ]}
          >
            {/* Значок «стоп» — на красной заливке кружка, а не на теме. */}
            <Ionicons name="stop" size={22} color={contrastingInk(colors.errorFill)} />
          </Animated.View>
        </View>
      ) : (
        <Animated.View
          style={[
            vrStyles.micCircle,
            { backgroundColor: colors.surfaceHigh, transform: [{ scale: pulseAnim }] },
          ]}
        >
          <Ionicons name="mic" size={22} color={colors.accent} />
        </Animated.View>
      )}
    </AppPressable>
  );
}

const vrStyles = StyleSheet.create({
  micCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Progress helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// VoicePlayer
// ─────────────────────────────────────────────────────────────────────────────

type PlayerProps = {
  uri: string;           // local file:// or https:// URI
  durationMs?: number;   // hint from metadata if known
  isOutgoing?: boolean;
  blob?: BlobRef;        // E2E-encrypted ntfy-attachment descriptor (recipient fetch)
};

const SPEEDS = [1, 1.5, 2] as const;
type Speed = 1 | 1.5 | 2;

let activeVoicePlayer: { player: AudioPlayer; stop: () => void } | null = null;

export function VoicePlayer({ uri, durationMs, isOutgoing, blob }: PlayerProps): React.ReactElement {
  /**
   * v4.32.413: плеер лежит внутри пузыря, поэтому все его цвета выводятся из
   * заливки пузыря. Раньше подложка входящего плеера была `surfaceHigh`
   * поверх пузыря того же `surfaceHigh` — плеера не было видно вовсе
   * (1.00:1), а непройденная часть волны давала 1.28–1.62:1 при графическом
   * пороге 3:1. В своём пузыре всё писалось белым с прозрачностью: в светлой
   * теме длительность читалась на 3.04:1.
   *
   * v4.32.540: плашка убрана совсем. 413-й развёл её с пузырём по цвету, и
   * плеер стало видно — но видно стало ИМЕННО плашку: скруглённый прямоугольник
   * внутри такого же скруглённого прямоугольника. Вложенная подложка нужна
   * там, где внутри пузыря лежит чужеродный блок (превью ссылки, врезка кода,
   * карточка контакта): она отделяет цитируемое от сказанного. Голосовое —
   * это и есть само сообщение, отделять его в своём же пузыре не от чего.
   *
   * Контраст при этом не теряется: роли `ink` пузыря считаются от его заливки
   * ровно так же, как считались роли плашки от её собственной, — то есть
   * `muted` держит графический порог 3:1 для дорожки, `secondary` — 4.5:1 для
   * длительности. Меняется подложка, а не правило.
   */
  const bubble = useBubbleSurface(!!isOutgoing);
  const [sound, setSound] = useState<AudioPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * v4.32.545: вместо одного `loading` — названная фаза.
   *
   * Раньше и скачивание вложения, и создание плеера были одним флагом, а
   * неудача скачивания заканчивалась молчаливым `return`: получатель жал
   * «играть», крутилка висела до тайм-аута в тридцать секунд, потом сама
   * пропадала — и не происходило ничего. Ни звука, ни ошибки. Со стороны это
   * ровно «бесконечная загрузка»: жмёшь ещё раз, и снова тридцать секунд.
   *
   * Фазы разведены потому, что это разные ожидания: `downloading` — сеть,
   * секунды и возможный отказ; `opening` — локальный файл, доли секунды.
   * Показывать их одинаково значит обещать быстрый ответ там, где его нет.
   * `error` — состояние, а не исчезновение: у него есть свой значок, подпись
   * и повтор по нажатию.
   */
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'opening' | 'error'>('idle');
  const [positionMs, setPositionMs] = useState(0);
  const [totalMs, setTotalMs] = useState(durationMs ?? 0);
  const [speed, setSpeed] = useState<Speed>(1);
  const subRef = useRef<{ remove: () => void } | null>(null);
  const progressWidth = useRef(0);

  useEffect(() => {
    return () => {
      if (subRef.current) { subRef.current.remove(); subRef.current = null; }
      if (sound && activeVoicePlayer?.player === sound) activeVoicePlayer = null;
      sound?.remove();
    };
  }, [sound]);

  // expo-audio drives progress via the `playbackStatusUpdate` event (fires
  // reliably on iOS, unlike the old onPlaybackStatusUpdate). Status units are
  // SECONDS — convert to ms so positionMs/totalMs and formatDuration keep working.
  const attachStatusListener = useCallback((snd: AudioPlayer) => {
    if (subRef.current) { subRef.current.remove(); subRef.current = null; }
    subRef.current = snd.addListener('playbackStatusUpdate', (status) => {
      if (!status.isLoaded) return;
      setPositionMs(status.currentTime * 1000);
      if (status.duration) setTotalMs(status.duration * 1000);
      if (status.didJustFinish) {
        setPlaying(false);
        setPositionMs(0);
        if (activeVoicePlayer?.player === snd) activeVoicePlayer = null;
      }
    });
  }, []);

  const togglePlayback = useCallback(async () => {
    let createdPlayer: AudioPlayer | null = null;
    try {
      if (playing && sound) {
        sound.pause();
        if (activeVoicePlayer?.player === sound) activeVoicePlayer = null;
        setPlaying(false);
        return;
      }

      if (sound) {
        if (activeVoicePlayer && activeVoicePlayer.player !== sound) {
          activeVoicePlayer.player.pause();
          activeVoicePlayer.stop();
          activeVoicePlayer = null;
        }
        sound.play();
        activeVoicePlayer = { player: sound, stop: () => setPlaying(false) };
        setPlaying(true);
        return;
      }

      setPhase('opening');
      // v4.32.226: resolve the playable URI. The sender's own recording is a
      // local file:// that exists; a received voice carries the sender's local
      // path (which does NOT exist here) plus an E2E-encrypted blob descriptor —
      // download + decrypt it to a cache file and play that.
      let playUri: string | null = null;
      if (uri.startsWith('file://')) {
        try {
          const info = await FileSystem.getInfoAsync(uri);
          if (info.exists) playUri = uri;
        } catch { /* fall through to blob */ }
      } else if (/^https?:\/\//.test(uri)) {
        playUri = uri; // legacy http(s)/gateway uri
      }
      if (!playUri && blob) {
        // Единственный шаг, который ходит в сеть, — только он и объявляется
        // скачиванием. Свой же файл и legacy-ссылка сюда не попадают.
        setPhase('downloading');
        playUri = await resolveBlobToLocalFile(blob, 'm4a');
        setPhase('opening');
      }
      if (!playUri) {
        // Вложения на relay живут часами, а не вечно, и сеть бывает без ответа.
        // Оба случая одинаковы для человека: файла нет сейчас. Значит и сказать
        // надо ровно это, а не убрать крутилку и промолчать.
        setPhase('error');
        setPlaying(false);
        return;
      }
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      if (activeVoicePlayer) {
        activeVoicePlayer.player.pause();
        activeVoicePlayer.stop();
        activeVoicePlayer = null;
      }
      const snd = createAudioPlayer({ uri: playUri }, { updateInterval: 100 });
      createdPlayer = snd;
      attachStatusListener(snd);
      if (speed !== 1) {
        snd.setPlaybackRate(speed);
      }
      setSound(snd);
      activeVoicePlayer = { player: snd, stop: () => setPlaying(false) };
      setPlaying(true);
      snd.play();
    } catch {
      if (createdPlayer) {
        if (subRef.current) { subRef.current.remove(); subRef.current = null; }
        if (activeVoicePlayer?.player === createdPlayer) activeVoicePlayer = null;
        createdPlayer.remove();
      }
      setPlaying(false);
      setPhase('error');
      return;
    }
    setPhase('idle');
  }, [playing, sound, uri, attachStatusListener, speed, blob]);

  const seekTo = useCallback(async (e: GestureResponderEvent) => {
    if (progressWidth.current === 0 || totalMs === 0) return;
    const ratio = Math.max(0, Math.min(1, e.nativeEvent.locationX / progressWidth.current));
    const seekMs = Math.round(ratio * totalMs);
    setPositionMs(seekMs);
    if (sound) {
      await sound.seekTo(seekMs / 1000).catch(() => {});
    }
  }, [sound, totalMs]);

  const cycleSpeed = useCallback(async () => {
    const idx = SPEEDS.indexOf(speed);
    const nextSpeed = SPEEDS[(idx + 1) % SPEEDS.length] as Speed;
    setSpeed(nextSpeed);
    if (sound) {
      sound.setPlaybackRate(nextSpeed);
    }
  }, [speed, sound]);

  const accentColor = bubble.ink.accent;
  const progress = totalMs > 0 ? positionMs / totalMs : 0;
  const busy = phase === 'downloading' || phase === 'opening';
  const failed = phase === 'error';

  return (
    <View style={vpStyles.container}>
      <AppPressable
        onPress={() => void togglePlayback()}
        style={vpStyles.playBtn}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={
          busy
            ? phase === 'downloading' ? 'Голосовое загружается' : 'Голосовое открывается'
            : failed ? 'Повторить загрузку голосового'
            : playing ? 'Пауза' : 'Воспроизвести голосовое'
        }
      >
        {busy ? (
          <ActivityIndicator size="small" color={accentColor} />
        ) : (
          <Ionicons
            // После отказа кнопка — это «повторить», а не «играть»: значок
            // называет то, что произойдёт по нажатию.
            name={failed ? 'refresh' : playing ? 'pause' : 'play'}
            size={22}
            color={failed ? bubble.ink.error : accentColor}
          />
        )}
      </AppPressable>

      {/* Playback progress. Keep this honest until decoded waveform data exists. */}
      <View style={vpStyles.progressWrap}>
        <AppPressable
          onLayout={(e: LayoutChangeEvent) => { progressWidth.current = e.nativeEvent.layout.width; }}
          onPress={(e) => void seekTo(e)}
          style={[vpStyles.progressTrack, { backgroundColor: bubble.ink.muted }]}
          hitSlop={6}
        >
          <View
            style={[
              vpStyles.progressFill,
              { width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`, backgroundColor: accentColor },
            ]}
          />
        </AppPressable>
        {/* Одна строка под дорожкой: пока всё обычно — время, во время
            скачивания и после отказа — состояние. Отдельной строки под статус
            не заводится: пузырь и так узкий, а лишняя строка меняет высоту
            сообщения задним числом и дёргает ленту. */}
        <Text
          style={[vpStyles.duration, { color: failed ? bubble.ink.error : bubble.ink.secondary }]}
          numberOfLines={1}
        >
          {phase === 'downloading'
            ? 'Загрузка…'
            : failed
              ? 'Не загрузилось — нажмите'
              : playing || positionMs > 0
                ? formatClockDuration(positionMs)
                : formatClockDuration(totalMs)}
        </Text>
      </View>
      <AppPressable onPress={() => void cycleSpeed()} style={vpStyles.speedBtn} hitSlop={8}>
        <Text style={[vpStyles.speedText, { color: accentColor }]}>
          {speed === 1 ? '1×' : speed === 1.5 ? '1.5×' : '2×'}
        </Text>
      </AppPressable>
    </View>
  );
}

const vpStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    // Отступы были собственными полями плашки. Плашки нет — поля берёт на себя
    // пузырь, и остаётся только вертикальный люфт под кнопку 36×36.
    paddingVertical: 2,
    gap: 10,
    minWidth: 180,
    maxWidth: 260,
  },
  playBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressWrap: {
    flex: 1,
    gap: 4,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.sm,
  },
  speedBtn: {
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedText: {
    fontSize: 12,
    fontWeight: '700',
  },
  duration: {
    fontSize: font.xs,
  },
});
