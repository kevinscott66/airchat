import React, { useState } from 'react';
import { Image, Text, View, useWindowDimensions } from 'react-native';
import { AppPressable } from '../../components/AppPressable';
import { VoicePlayer } from '../../components/VoiceMessage';
import { isVoiceMessage, parseVoiceMeta } from '../ChatScreen';
import { isNbCid } from '../../../core/media/mediaBlob';
import { parseMediaCidsColumn } from '../../../core/media/mediaCidPolicy';
import { useResolvedMediaUrls } from './useResolvedMediaUrls';
import { useAutoDownloadGate } from './useAutoDownloadGate';
import { voicePlaybackUri } from '../../../core/social/voiceUriPolicy';
import { mediaScrim } from '../../theme';
import { useBubbleSurface } from '../../BubbleKindContext';

export function MediaStrip({
  gateway,
  mediaCids,
  messageText,
  isOutgoing,
  onImagePress,
}: {
  gateway: string;
  mediaCids: string;
  messageText?: string;
  isOutgoing?: boolean;
  onImagePress?: (urls: string[], index: number) => void;
}): React.ReactElement | null {
  const bubble = useBubbleSurface(!!isOutgoing);
  const gated = useAutoDownloadGate();
  /**
   * v4.32.248: нажатие на заглушку. Раньше настройка «Автозагрузка медиа» была
   * бутафорией: адреса разбирались всегда, то есть вложение уже скачано и
   * расшифровано, а заглушка рисовалась поверх готового снимка. Теперь пока
   * человек не нажмёт, в разбор уходит пустой список — и в сеть не уходит
   * ничего.
   */
  const [wanted, setWanted] = useState(false);
  // Hook used below; reserve windowDimensions ref for layout if needed later
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _w = useWindowDimensions();
  // Parse entries once, BEFORE any conditional return (hooks rule — the
  // resolver hook below must run unconditionally).
  // v4.32.183 (Round-13 #12): a peer can send `null`/`{}` which parses ok but
  // is not an array — guard before `.map` to avoid thread-render crash.
  const entries = parseMediaCidsColumn(mediaCids);
  const isVoice = !!(messageText && isVoiceMessage(messageText));
  const holdBack = gated && !wanted;
  const resolvedUrls = useResolvedMediaUrls(isVoice || holdBack ? [] : entries, gateway);

  // Voice note — rendered as VoicePlayer, not image strip
  if (isVoice && messageText) {
    const meta = parseVoiceMeta(messageText);
    if (!meta) return null;
    // Адрес для плеера выбирает core/social/voiceUriPolicy — та же функция
    // работает в групповом пузыре, где проверки схемы не было вовсе.
    // v4.32.242: чужой uri не берём даже с http(s): отправитель всегда кладёт
    // в конверт СВОЙ локальный путь, так что чужой http(s) — это чужой сервер,
    // то есть маяк с IP-адресом получателя в момент прослушивания.
    const firstCid = entries.find((e) => !isNbCid(e));
    const uri = voicePlaybackUri({ metaUri: meta.uri, isOutgoing: !!isOutgoing, cid: firstCid, gateway });
    // v4.32.226: incoming voice carries an E2E-encrypted blob descriptor (ntfy
    // attachment) when IPFS isn't available. We deliberately do NOT pass the
    // peer's `file://` uri to the player (Round-20 #3: a peer could point it at a
    // local file); instead leave uri empty and let VoicePlayer download+decrypt
    // the blob. Own outgoing messages keep their valid local file uri.
    if (!uri && !meta.blob) return null;
    return (
      <VoicePlayer uri={uri} durationMs={meta.durationMs} isOutgoing={isOutgoing} blob={meta.blob} />
    );
  }

  if (!entries.length) return null;
  // v4.32.226: nb: entries resolve asynchronously (download+decrypt) — they are
  // null until ready and render as a loading tile.
  const imageUrls = resolvedUrls;
  const readyUrls = imageUrls.filter((u): u is string => typeof u === 'string');
  // auto_download_media gate: до нажатия ничего не скачано — первое нажатие
  // запускает загрузку, дальше снимок открывается как обычно.
  if (holdBack) {
    return (
      <AppPressable onPress={() => setWanted(true)}>
        <View style={{ width: 220, height: 80, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: bubble.plate.fill }}>
          <Text style={{ fontSize: 13, color: bubble.plate.ink.text }}>📷 Медиа ({entries.length}) — нажмите, чтобы загрузить</Text>
        </View>
      </AppPressable>
    );
  }
  const maxShow = 4;
  const shown = imageUrls.slice(0, maxShow);
  const extra = imageUrls.length - maxShow;
  const TOTAL_W = 220;
  const HALF_W = Math.floor((TOTAL_W - 2) / 2);
  // Tile: image when resolved, loading placeholder while an nb: blob downloads.
  const tile = (url: string | null, w: number, h: number, viewerIndex: number, overlay?: React.ReactNode) =>
    url ? (
      <AppPressable key={viewerIndex} onPress={() => onImagePress?.(readyUrls, Math.max(0, readyUrls.indexOf(url)))} style={{ position: 'relative' }}>
        <Image source={{ uri: url }} style={{ width: w, height: h }} resizeMode="cover" />
        {overlay}
      </AppPressable>
    ) : (
      <View key={viewerIndex} style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center', backgroundColor: bubble.plate.fill }}>
        <Text style={{ fontSize: 12, color: bubble.plate.ink.secondary }}>📷 …</Text>
      </View>
    );
  if (shown.length === 1) {
    return (
      <View style={{ borderRadius: 12, overflow: 'hidden' }}>
        {tile(shown[0], TOTAL_W, 160, 0)}
      </View>
    );
  }
  if (shown.length === 2) {
    return (
      <View style={{ flexDirection: 'row', gap: 2, borderRadius: 12, overflow: 'hidden' }}>
        {shown.map((url, i) => tile(url, HALF_W, 160, i))}
      </View>
    );
  }
  if (shown.length === 3) {
    return (
      <View style={{ flexDirection: 'row', gap: 2, borderRadius: 12, overflow: 'hidden' }}>
        {tile(shown[0], Math.floor(TOTAL_W * 0.6), 160, 0)}
        <View style={{ gap: 2 }}>
          {[1, 2].map((i) => tile(shown[i], Math.floor(TOTAL_W * 0.4) - 2, 79, i))}
        </View>
      </View>
    );
  }
  // 4+ images → 2×2 grid with "+N" overlay on last tile
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, width: TOTAL_W, borderRadius: 12, overflow: 'hidden' }}>
      {shown.map((url, i) =>
        tile(
          url,
          HALF_W,
          HALF_W,
          i,
          i === maxShow - 1 && extra > 0 ? (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: mediaScrim.bar, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: mediaScrim.ink, fontSize: 22, fontWeight: '700' }}>+{extra}</Text>
            </View>
          ) : undefined,
        ),
      )}
    </View>
  );
}
