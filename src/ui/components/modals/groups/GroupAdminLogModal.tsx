import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { scrim, tintedPlate } from '../../../theme';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { type GroupMessageRow } from '../../../../core/storage/local';
import { parseGroupSysText } from '../../../screens/GroupsScreen';
import { adminLogEvent } from '../../../../core/social/groupAdminLog';
import { dayMonthShortTime } from '../../../../core/time/ruDateTime';

export interface GroupAdminLogModalProps {
  visible: boolean;
  onClose: () => void;
  entries: GroupMessageRow[];
}

function GroupAdminLogModalImpl({ visible, onClose, entries }: GroupAdminLogModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => {}, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={[styles.backdrop, { backgroundColor: scrim.modal }]} onPress={onClose}>
        <AppPressable style={[styles.sheet, { backgroundColor: colors.surface }]} onPress={stopPropagation}>
          {mounted ? (
            <>
              <View style={[styles.header, { borderBottomColor: colors.border }]}>
                <Ionicons name="shield-checkmark-outline" size={18} color={colors.accent} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Журнал действий</Text>
                <AppPressable onPress={onClose} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <FlatList
                data={entries}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                renderItem={({ item }) => {
                  const eventText = parseGroupSysText(item.text);
                  // v4.32.390: разбор события — в ядре и под тестом; здесь
                  // только разворачивание имени токена в цвет.
                  const { icon: iconName, tone } = adminLogEvent(eventText);
                  // v4.32.409: подложка значка — от поверхности окна, значок — от
                  // подложки. Тонов здесь свой набор, поэтому общая реализация.
                  const plate = tintedPlate(colors[tone], colors.surface, 3);
                  return (
                    <View style={[styles.entryRow, { borderBottomColor: colors.border }]}>
                      <View style={[styles.entryIcon, { backgroundColor: plate.fill }]}>
                        <Ionicons name={iconName} size={16} color={plate.ink} />
                      </View>
                      <View style={styles.entryBody}>
                        <Text style={[styles.entryText, { color: colors.text }]}>{eventText}</Text>
                        <Text style={[styles.entryDate, { color: colors.textMuted }]}>
                          {dayMonthShortTime(item.createdAt)}
                        </Text>
                      </View>
                    </View>
                  );
                }}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Ionicons name="shield-outline" size={40} color={colors.textMuted} />
                    <Text style={[styles.emptyText, { color: colors.textMuted }]}>Нет записей в журнале</Text>
                  </View>
                }
              />
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 8 },
  title: { fontSize: 16, fontWeight: '700', flex: 1 },
  listContent: { paddingHorizontal: 16, paddingVertical: 8 },
  entryRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  entryIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  entryBody: { flex: 1 },
  entryText: { fontSize: 14 },
  entryDate: { fontSize: 11, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { marginTop: 12, fontSize: 14 },
});

export const GroupAdminLogModal = memo(GroupAdminLogModalImpl);
