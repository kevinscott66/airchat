/**
 * MediaViewer — полноэкранный просмотр медиа.
 * Pinch-to-zoom через Animated + PanResponder (без react-native-reanimated).
 * Свайп вниз закрывает просмотр. Кнопка «Поделиться» сохраняет файл.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
} from 'react-native';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { classifyShareUrl, type ShareUrlVerdict } from '../../core/media/mediaUrlPolicy';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mediaScrim } from '../theme';
import { userErrorText } from './userErrorText';

const { width: W, height: H } = Dimensions.get('window');

/** Потолок для файла, который скачивается ради «Поделиться». */
const MAX_SHARE_BYTES = 50 * 1024 * 1024;

const SHARE_URL_REFUSAL: Record<Exclude<ShareUrlVerdict, 'ok'>, string> = {
  malformed: 'Некорректная ссылка',
  insecure: 'Только защищённые (https) ссылки',
  private: 'Недопустимый хост',
};

const SHARE_MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

/**
 * Расширение из ПУТИ адреса, а не из строки целиком.
 *
 * `uri.includes('.png')` давало png для `…/photo.jpg?from=x.png`, то есть имя
 * файла в «Поделиться» и заявленный тип расходились с содержимым.
 */
function shareExt(uri: string): keyof typeof SHARE_MIME {
  const path = uri.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.png')) return 'png';
  if (path.endsWith('.gif')) return 'gif';
  if (path.endsWith('.webp')) return 'webp';
  return 'jpg';
}

/**
 * Скачать файл, оборвав закачку при выходе за потолок.
 *
 * v4.32.355: потолок проверялся HEAD-запросом до закачки, и в комментарии рядом
 * стояло «HEAD may be unsupported — fall through to downloadAsync». То есть
 * сервер, не ответивший на HEAD или не приславший Content-Length, отменял
 * ограничение целиком: дальше шла закачка без всякого предела, на устройство
 * получателя, по адресу, который выбрал отправитель. Размер приходится
 * сторожить по ходу — заявленному значению верить нельзя, а обрывать надо не
 * после, а во время.
 */
async function downloadCapped(url: string, dest: string): Promise<string | null> {
  let overLimit = false;
  let cancel: (() => void) | null = null;
  const task = FileSystem.createDownloadResumable(url, dest, {}, (p) => {
    if (overLimit) return;
    if (p.totalBytesWritten > MAX_SHARE_BYTES || p.totalBytesExpectedToWrite > MAX_SHARE_BYTES) {
      overLimit = true;
      cancel?.();
    }
  });
  cancel = () => { void task.cancelAsync().catch(() => {}); };
  const res = await task.downloadAsync().catch(() => null);
  if (overLimit || !res) {
    // Оборванная закачка оставляет частичный файл — он уже не нужен никому.
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    return null;
  }
  return res.uri;
}

// ─────────────────────────────────────────────────────────────────────────────
// SingleImageView — one image with pan + pinch via PanResponder
// ─────────────────────────────────────────────────────────────────────────────

function distance(
  touches: { pageX: number; pageY: number }[]
): number {
  const [a, b] = touches;
  if (!a || !b) return 0;
  return Math.sqrt((b.pageX - a.pageX) ** 2 + (b.pageY - a.pageY) ** 2);
}

