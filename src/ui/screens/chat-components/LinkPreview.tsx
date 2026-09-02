/**
 * LinkPreview — карточка предпросмотра ссылки в пузыре сообщения.
 *
 * v4.32.534. Карточка жила в ChatScreen.tsx, но рисуют её трое: диалог,
 * группы и лента. Двое последних ходили за ней через экран диалога — то есть
 * импортировали компонент из чужого экрана. Соседи по пузырю (LocationBubble,
 * DocBubble, ContactCardBubble, MediaStrip) уже лежат здесь.
 *
 * Загрузка и разбор не менялись: `previewStore` остаётся одним на приложение,
 * как и был, когда жил в модуле экрана.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { AppPressable } from '../../components/AppPressable';
import { openExternal } from '../../utils/openExternal';
import { kvGet } from '../../../core/storage/local';
import { useTheme } from '../../ThemeContext';
import { font, inkOn, nestedFill, radius } from '../../theme';
import { useBubbleSurface } from '../../BubbleKindContext';
import {
  createLinkPreviewStore,
  tooLargeToRead,
  type LinkPreviewCard,
} from '../../../core/social/linkPreviewStore';
import {
  LINK_PREVIEW_INCOMING_KEY,
  parseIncomingLinkPreviewPref,
  shouldLoadLinkPreview,
} from '../../../core/social/linkPreviewPolicy';

const URL_RE = /https?:\/\/[^\s<>"']+/;
// v4.32.540: не голая Map. Отмена загрузки больше не считается ответом об
// адресе, сетевой сбой стоит попытку, а память имеет предел — см.
// core/social/linkPreviewStore.
const previewStore = createLinkPreviewStore();

export function extractFirstUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * Карточка предпросмотра ссылки.
 *
 * fromPeer — адрес пришёл от собеседника (входящее сообщение, сообщение
 * группы, запись ленты), а не набран самим пользователем. Такие адреса по
 * умолчанию НЕ загружаются: иначе чужая ссылка превращается в маяк, который
 * отдаёт отправителю IP-адрес получателя и момент открытия чата в обход
 * отключённых уведомлений о прочтении (см. core/social/linkPreviewPolicy).
 */
export function LinkPreview({ url, isOutgoing, fromPeer }: { url: string; isOutgoing: boolean; fromPeer: boolean }): React.ReactElement | null {
  const { colors } = useTheme();
  // Заливка пузыря-хозяина. Через контекст, а не через `colors.bubbleOut`:
  // ту же карточку рисует и экран групп, где свой пузырь залит `primary`.
  const host = useBubbleSurface(isOutgoing);
  const [preview, setPreview] = useState<LinkPreviewCard | null | undefined>(() => {
    const known = previewStore.get(url);
    return known.kind === 'card' ? known.card : known.kind === 'none' ? null : undefined;
  });

  useEffect(() => {
    if (!previewStore.shouldFetch(url)) {
      const known = previewStore.get(url);
      setPreview(known.kind === 'card' ? known.card : null);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    void (async () => {
      try {
        if (fromPeer && !shouldLoadLinkPreview(true, parseIncomingLinkPreviewPref(await kvGet(LINK_PREVIEW_INCOMING_KEY)))) {
          // Ничего не запрашиваем и ничего не кэшируем: настройку могут
          // включить, не перезапуская приложение.
          if (!cancelled) setPreview(null);
          return;
        }
        const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'text/html' }, signal: ctrl.signal });
        if (cancelled) return;
        if (!res.ok) {
          // Ответ получен — про адрес это уже сведение: страницы нет.
          previewStore.remember(url, null);
          setPreview(null);
          return;
        }
        if (tooLargeToRead(res.headers.get('content-length'))) {
          // Читать целиком нельзя: карточка не стоит того, чтобы враждебная
          // ссылка положила приложение на память.
          previewStore.remember(url, null);
          setPreview(null);
          return;
        }
        const html = await res.text();
        if (cancelled) return;
        const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
        const titleTag = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
        const ogDesc = /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]
          ?? /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
        const ogImage = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
        const title = (ogTitle ?? titleTag ?? '').trim().slice(0, 100);
        const description = (ogDesc ?? '').trim().slice(0, 160);
        let domain = '';
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
        // Resolve relative image URL
        let image: string | null = null;
        if (ogImage) {
          try {
            image = ogImage.startsWith('http') ? ogImage : new URL(ogImage, url).href;
          } catch { /* ignore */ }
        }
        const result = title ? { title, description, domain, image } : null;
        previewStore.remember(url, result);
        if (!cancelled) setPreview(result);
      } catch {
        // Отмена — это про нас, а не про адрес: карточку просто не дождались,
        // и запоминать тут нечего. Считать попытку можно только тогда, когда
        // мы действительно ждали ответа и не получили его.
        if (cancelled) return;
        const spent = previewStore.noteFailure(url);
        setPreview(spent ? null : undefined);
      }
    })();
    return () => { cancelled = true; clearTimeout(to); ctrl.abort(); };
  }, [url, fromPeer]);

  if (!preview) return null;

  // v4.32.401: карточка — вложенный блок. Сначала считается её заливка от
  // пузыря-хозяина, и только потом чернила от заливки; обратный порядок в
  // светлой теме давал белое по светло-синему (см. 395).
  const hostFill = host.fill;
  const cardFill = nestedFill(hostFill);
  const cardInk = inkOn(colors, cardFill);
  const accentColor = cardInk.accent;
  const textColor = cardInk.text;
  const subtextColor = cardInk.secondary;

  return (
    <AppPressable
      onPress={() => openExternal(url, 'chat_link_preview')}
      style={[lpStyles.card, { borderColor: cardInk.muted, backgroundColor: cardFill }]}
    >
      {preview.image ? (
        <View style={{ borderRadius: radius.md, overflow: 'hidden', marginBottom: 6 }}>
          <Image
            source={{ uri: preview.image }}
            style={{ width: '100%', height: 140, resizeMode: 'cover' }}
            onError={() => {/* ignore broken images */}}
          />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={[lpStyles.bar, { backgroundColor: accentColor }]} />
        <View style={{ flex: 1 }}>
          <Text style={[lpStyles.domain, { color: accentColor }]} numberOfLines={1}>{preview.domain}</Text>
          <Text style={[lpStyles.title, { color: textColor }]} numberOfLines={2}>{preview.title}</Text>
          {preview.description ? (
            <Text style={[lpStyles.desc, { color: subtextColor }]} numberOfLines={2}>{preview.description}</Text>
          ) : null}
        </View>
      </View>
    </AppPressable>
  );
}

const lpStyles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingBottom: 6,
    paddingTop: 6,
    minWidth: 160,
  },
  bar: { width: 3, borderRadius: radius.sm, minHeight: 36 },
  domain: { fontSize: font.xs, fontWeight: '600', marginBottom: 2 },
  title: { fontSize: 13, fontWeight: '500', marginBottom: 2 },
  desc: { fontSize: 12, lineHeight: 16 },
});
