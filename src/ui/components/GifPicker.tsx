/**
 * GifPickerModal — поиск и отправка GIF через Tenor API.
 * Отображает сетку GIF для отправки в чат.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  Image,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import { KeyboardHost } from './KeyboardHost';
import { Ionicons } from '@expo/vector-icons';
// v4.32.365: было `colors` — тёмная палитра как таковая, мимо активной темы.
// В светлой теме шторка GIF выезжала тёмно-синим прямоугольником поверх
// светлого чата, а пузырь-заглушка неотправившейся GIF рисовался тёмным
// квадратом внутри светлого сообщения.
import { useColors, useThemedStyles } from '../ThemeContext';
import { useBubbleSurface } from '../BubbleKindContext';

const SCREEN_W = Dimensions.get('window').width;
const CELL_SIZE = (SCREEN_W - 48 - 8) / 3; // 3 columns with padding

// Кодек GIF переехал в core/social/gifEnvelope.ts: разбор был голым slice,
// то есть любой адрес от собеседника уезжал в <Image> и устройство само шло
// на чужой сервер при открытии переписки. Реэкспорт — чтобы импорты экранов
// остались на месте.
import { makeGifText } from '../../core/social/gifEnvelope';
export { GIF_PREFIX, isGifMessage, parseGifUrl } from '../../core/social/gifEnvelope';
export { makeGifText };

import { getConfigSync } from '../../core/config';
import { mediaScrim, scrim } from '../theme';
import {
  buildTenorUrl,
  classifyTenorStatus,
  mergeGifPages,
  parseTenorPayload,
  tenorFailureMessage,
  tenorKeyFrom,
  type TenorFailure,
  type TenorGif,
} from '../../core/social/tenorApi';

/**
 * Есть ли чем искать GIF. Ключ Tenor выдаётся поимённо и в сборке его нет —
 * без него вкладка GIF не показывается вовсе (см. allowGif в AttachSheet):
 * кнопка, которая всегда приводит к ошибке, хуже отсутствующей.
 */
export function isGifSearchAvailable(): boolean {
  try {
    return tenorKeyFrom(getConfigSync()).length > 0;
  } catch {
    return false;
  }
}

class TenorError extends Error {
  constructor(readonly kind: TenorFailure) {
    super(kind);
  }
}

async function fetchTenor(
  key: string,
  query: string,
  pos?: string
): Promise<{ gifs: TenorGif[]; next: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(buildTenorUrl(key, query, pos), { signal: ctrl.signal });
  } catch {
    throw new TenorError('network');
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) throw new TenorError(classifyTenorStatus(res.status));
  try {
    return parseTenorPayload(await res.json());
  } catch {
    throw new TenorError('server');
  }
}

// ─── Inline GIF bubble renderer ──────────────────────────────────────────────

export function GifBubble({ url, isMe }: { url: string | null; isMe: boolean }): React.ReactElement {
  const [errored, setErrored] = useState(false);
  const bubble = useBubbleSurface(isMe);
  // url === null — адрес не прошёл проверку (см. gifEnvelope). Рисуем ту же
  // заглушку, что и при ошибке загрузки: ходить по нему нельзя.
  if (!url || errored) {
    // v4.32.413: заглушка — вложенная плашка пузыря. Своя писалась белым под
    // 70 % (2.76:1 в светлой теме), а входящая заливалась `surfaceHigh`
    // поверх пузыря того же `surfaceHigh` — то есть не была видна совсем.
    const ink = bubble.plate.ink.secondary;
    return (
      <View style={[gb.wrap, { backgroundColor: bubble.plate.fill }]}>
        <Ionicons name="image-outline" size={32} color={ink} />
        <Text style={{ color: ink, fontSize: 12, marginTop: 4 }}>GIF</Text>
      </View>
    );
  }
  return (
    <View style={gb.wrap}>
      <Image
        source={{ uri: url }}
        style={gb.img}
        resizeMode="contain"
        onError={() => setErrored(true)}
      />
      <View style={gb.badge}>
        <Text style={gb.badgeText}>GIF</Text>
      </View>
    </View>
  );
}

