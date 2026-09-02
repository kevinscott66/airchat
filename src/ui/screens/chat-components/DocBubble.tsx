import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import { AppPressable } from '../../components/AppPressable';
import { isVideoDoc } from '../chat-utils/media';
import { parseDocMeta } from '../../../core/social/docMeta';
import { fileExt, parseNbCid, resolveBlobToLocalFile } from '../../../core/media/mediaBlob';
import { gatewayUrl } from '../../../core/media/gatewayUrl';
import { useBubbleSurface } from '../../BubbleKindContext';
import { openExternal } from '../../utils/openExternal';
import { formatByteSize } from '../../../core/media/byteSize';
import { font, radius } from '../../theme';

// InlineVideoPlayer — inline document-video playback (expo-video). Owns the
// useVideoPlayer hook at its top level so DocBubble can render it conditionally
// (videoPlaying) without violating the rules of hooks.
function InlineVideoPlayer({
  url,
  onClose,
  mutedColor,
}: {
  url: string;
  onClose: () => void;
  mutedColor: string;
}): React.ReactElement {
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  return (
    <View style={{ width: 240, borderRadius: radius.md, overflow: 'hidden' }}>
      <VideoView
        player={player}
        style={{ width: 240, height: 160 }}
        nativeControls
        contentFit="contain"
      />
      <AppPressable onPress={onClose} style={{ padding: 6, alignItems: 'center' }}>
        <Text style={{ color: mutedColor, fontSize: 12 }}>✕ Закрыть</Text>
      </AppPressable>
    </View>
  );
}

export function DocBubble({
  text,
  isOutgoing,
  gateway,
}: {
  text: string;
  isOutgoing: boolean;
  gateway: string;
}): React.ReactElement | null {
  // v4.32.411: размер файла писался белым под 70 % — 3.40:1 в светлой теме.
  // Плашка превью во ВХОДЯЩЕМ пузыре заливалась `surfaceHigh` поверх пузыря
  // того же `surfaceHigh`: границ у неё не было видно.
  const bubble = useBubbleSurface(isOutgoing);
  const [videoPlaying, setVideoPlaying] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  // v4.32.245: расшифрованный файл видео, приехавшего вложением. Пока его нет,
  // играть нечего: expo-video не умеет ни ntfy-ссылку с шифртекстом, ни ключ.
  const [blobVideoUri, setBlobVideoUri] = React.useState<string | null>(null);
  const meta = parseDocMeta(text);
  if (!meta) return null;
  const sizeStr = formatByteSize(meta.size);
  const textColor = bubble.ink.text;
  const mutedColor = bubble.ink.secondary;
  const iconColor = bubble.icon;
  // v4.32.226: nb: pseudo-CID = E2E-encrypted ntfy blob (no IPFS on mobile) —
  // tap downloads+decrypts to cache and opens the share sheet.
  const blobRef = parseNbCid(meta.cid);
  const url = blobRef ? '' : gatewayUrl(gateway, meta.cid);
  /**
   * v4.32.245: видео, пришедшее зашифрованным вложением, раньше открывалось
   * только «поделиться» — встроенный проигрыватель включался лишь при наличии
   * адреса шлюза. Теперь по нажатию файл расшифровывается в кэш и играет тут же.
   */
  const playBlobVideo = async (): Promise<void> => {
    if (!blobRef || opening) return;
    if (blobVideoUri) { setVideoPlaying(true); return; }
    setOpening(true);
    try {
      const local = await resolveBlobToLocalFile(blobRef, fileExt(meta.name));
      if (!local) return;
      setBlobVideoUri(local);
      setVideoPlaying(true);
    } catch { /* не открылось — остаётся карточка файла */ } finally {
      setOpening(false);
    }
  };

  const openBlobDoc = async (): Promise<void> => {
    if (!blobRef || opening) return;
    setOpening(true);
    try {
      const local = await resolveBlobToLocalFile(blobRef, fileExt(meta.name));
      if (!local) return;
      const sharing = await import('expo-sharing');
      if (await sharing.isAvailableAsync()) {
        await sharing.shareAsync(local);
      }
    } catch { /* user-visible failure is just "nothing opened" */ } finally {
      setOpening(false);
    }
  };

  const videoUrl = url || blobVideoUri || '';
  if (isVideoDoc(meta.name) && (url || blobRef)) {
    if (videoPlaying && videoUrl) {
      return (
        <InlineVideoPlayer
          url={videoUrl}
          onClose={() => setVideoPlaying(false)}
          mutedColor={mutedColor}
        />
      );
    }
    return (
      <AppPressable
        style={{ width: 220, borderRadius: radius.md, overflow: 'hidden', backgroundColor: bubble.plate.fill }}
        onPress={() => { if (blobRef) { void playBlobVideo(); } else { setVideoPlaying(true); } }}
      >
        <View style={{ height: 120, alignItems: 'center', justifyContent: 'center' }}>
          {opening ? <ActivityIndicator size="large" color={iconColor} /> : <Ionicons name="play-circle" size={48} color={iconColor} />}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8, gap: 6 }}>
          <Ionicons name="videocam-outline" size={14} color={mutedColor} />
          <Text style={{ color: textColor, fontSize: 12, flex: 1 }} numberOfLines={1}>{meta.name}</Text>
          <Text style={{ color: mutedColor, fontSize: font.xs }}>{sizeStr}</Text>
        </View>
      </AppPressable>
    );
  }

  return (
    <AppPressable
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 160 }}
      onPress={() => {
        if (blobRef) { void openBlobDoc(); return; }
        // Адрес собирается из шлюза, который задаёт пользователь, — значит,
        // тоже проходит общую дверь.
        openExternal(url, 'chat_doc', 'Не удалось открыть файл');
      }}
    >
      <Ionicons name="document-outline" size={28} color={iconColor} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: textColor, fontWeight: '600', fontSize: 13 }} numberOfLines={2}>{meta.name}</Text>
        <Text style={{ color: mutedColor, fontSize: font.xs }}>{sizeStr}</Text>
      </View>
      {opening ? <ActivityIndicator size="small" color={mutedColor} /> : <Ionicons name="download-outline" size={18} color={mutedColor} />}
    </AppPressable>
  );
}
