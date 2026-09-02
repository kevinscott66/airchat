// v4.32.53: визуальный редизайн + смена tile-провайдера.
// Раньше tile грузился с `tile.openstreetmap.org` — OSM Foundation агрессивно режет
// запросы без valid User-Agent (а RN Image шлёт дефолтный `okhttp/4.x`), и на
// реальном устройстве пользователь видел баннер "Access blocked — App is not following
// the tile usage policy of OpenStreetMap's". Переезжаем на CARTO Basemaps — free tile
// CDN без блокировок и с attribution-only требованием. Темы подбираются под UI
// (dark_all для тёмной темы приложения, voyager для светлой).
import React, { useState } from 'react';
import { View, Text, Image } from 'react-native';
import { AppPressable } from './AppPressable';
import { openMapAt } from '../utils/openExternal';
import { Ionicons } from '@expo/vector-icons';
import { badgeTint, font, mediaScrim, primaryInk, radius, spacing } from '../theme';
import { useThemedStyles, useColors, useTheme } from '../ThemeContext';

type Props = {
  lat: number;
  lng: number;
  address?: string;
};

/** Convert lat/lng to OSM tile coordinates (XYZ-схема, совместимая с CARTO). */
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

export function LocationMessage({ lat, lng, address }: Props): React.ReactElement {
  const styles = useThemedStyles((c) => ({
    container: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      overflow: 'hidden' as const,
      maxWidth: 300,
      borderWidth: 1,
      borderColor: c.border,
    },
    mapWrapper: {
      width: 280,
      height: 170,
      backgroundColor: c.surfaceHigh,
      alignSelf: 'stretch' as const,
      position: 'relative' as const,
    },
    mapImage: {
      width: '100%' as const,
      height: '100%' as const,
    },
    mapFallback: {
      ...(({
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
      } as const)),
      backgroundColor: c.surfaceHigh,
    },
    mapFallbackText: {
      color: c.textMuted,
      fontSize: font.xs,
      marginTop: 4,
    },
    pinAnchor: {
      // Абсолютная центровка пина так, чтобы "носик" приходился ровно на центр тайла
      // (центр тайла = искомые координаты при том же zoom-уровне).
      position: 'absolute' as const,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pinStack: {
      alignItems: 'center' as const,
      // Сдвигаем вверх на половину высоты иконки, чтобы кончик маркера совпал с центром.
      marginTop: -24,
    },
    pinIconWrap: {
      // Круглая подложка под иконку — делает пин читаемее поверх любого тайла.
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.primary,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.35,
      shadowRadius: 4,
      elevation: 6,
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.92)',
    },
    // Тень под булавкой: декорация, поверх неё ничего не пишут (v4.32.412).
    pinShadow: {
      width: 14,
      height: 4,
      borderRadius: 2,
      backgroundColor: 'rgba(0,0,0,0.35)',
      marginTop: 4,
    },
    badgeRow: {
      position: 'absolute' as const,
      top: 8,
      left: 8,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: mediaScrim.bar,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radius.md,
    },
    badgeText: {
      color: mediaScrim.ink,
      fontSize: font.xs,
      marginLeft: 4,
      fontWeight: '600' as const,
    },
    attribution: {
      position: 'absolute' as const,
      bottom: 3,
      right: 6,
      backgroundColor: mediaScrim.bar,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: radius.sm,
    },
    attributionText: {
      fontSize: font.xs,
      color: mediaScrim.inkMuted,
    },
    footer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm,
    },
    footerIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 17,
      // v4.32.409: подложка кружка считается от карточки, на которой лежит.
      backgroundColor: badgeTint(c, 'accent', c.surface).fill,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginRight: spacing.sm,
    },
    footerTextCol: {
      flex: 1,
    },
    footerTitle: {
      color: c.text,
      fontSize: font.sm,
      fontWeight: '600' as const,
    },
    footerSubtitle: {
      color: c.textMuted,
      fontSize: font.xs,
      marginTop: 1,
    },
    chevron: {
      marginLeft: 4,
    },
  }));
  const colors = useColors();
  const { mode } = useTheme();
  const [imgFailed, setImgFailed] = useState(false);

  // v4.32.53: CARTO Basemaps — бесплатный tile CDN без OSM-блокировки.
  // dark_all совпадает по палитре с тёмным UI, voyager — удачный вариант для
  // светлой темы (нейтрально-серые дороги, мягкие цвета, хороший контраст).
  // @2x — ретина-тайлы, чётко на современных экранах.
  const zoom = 15;
  const { x, y } = latLngToTile(lat, lng, zoom);
  const tileStyle = mode === 'light' ? 'voyager' : 'dark_all';
  const tileUrl = `https://a.basemaps.cartocdn.com/${tileStyle}/${zoom}/${x}/${y}@2x.png`;

  // v4.32.185 (Round-15 #9): нечисловые координаты не уходят в адрес, а
  // q-параметр экранируется — иначе кривая широта подставляла бы фрагмент
  // intent на Android. Оба правила теперь живут в `core/net/mapLink`.
  // v4.32.535: выбор «приложение карт, иначе браузер» был написан только
  // здесь, а остальные пять мест всегда открывали браузер. Теперь он один на
  // всех, и отказ обеих попыток человек видит, а не гадает.
  const openInMaps = (): void => { openMapAt(lat, lng); };

  const coordLabel = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  return (
    <AppPressable
      style={styles.container}
      onPress={openInMaps}
      accessibilityLabel="Открыть карту"
    >
      <View style={styles.mapWrapper}>
        {!imgFailed ? (
          <Image
            source={{ uri: tileUrl, headers: { 'User-Agent': 'AirChat/4.32 (mobile client)' } }}
            style={styles.mapImage}
            resizeMode="cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          // Fallback если CDN недоступен — не показываем «битый» Image, а мягкое
          // плейсхолдер-сообщение (пользователь всё ещё может тапнуть → maps).
          <View style={styles.mapFallback}>
            <Ionicons name="map-outline" size={32} color={colors.textMuted} />
            <Text style={styles.mapFallbackText}>Карта недоступна оффлайн</Text>
          </View>
        )}
        {/* Бейдж «Геолокация» в левом верхнем углу — сразу понятно, что это карта. */}
        <View style={styles.badgeRow} pointerEvents="none">
          <Ionicons name="location" size={12} color={mediaScrim.ink} />
          <Text style={styles.badgeText}>Геолокация</Text>
        </View>
        {/* Пин в центре с подложкой-кружком и тенью. */}
        <View style={styles.pinAnchor} pointerEvents="none">
          <View style={styles.pinStack}>
            <View style={styles.pinIconWrap}>
              <Ionicons name="location" size={24} color={primaryInk(colors).text} />
            </View>
            <View style={styles.pinShadow} />
          </View>
        </View>
        {/* Attribution требуется по лицензии CARTO + OSM. */}
        {!imgFailed ? (
          <View style={styles.attribution} pointerEvents="none">
            <Text style={styles.attributionText}>© OSM · CARTO</Text>
          </View>
        ) : null}
      </View>
      {/* Нижняя строка: иконка-бейдж + адрес/координаты + chevron (намёк на тап). */}
      <View style={styles.footer}>
        <View style={styles.footerIconWrap}>
          <Ionicons name="navigate" size={17} color={colors.accent} />
        </View>
        <View style={styles.footerTextCol}>
          <Text style={styles.footerTitle} numberOfLines={1}>
            {address ?? 'Открыть на карте'}
          </Text>
          <Text style={styles.footerSubtitle} numberOfLines={1}>
            {coordLabel}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={styles.chevron} />
      </View>
    </AppPressable>
  );
}
