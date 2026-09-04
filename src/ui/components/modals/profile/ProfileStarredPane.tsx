/**
 * ProfileStarredPane — «Избранное» разделом прямо в карточке профиля
 * (v4.32.577).
 *
 * Раньше плашка «Избранное» уводила из карточки на экран диалога и карточку
 * закрывала: человек нажимал раздел профиля, а оказывался в переписке. Теперь
 * отмеченное показывается там же, под полосой разделов.
 *
 * Охват честный и он разный у своей карточки и чужой. В чужой это отмеченное
 * из переписки ИМЕННО с этим человеком — иначе раздел профиля показывал бы
 * чужие разговоры. В своей — всё отмеченное: своей переписки «с самим собой»
 * для этого мало, звёздочку ставят по всем диалогам и группам.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { font, spacing } from '../../../theme';
import { listStarredMessages, type StarredMessageEntry } from '../../../../core/storage/local';
import { UNREADABLE_MESSAGE_TEXT } from '../../../../core/storage/unreadableText';
import { dayMonthShortTime } from '../../../../core/time/ruDateTime';
import { log } from '../../../../core/logger';
import { rawErrorText } from '../../userErrorText';

export function ProfileStarredPane({
  active,
  ownerProfileId,
  /** Чья переписка. `null` — своя карточка: показываем всё отмеченное. */
  contactPubB64,
  limit = null,
  onShowAll,
}: {
  active: boolean;
  ownerProfileId: number;
  contactPubB64: string | null;
  limit?: number | null;
  onShowAll?: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [rows, setRows] = useState<StarredMessageEntry[]>([]);
  // Пока не дочитали — это «ещё не знаем», а не «пусто»: подпись под пустым
  // списком появляется только после чтения.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoaded(false);
    void listStarredMessages(ownerProfileId)
      .then((all) => {
        if (cancelled) return;
        setRows(contactPubB64
          ? all.filter((e) => e.kind === 'chat' && e.contextId === contactPubB64)
          : all);
        setLoaded(true);
      })
      .catch((e) => log.warn('ui_profile_starred_failed', { err: rawErrorText(e) }));
    return () => { cancelled = true; };
  }, [active, ownerProfileId, contactPubB64]);

  const shown = limit === null ? rows : rows.slice(0, limit);

  if (rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Ionicons name="star-outline" size={44} color={colors.textMuted} />
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>
          {loaded
            ? 'Здесь пусто. Отмеченные звёздочкой сообщения собираются сюда.'
            : 'Читаем…'}
        </Text>
      </View>
    );
  }

  return (
    <View>
      {shown.map((e) => (
        <View key={`${e.kind}_${e.message.id}`} style={[styles.row, { borderColor: colors.border }]}>
          <Text style={[styles.context, { color: colors.textMuted }]} numberOfLines={1}>
            {e.contextName} · {dayMonthShortTime(e.message.createdAt)}
          </Text>
          <Text
            style={[
              styles.text,
              { color: e.message.unreadable ? colors.textMuted : colors.text },
              e.message.unreadable ? styles.unreadable : null,
            ]}
            numberOfLines={3}
          >
            {e.message.unreadable ? UNREADABLE_MESSAGE_TEXT : (e.message.text || '—')}
          </Text>
        </View>
      ))}
      {rows.length > shown.length && onShowAll ? (
        <AppPressable
          style={styles.more}
          onPress={onShowAll}
          accessibilityRole="button"
          accessibilityLabel="Показать всё"
        >
          <Text style={[styles.moreText, { color: colors.accent }]}>
            Показать всё · {rows.length}
          </Text>
        </AppPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  context: { fontSize: font.xs },
  text: { fontSize: font.sm },
  unreadable: { fontStyle: 'italic' },
  more: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  moreText: { fontSize: font.sm, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: font.sm, textAlign: 'center' },
});

export default ProfileStarredPane;
