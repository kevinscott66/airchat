/**
 * EmojiPanel — панель выбора эмодзи под полем ввода.
 *
 * v4.32.534. Панель жила в ChatScreen.tsx, а открывают её оба экрана: диалог
 * и группы. Второй импортировал её из первого — единственная причина, по
 * которой экран групп вообще зависел от экрана диалога.
 *
 * Таблицы категорий и подсказок уехали в chat-utils/emojiCatalog.ts: они
 * данные, а не разметка. Поведение панели не менялось.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { useTheme } from '../../ThemeContext';
import { radius, scrim } from '../../theme';
import { RECENT_EMOJIS_PANEL_KEY } from '../../../core/storage/kvKeys';
import { scopedKvGet, scopedKvSet } from '../../../core/storage/profileScopedKv';
import {
  EMOJI_CATEGORIES,
  EMOJI_SEARCH_HINTS,
  SKIN_MODIFIERS,
  SKIN_TONE_SUPPORT_RE,
} from '../chat-utils/emojiCatalog';

export function EmojiPanel({
  onEmoji,
  colors,
}: {
  onEmoji: (emoji: string) => void;
  colors: ReturnType<typeof useTheme>['colors'];
}): React.ReactElement {
  const [catIdx, setCatIdx] = useState(0);
  const [skinTarget, setSkinTarget] = useState<string | null>(null);
  const [emojiSearchQ, setEmojiSearchQ] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const cat = EMOJI_CATEGORIES[catIdx];

  useEffect(() => {
    // v4.32.190 (Round-20 #5): alive guard + Array.isArray shape check.
    let alive = true;
    void scopedKvGet(RECENT_EMOJIS_PANEL_KEY).then((raw) => {
      if (!alive || !raw) return;
      try {
        const p = JSON.parse(raw);
        if (Array.isArray(p)) setRecentEmojis(p.filter((x): x is string => typeof x === 'string').slice(0, 24));
      } catch { /* ignore */ }
    });
    return () => { alive = false; };
  }, []);

  const handleEmoji = (emoji: string) => {
    onEmoji(emoji);
    setRecentEmojis((prev) => {
      const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, 24);
      void scopedKvSet(RECENT_EMOJIS_PANEL_KEY, JSON.stringify(next));
      return next;
    });
  };

  const allEmojis = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
  const searchResults = emojiSearchQ.trim()
    ? allEmojis.filter((e) => {
        const q = emojiSearchQ.toLowerCase();
        // Simple: check if the emoji text includes the query (useful for emoji keyboard names in some environments)
        // Also check name from EMOJI_CATEGORIES labels heuristically
        return e.includes(q) || EMOJI_SEARCH_HINTS[e]?.some((kw) => kw.includes(q));
      }).slice(0, 80)
    : null;

  const EmojiGrid = ({ emojis }: { emojis: string[] }) => (
    <View style={epStyles.grid}>
      {emojis.map((emoji) => {
        const supportsSkin = SKIN_TONE_SUPPORT_RE.test(emoji);
        return (
          <AppPressable
            key={emoji}
            style={[epStyles.emojiCell, supportsSkin && { position: 'relative' }]}
            onPress={() => handleEmoji(emoji)}
            onLongPress={() => supportsSkin ? setSkinTarget(emoji) : handleEmoji(emoji)}
          >
            <Text style={epStyles.emojiGlyph}>{emoji}</Text>
            {supportsSkin ? (
              <View style={{ position: 'absolute', bottom: 2, right: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textMuted, opacity: 0.5 }} />
            ) : null}
          </AppPressable>
        );
      })}
    </View>
  );

  return (
    <View style={[epStyles.root, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      {/* Skin tone picker popover */}
      {skinTarget !== null ? (
        <AppPressable
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, backgroundColor: scrim.modal, justifyContent: 'center', alignItems: 'center' }}
          onPress={() => setSkinTarget(null)}
        >
          <View style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.lg, padding: 8, gap: 4, borderWidth: 1, borderColor: colors.border, elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 }}>
            <AppPressable onPress={() => { handleEmoji(skinTarget); setSkinTarget(null); }} style={{ padding: 6 }}>
              <Text style={{ fontSize: 26 }}>{skinTarget}</Text>
            </AppPressable>
            {SKIN_MODIFIERS.map((mod) => (
              <AppPressable key={mod} onPress={() => { handleEmoji(skinTarget + mod); setSkinTarget(null); }} style={{ padding: 6 }}>
                <Text style={{ fontSize: 26 }}>{skinTarget}{mod}</Text>
              </AppPressable>
            ))}
          </View>
        </AppPressable>
      ) : null}
      {/* Search bar */}
      <View style={[epStyles.searchRow, { backgroundColor: colors.surfaceHigh, borderBottomColor: colors.border }]}>
        <Ionicons name="search" size={15} color={colors.textMuted} style={{ marginRight: 6 }} />
        <TextInput
          value={emojiSearchQ}
          onChangeText={setEmojiSearchQ}
          placeholder="Поиск эмодзи…"
          placeholderTextColor={colors.textMuted}
          style={{ flex: 1, color: colors.text, fontSize: 13, paddingVertical: 4 }}
          returnKeyType="done"
        />
        {emojiSearchQ ? (
          <AppPressable onPress={() => setEmojiSearchQ('')} hitSlop={8}>
            <Ionicons name="close-circle" size={15} color={colors.textMuted} />
          </AppPressable>
        ) : null}
      </View>
      {!emojiSearchQ ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[epStyles.catRow, { borderBottomColor: colors.border }]}
            contentContainerStyle={{ paddingHorizontal: 4 }}
          >
            <AppPressable
              style={[epStyles.catTab, catIdx === -1 && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
              onPress={() => setCatIdx(-1)}
            >
              <Text style={epStyles.catIcon}>🕐</Text>
            </AppPressable>
            {EMOJI_CATEGORIES.map((c, i) => (
              <AppPressable
                key={c.label}
                style={[epStyles.catTab, i === catIdx && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
                onPress={() => setCatIdx(i)}
              >
                <Text style={epStyles.catIcon}>{c.icon}</Text>
              </AppPressable>
            ))}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
            {catIdx === -1 ? (
              recentEmojis.length > 0 ? <EmojiGrid emojis={recentEmojis} /> : (
                <Text style={{ textAlign: 'center', color: colors.textMuted, marginTop: 20, fontSize: 13 }}>Ещё нет истории</Text>
              )
            ) : (
              <EmojiGrid emojis={cat.emojis} />
            )}
          </ScrollView>
        </>
      ) : searchResults !== null ? (
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always">
          {searchResults.length > 0
            ? <EmojiGrid emojis={searchResults} />
            : <Text style={{ textAlign: 'center', color: colors.textMuted, marginTop: 20, fontSize: 13 }}>Ничего не найдено</Text>
          }
        </ScrollView>
      ) : null}
    </View>
  );
}

const epStyles = StyleSheet.create({
  root: { height: 280, borderTopWidth: StyleSheet.hairlineWidth },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  catRow: { maxHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth },
  catTab: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  catIcon: { fontSize: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 4, paddingVertical: 6 },
  emojiCell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emojiGlyph: { fontSize: 24 },
});