const gb = StyleSheet.create({
  wrap: { width: 200, height: 150, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  img: { width: 200, height: 150 },
  badge: { position: 'absolute', bottom: 6, right: 6, backgroundColor: mediaScrim.bar, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  badgeText: { color: mediaScrim.ink, fontSize: 10, fontWeight: '700' },
});

// ─── Picker modal ─────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (gifText: string) => void;
};

export function GifPickerModal({ visible, onClose, onSelect }: Props): React.ReactElement {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<TenorGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextPos, setNextPos] = useState('');
  const [failure, setFailure] = useState<TenorFailure | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const c = useColors();
  const s = useSheetStyles();
  // Ключ читается один раз: конфиг за время открытой шторки не меняется.
  const [tenorKey] = useState(() => tenorKeyFrom(getConfigSync()));
  /**
   * Номер последнего запроса. Пока человек печатает, в полёте несколько
   * ответов сразу, и приходят они не в том порядке, в каком уходили: ответ на
   * «ко» мог лечь поверх ответа на «кот», а курсор следующей страницы —
   * остаться от чужого запроса, так что «ещё» подгружало не то, что на экране.
   */
  const reqSeq = useRef(0);

  const load = useCallback(async (q: string, append = false, pos?: string) => {
    if (!tenorKey) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setFailure(null);
    if (!append) setGifs([]);
    try {
      const { gifs: fetched, next } = await fetchTenor(tenorKey, q, pos);
      if (seq !== reqSeq.current) return;
      setGifs((prev) => (append ? mergeGifPages(prev, fetched) : fetched));
      setNextPos(next);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setFailure(e instanceof TenorError ? e.kind : 'network');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [tenorKey]);

  useEffect(() => {
    if (!visible) return;
    // Открытие всегда начинает с чистого листа: раньше поле поиска сохраняло
    // прошлый запрос, а сетка показывала популярное — два разных ответа на
    // экране одновременно.
    setQuery('');
    setNextPos('');
    void load('');
  }, [visible, load]);

  // Отложенный поиск не должен пережить закрытие шторки.
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    reqSeq.current += 1;
  }, []);

  const onQueryChange = useCallback((text: string) => {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void load(text);
    }, 400);
  }, [load]);

  const onEndReached = useCallback(() => {
    if (!loading && nextPos) {
      void load(query, true, nextPos);
    }
  }, [loading, nextPos, query, load]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardHost variant="modal">
      <View style={s.backdrop}>
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>GIF</Text>
            <AppPressable onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={24} color={c.text} />
            </AppPressable>
          </View>

          {/* Ключа нет — искать нечем. Штатно сюда не попасть: вкладка GIF
              скрыта (allowGif), но шторку могли открыть до смены конфига. */}
          {!tenorKey ? (
            <View style={{ alignItems: 'center', padding: 24 }}>
              <Ionicons name="key-outline" size={36} color={c.textMuted} />
              <Text style={{ color: c.text, marginTop: 10, textAlign: 'center', fontSize: 14 }}>
                Поиск GIF не настроен
              </Text>
              <Text style={{ color: c.textMuted, marginTop: 6, textAlign: 'center', fontSize: 13, lineHeight: 18 }}>
                Нужен свой ключ Tenor: он выдаётся на имя владельца приложения,
                поэтому в сборку его не положить. Ключ добавляется в
                airchat-config.json полем publicServices.tenorKey.
              </Text>
            </View>
          ) : (
          <>
          {/* Search bar */}
          <View style={s.searchWrap}>
            <Ionicons name="search" size={16} color={c.textMuted} style={{ marginRight: 6 }} />
            <TextInput
              style={s.searchInput}
              placeholder="Поиск GIF…"
              placeholderTextColor={c.textMuted}
              value={query}
              onChangeText={onQueryChange}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query ? (
              <AppPressable onPress={() => { setQuery(''); void load(''); }} style={{ padding: 4 }}>
                <Ionicons name="close-circle" size={16} color={c.textMuted} />
              </AppPressable>
            ) : null}
          </View>

          {failure ? (
            <View style={{ alignItems: 'center', padding: 24 }}>
              {/* Значок тоже не должен врать про связь, когда дело в ключе. */}
              <Ionicons
                name={failure === 'key' ? 'key-outline' : failure === 'network' ? 'wifi-outline' : 'cloud-offline-outline'}
                size={36}
                color={c.textMuted}
              />
              <Text style={{ color: c.textMuted, marginTop: 8, textAlign: 'center', fontSize: 13 }}>
                {tenorFailureMessage(failure)}
              </Text>
            </View>
          ) : (
            <FlatList
              data={gifs}
              numColumns={3}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ padding: 4, gap: 4 }}
              columnWrapperStyle={{ gap: 4 }}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.4}
              ListEmptyComponent={
                loading ? (
                  <View style={{ alignItems: 'center', padding: 40 }}>
                    <ActivityIndicator size="large" color={c.accent} />
                  </View>
                ) : (
                  <View style={{ alignItems: 'center', padding: 40 }}>
                    <Text style={{ color: c.textMuted }}>Нет результатов</Text>
                  </View>
                )
              }
              ListFooterComponent={loading && gifs.length > 0 ? <ActivityIndicator color={c.accent} style={{ marginVertical: 12 }} /> : null}
              renderItem={({ item }) => (
                <AppPressable
                  style={s.cell}
                  onPress={() => {
                    onSelect(makeGifText(item.url));
                    onClose();
                  }}
                >
                  <Image
                    source={{ uri: item.previewUrl }}
                    style={{ width: CELL_SIZE, height: CELL_SIZE }}
                    resizeMode="cover"
                  />
                </AppPressable>
              )}
            />
          )}
          </>
          )}
        </View>
      </View>
      </KeyboardHost>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function useSheetStyles(): {
  backdrop: ViewStyle;
  sheet: ViewStyle;
  header: ViewStyle;
  title: TextStyle;
  searchWrap: ViewStyle;
  searchInput: TextStyle;
  cell: ViewStyle;
} {
  return useThemedStyles((t) => ({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: scrim.modal,
    },
    sheet: {
      backgroundColor: t.background,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      height: '70%',
      paddingTop: 4,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    title: {
      color: t.text,
      fontSize: 17,
      fontWeight: '700',
    },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.surface,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      margin: 12,
      borderWidth: 1,
      borderColor: t.border,
    },
    searchInput: {
      flex: 1,
      color: t.text,
      fontSize: 15,
    },
    cell: {
      width: CELL_SIZE,
      height: CELL_SIZE,
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: t.surface,
    },
  }));
}