function SingleImageView({
  uri,
  onClose,
  showNav,
  onPrev,
  onNext,
  index,
  total,
}: {
  uri: string;
  onClose: () => void;
  showNav: boolean;
  onPrev: () => void;
  onNext: () => void;
  index: number;
  total: number;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);

  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const currentScale = useRef(1);
  const baseScale = useRef(1);
  const lastDist = useRef<number | null>(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: () => {
        lastDist.current = null;
        baseScale.current = currentScale.current;
      },

      onPanResponderMove: (_, gestureState) => {
        // Two-finger pinch
        const touches = (gestureState as unknown as { touches?: { pageX: number; pageY: number }[] }).touches ?? [];

        if (touches.length >= 2) {
          const d = distance(touches);
          if (lastDist.current !== null) {
            const ratio = d / lastDist.current;
            const next = Math.min(Math.max(currentScale.current * ratio, 0.8), 5);
            currentScale.current = next;
            scale.setValue(next);
          }
          lastDist.current = d;
          return;
        }

        // Single-finger pan — only when not zoomed in
        if (currentScale.current <= 1) {
          translateY.setValue(gestureState.dy);
          const prog = Math.abs(gestureState.dy) / 300;
          opacity.setValue(Math.max(0.3, 1 - prog));
        }
      },

      onPanResponderRelease: (_, gestureState) => {
        lastDist.current = null;
        const touches = (gestureState as unknown as { touches?: unknown[] }).touches ?? [];

        if (touches.length >= 2) {
          baseScale.current = currentScale.current;
          return;
        }

        if (currentScale.current <= 1) {
          // Close on big swipe
          if (Math.abs(gestureState.dy) > 100) {
            Animated.parallel([
              Animated.timing(translateY, { toValue: gestureState.dy > 0 ? H : -H, duration: 150, useNativeDriver: true }),
              Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
            ]).start(() => onClose());
          } else {
            Animated.parallel([
              Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
              Animated.spring(opacity, { toValue: 1, useNativeDriver: true }),
            ]).start();
          }
        } else {
          // Reset scale on release if below 1
          if (currentScale.current < 1) {
            currentScale.current = 1;
            Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
          }
        }
      },

      onPanResponderTerminate: () => {
        lastDist.current = null;
        Animated.parallel([
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
          Animated.spring(opacity, { toValue: 1, useNativeDriver: true }),
          Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        ]).start();
        currentScale.current = 1;
      },
    })
  ).current;

  const share = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      let localUri = uri;
      let mimeType = 'image/jpeg';
      // v4.32.194 (Round-24 #2): require https, reject private-range hosts,
      // guard against oversized downloads. Peer URLs land here directly.
      // v4.32.355: решение о хосте переехало в core/media/mediaUrlPolicy —
      // здесь оно держалось на том, что разбор адреса в React Native совпадёт
      // с разбором в системном загрузчике.
      if (/^https?:\/\//i.test(uri)) {
        const verdict = classifyShareUrl(uri);
        if (verdict !== 'ok') { Alert.alert('AirChat', SHARE_URL_REFUSAL[verdict]); return; }
        const ext = shareExt(uri);
        mimeType = SHARE_MIME[ext];
        const dest = `${FileSystem.cacheDirectory}ac_share_${Date.now()}.${ext}`;
        const got = await downloadCapped(uri, dest);
        if (!got) { Alert.alert('AirChat', 'Файл слишком большой для шаринга'); return; }
        localUri = got;
      }
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) { Alert.alert('AirChat', 'Нет приложений для шаринга'); return; }
      await Sharing.shareAsync(localUri, { mimeType });
    } catch (e) {
      Alert.alert('Ошибка', userErrorText(e, 'Не удалось поделиться файлом'));
    } finally {
      setSharing(false);
    }
  }, [uri, sharing]);

  return (
    <View style={siv.root}>
      <Animated.View
        style={[siv.imageWrap, { transform: [{ translateY }, { scale }], opacity }]}
        {...panResponder.panHandlers}
      >
        <Image
          source={{ uri }}
          style={siv.image}
          resizeMode="contain"
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
        />
      </Animated.View>

      {loading ? (
        <View style={siv.loadingOverlay}>
          <ActivityIndicator color={mediaScrim.ink} size="large" />
        </View>
      ) : null}

      {/* Top bar */}
      <View style={[siv.topBar, { paddingTop: insets.top + 6 }]}>
        <AppPressable style={siv.iconBtn} onPress={onClose} hitSlop={16}>
          <Ionicons name="close" size={26} color={mediaScrim.ink} />
        </AppPressable>
        {total > 1 ? (
          <Text style={siv.counter}>{index + 1} / {total}</Text>
        ) : (
          <View />
        )}
        <AppPressable style={siv.iconBtn} onPress={() => void share()} hitSlop={16} disabled={sharing}>
          {sharing ? (
            <ActivityIndicator color={mediaScrim.ink} size="small" />
          ) : (
            <Ionicons name="share-outline" size={24} color={mediaScrim.ink} />
          )}
        </AppPressable>
      </View>

      {/* Gallery navigation arrows */}
      {showNav ? (
        <>
          <AppPressable style={[siv.navBtn, { left: 8 }]} onPress={onPrev} hitSlop={12}>
            <Ionicons name="chevron-back" size={32} color={mediaScrim.ink} />
          </AppPressable>
          <AppPressable style={[siv.navBtn, { right: 8 }]} onPress={onNext} hitSlop={12}>
            <Ionicons name="chevron-forward" size={32} color={mediaScrim.ink} />
          </AppPressable>
        </>
      ) : null}
    </View>
  );
}

const siv = StyleSheet.create({
  root: { flex: 1, backgroundColor: mediaScrim.fill, justifyContent: 'center', alignItems: 'center' },
  imageWrap: { width: W, height: H, justifyContent: 'center', alignItems: 'center' },
  image: { width: W, height: H },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingBottom: 8,
    // v4.32.403: было 0.45 — поверх белой фотографии это давало счётчику
    // 3.36:1 при пороге 4.5. Прозрачность взята из худшего случая (кадр
    // белый), а не подобрана на глаз.
    backgroundColor: mediaScrim.bar,
  },
  iconBtn: { padding: 8 },
  counter: { color: mediaScrim.ink, fontSize: 14, fontWeight: '600' },
  navBtn: { position: 'absolute', top: '45%', padding: 10, borderRadius: 26, backgroundColor: mediaScrim.bar },
});

// ─────────────────────────────────────────────────────────────────────────────
// MediaViewer modal
// ─────────────────────────────────────────────────────────────────────────────

type MediaViewerProps = {
  visible: boolean;
  urls: string[];
  initialIndex?: number;
  onClose: () => void;
};

export function MediaViewer({ visible, urls, initialIndex = 0, onClose }: MediaViewerProps): React.ReactElement {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const goNext = useCallback(() => setCurrentIndex((i) => Math.min(i + 1, urls.length - 1)), [urls.length]);
  const goPrev = useCallback(() => setCurrentIndex((i) => Math.max(i - 1, 0)), []);

  if (!visible || !urls.length) return <></>;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
    >
      <SingleImageView
        uri={urls[currentIndex] ?? ''}
        onClose={onClose}
        showNav={urls.length > 1}
        onPrev={goPrev}
        onNext={goNext}
        index={currentIndex}
        total={urls.length}
      />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// useMediaViewer hook
// ─────────────────────────────────────────────────────────────────────────────

export function useMediaViewer() {
  const [state, setState] = useState<{ urls: string[]; index: number } | null>(null);
  const open = useCallback((urls: string[], index = 0) => setState({ urls, index }), []);
  const close = useCallback(() => setState(null), []);

  const element = state ? (
    <MediaViewer visible urls={state.urls} initialIndex={state.index} onClose={close} />
  ) : null;

  return { open, close, element };
}
