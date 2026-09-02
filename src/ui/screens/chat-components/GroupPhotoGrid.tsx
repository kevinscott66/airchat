import React, { useState } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';
import { AppPressable } from '../../components/AppPressable';
import { isNbCid } from '../../../core/media/mediaBlob';
import { parseMediaCidsColumn } from '../../../core/media/mediaCidPolicy';
import { useResolvedMediaUrls } from './useResolvedMediaUrls';
import { useAutoDownloadGate } from './useAutoDownloadGate';
import { mediaScrim, radius } from '../../theme';

/**
 * Сетка фотографий в пузыре группы.
 *
 * v4.32.244. Раньше сетка рисовалась прямо в GroupsScreen и умела только
 * адреса IPFS-шлюза, поэтому снимок, приехавший зашифрованным вложением
 * (`nb:`-дескриптор — единственный рабочий путь без своего IPFS-сервера),
 * не показывался вовсе. Вынесено в компонент, чтобы можно было позвать общий
 * хук разбора mediaCids: он и адрес шлюза собирает, и вложение расшифровывает.
 *
 * Пока вложение качается и расшифровывается, на его месте стоит плитка с
 * индикатором; если адрес собрать нельзя в принципе (нет шлюза или CID кривой),
 * плитка сразу говорит, что снимок недоступен, — вечного индикатора не будет.
 */
export function GroupPhotoGrid({
  mediaCids,
  gateway,
  onOpen,
  tileBackground,
  mutedColor,
}: {
  mediaCids: string;
  gateway: string;
  onOpen: (urls: string[], index: number) => void;
  tileBackground: string;
  mutedColor: string;
}): React.ReactElement | null {
  const entries = parseMediaCidsColumn(mediaCids);
  /**
   * v4.32.248: настройку «Автозагрузка медиа» здесь не спрашивали вовсе — в
   * группе снимки качались всегда, хотя именно в группе их больше всего и
   * именно там мобильный трафик уходит быстрее. Гейт общий с личными чатами.
   */
  const gated = useAutoDownloadGate();
  const [wanted, setWanted] = useState(false);
  const holdBack = gated && !wanted;
  const resolved = useResolvedMediaUrls(holdBack ? [] : entries, gateway);
  /** Просмотрщик листает только готовые адреса, поэтому индекс считаем по ним. */
  const ready = resolved.filter((u): u is string => typeof u === 'string' && u.length > 0);

  const MAX_SHOW = 4;
  const shown = resolved.slice(0, MAX_SHOW);
  const extra = resolved.length - MAX_SHOW;
  const TOTAL_W = 220;
  const HALF_W = Math.floor((TOTAL_W - 2) / 2);

  if (!entries.length) return null;

  if (holdBack) {
    return (
      <AppPressable onPress={() => setWanted(true)}>
        <View style={{ width: TOTAL_W, height: 80, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: tileBackground }}>
          <Text style={{ fontSize: 13, color: mutedColor }}>
            📷 Медиа ({entries.length}) — нажмите, чтобы загрузить
          </Text>
        </View>
      </AppPressable>
    );
  }

  const tile = (
    i: number,
    w: number,
    h: number,
    radius?: number,
    overlay?: React.ReactNode,
  ): React.ReactElement => {
    const url = shown[i];
    if (!url) {
      // nb: ещё качается — ждём; всё остальное уже не появится.
      const pending = isNbCid(entries[i] ?? '');
      return (
        <View
          key={i}
          style={{ width: w, height: h, borderRadius: radius, alignItems: 'center', justifyContent: 'center', backgroundColor: tileBackground }}
        >
          {pending ? (
            <ActivityIndicator size="small" color={mutedColor} />
          ) : (
            <Text style={{ fontSize: 12, color: mutedColor }}>📷 недоступно</Text>
          )}
        </View>
      );
    }
    return (
      <AppPressable key={i} onPress={() => onOpen(ready, Math.max(0, ready.indexOf(url)))} style={{ position: 'relative' }}>
        <Image source={{ uri: url }} style={{ width: w, height: h, borderRadius: radius }} resizeMode="cover" />
        {overlay}
      </AppPressable>
    );
  };

  if (shown.length === 1) {
    return <View>{tile(0, TOTAL_W, 160, 12)}</View>;
  }

  if (shown.length === 2) {
    return (
      <View style={{ flexDirection: 'row', gap: 2, borderRadius: radius.lg, overflow: 'hidden' }}>
        {[0, 1].map((i) => tile(i, HALF_W, 160))}
      </View>
    );
  }

  if (shown.length === 3) {
    return (
      <View style={{ flexDirection: 'row', gap: 2, borderRadius: radius.lg, overflow: 'hidden' }}>
        {tile(0, Math.floor(TOTAL_W * 0.6), 160)}
        <View style={{ gap: 2 }}>{[1, 2].map((i) => tile(i, Math.floor(TOTAL_W * 0.4) - 2, 79))}</View>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, width: TOTAL_W, borderRadius: radius.lg, overflow: 'hidden' }}>
      {shown.map((_url, i) =>
        tile(
          i,
          HALF_W,
          HALF_W,
          undefined,
          i === MAX_SHOW - 1 && extra > 0 ? (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: mediaScrim.bar, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: mediaScrim.ink, fontSize: 22, fontWeight: '700' }}>+{extra}</Text>
            </View>
          ) : undefined,
        ),
      )}
    </View>
  );
}
