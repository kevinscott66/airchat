import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { badgeTint, scrim } from '../../../theme';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { type GroupStats } from '../../../../core/storage/local';
import { dayMonthLongYear } from '../../../../core/time/ruDateTime';
import { shownName } from '../../../../core/social/unreadableName';
import { shortIdentity } from '../../../identity/shortId';

export interface GroupStatsModalProps {
  visible: boolean;
  onClose: () => void;
  grpStats: GroupStats | null;
  memberCount: number;
}

function GroupStatsModalImpl({ visible, onClose, grpStats, memberCount }: GroupStatsModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  // v4.32.409: номер в списке — плашка от поверхности окна, цифра от плашки.
  const rankTint = badgeTint(colors, 'accent', colors.surface);
  const stopPropagation = useCallback((e: { stopPropagation?: () => void }) => { e.stopPropagation?.(); }, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={stopPropagation}
        >
          {mounted ? (
            <>
              <View style={[styles.header, { borderColor: colors.border }]}>
                <Ionicons name="stats-chart-outline" size={18} color={colors.accent} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Статистика группы</Text>
                <AppPressable onPress={onClose} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              {grpStats ? (
                <View style={styles.body}>
                  <View style={styles.tilesRow}>
                    {[
                      { label: 'Сообщений', value: grpStats.totalMessages, icon: 'chatbubble-outline' as const },
                      { label: 'Медиафайлов', value: grpStats.mediaCount, icon: 'images-outline' as const },
                      { label: 'Участников', value: memberCount, icon: 'people-outline' as const },
                    ].map((item) => (
                      <View key={item.label} style={[styles.tile, { backgroundColor: colors.surfaceHigh }]}>
                        <Ionicons name={item.icon} size={22} color={colors.accent} />
                        <Text style={[styles.tileValue, { color: colors.text }]}>{item.value}</Text>
                        <Text style={[styles.tileLabel, { color: colors.textMuted }]}>{item.label}</Text>
                      </View>
                    ))}
                  </View>
                  {grpStats.firstMessageAt ? (
                    <View style={styles.firstMsgRow}>
                      <Ionicons name="calendar-outline" size={15} color={colors.textMuted} />
                      <Text style={[styles.firstMsgText, { color: colors.textSecondary }]}>
                        {'Первое сообщение: '}
                        {dayMonthLongYear(grpStats.firstMessageAt)}
                      </Text>
                    </View>
                  ) : null}
                  {grpStats.dailyActivity && grpStats.dailyActivity.some((d) => d.count > 0) ? (
                    <>
                      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>Активность за 7 дней</Text>
                      <View style={styles.chartRow}>
                        {grpStats.dailyActivity.map((d, i) => {
                          const maxCount = Math.max(...grpStats.dailyActivity.map((x) => x.count), 1);
                          const barH = Math.max(3, Math.round((d.count / maxCount) * 44));
                          const dayLabel = d.date.slice(5).replace('-', '/');
                          const isToday = i === grpStats.dailyActivity.length - 1;
                          return (
                            <View key={i} style={styles.chartCol}>
                              <View style={[styles.bar, { height: barH, backgroundColor: isToday ? colors.accent : colors.textMuted }]} />
                              <Text style={[styles.dayLabel, { color: colors.textMuted }]}>{dayLabel}</Text>
                            </View>
                          );
                        })}
                      </View>
                    </>
                  ) : null}
                  {grpStats.topSenders.length > 0 ? (
                    <>
                      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>Самые активные</Text>
                      {grpStats.topSenders.map((s, i) => (
                        // v4.32.592: ключ строки — ключ отправителя, а не
                        // порядковый номер: порядок меняется от сообщения к
                        // сообщению, и React переиспользовал не ту строку.
                        <View key={s.pub} style={styles.senderRow}>
                          <View style={[styles.senderBadge, { backgroundColor: rankTint.fill }]}>
                            <Text style={[styles.senderBadgeText, { color: rankTint.ink }]}>{i + 1}</Text>
                          </View>
                          <Text style={[styles.senderName, { color: s.unreadable ? colors.warning : colors.text }]}>
                            {shownName(s.name, s.unreadable, shortIdentity(s.pub))}
                          </Text>
                          <Text style={[styles.senderCount, { color: colors.textMuted }]}>{s.count} сообщ.</Text>
                        </View>
                      ))}
                    </>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 8 },
  title: { fontSize: 16, fontWeight: '700', flex: 1 },
  body: { padding: 20, gap: 14 },
  tilesRow: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, alignItems: 'center', borderRadius: 12, padding: 12 },
  tileValue: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  tileLabel: { fontSize: 11, marginTop: 2, textAlign: 'center' },
  firstMsgRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  firstMsgText: { fontSize: 13 },
  sectionTitle: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  chartRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 48, marginVertical: 4 },
  chartCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '80%', borderRadius: 3 },
  dayLabel: { fontSize: 8, marginTop: 2 },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  senderBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  senderBadgeText: { fontSize: 12, fontWeight: '700' },
  senderName: { flex: 1, fontSize: 14 },
  senderCount: { fontSize: 13 },
});

export const GroupStatsModal = memo(GroupStatsModalImpl);
