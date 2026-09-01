/**
 * Список запланированных сообщений — один на переписку и на группу.
 *
 * Измеренный дефект (v4.32.566). До этой версии список существовал двумя
 * файлами — `modals/chat/ChatScheduledListModal.tsx` и
 * `modals/groups/GroupScheduledListModal.tsx`, — которые `diff` разводил
 * ровно по четырём строкам: имя типа элемента, имя типа пропсов, имя функции
 * и имя экспорта. Ни одного различия в разметке, стилях, поведении удаления
 * или подписи строки между ними не было; во второй копии не хватало только
 * комментария о том, почему внутри строки нельзя звать `useTheme`.
 *
 * Почему это дефект, а не вкусовщина. Расхождение уже случилось и уже стоило
 * правок: v4.32.565 добавляла проверку «строка не прочиталась — не отправим,
 * покажем причину» и вносила одни и те же четыре изменения руками в оба
 * файла. Совпали они только потому, что правку делали в один заход. Любая
 * следующая правка одного из списков — новая колонка, другой текст
 * подтверждения удаления, исправление отступа — оставляла бы второй список
 * прежним, и пользователь получал бы два разных экрана под одним названием,
 * причём молча: тип у них разный, поэтому ни компилятор, ни тесты о
 * расхождении не сказали бы ни слова.
 *
 * Что здесь изменилось. Компонент один, оба экрана зовут его. Тип элемента
 * тоже один: `ScheduledItem`. Разницы между переписной и групповой строкой
 * расписания нет и на уровне хранения — обе приходят из одной таблицы через
 * `rowToScheduled`, поэтому отдельный `GroupScheduledItem` описывал ту же
 * форму под другим именем.
 */
import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { scrim } from '../../../theme';
import { dayMonthShortTime } from '../../../../core/time/ruDateTime';
import { decideScheduledSend, scheduledHoldTitle, type ScheduledReadState } from '../../../../core/social/scheduledDispatch';

export interface ScheduledItem {
  id: string;
  text: string;
  sendAt: number;
  /**
   * v4.32.565: прочиталась ли строка расписания. Непрочитанная не уходит
   * никогда, и без подписи выглядела здесь как пустое сообщение, которое
   * вот-вот отправится.
   */
  readState?: ScheduledReadState;
}

export interface ScheduledListModalProps {
  visible: boolean;
  onClose: () => void;
  scheduled: ScheduledItem[];
  onDelete: (id: string) => void;
}

const noop = () => {};

function ScheduledListModalImpl({ visible, onClose, scheduled, onDelete }: ScheduledListModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <AppPressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={noop}
        >
          {mounted ? (
            <>
              <View style={[styles.header, { borderColor: colors.border }]}>
                <Ionicons name="time-outline" size={20} color={colors.accent} style={styles.headerIcon} />
                <Text style={[styles.title, { color: colors.text }]}>Запланированные</Text>
                <AppPressable onPress={onClose}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView contentContainerStyle={styles.scrollContent}>
                {scheduled.map((m) => (
                  <ScheduledRow
                    key={m.id}
                    item={m}
                    onDelete={onDelete}
                    textColor={colors.text}
                    mutedColor={colors.textMuted}
                    borderColor={colors.border}
                    dangerColor={colors.error}
                  />
                ))}
              </ScrollView>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

interface RowProps {
  item: ScheduledItem;
  onDelete: (id: string) => void;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  /** Строка обёрнута в memo, поэтому useTheme внутри неё звать нельзя. */
  dangerColor: string;
}

function ScheduledRowImpl({ item, onDelete, textColor, mutedColor, borderColor, dangerColor }: RowProps) {
  const handlePress = useCallback(() => {
    Alert.alert('Удалить?', 'Отменить запланированное сообщение?', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => onDelete(item.id) },
    ]);
  }, [onDelete, item.id]);
  // v4.32.565: причина задержки — не украшение. Строку, которая не уйдёт,
  // пользователь иначе видит пустой и ждёт её отправки вечно.
  const verdict = decideScheduledSend(item);
  const held = verdict.kind === 'hold' ? verdict : null;
  return (
    <View style={[styles.row, { borderColor }]}>
      <View style={styles.rowContent}>
        <Text
          style={[styles.rowText, { color: held ? mutedColor : textColor }, held && styles.rowHeld]}
          numberOfLines={2}
        >
          {held ? scheduledHoldTitle(held.code) : item.text}
        </Text>
        <Text style={[styles.rowDate, { color: mutedColor }]}>
          {dayMonthShortTime(item.sendAt)}
        </Text>
      </View>
      <AppPressable style={styles.delBtn} onPress={handlePress}>
        <Ionicons name="trash-outline" size={20} color={dangerColor} />
      </AppPressable>
    </View>
  );
}
const ScheduledRow = memo(ScheduledRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: scrim.modal },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  headerIcon: { marginRight: 10 },
  title: { fontSize: 17, fontWeight: '700', flex: 1 },
  scrollContent: { paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowContent: { flex: 1 },
  rowText: { fontSize: 14 },
  rowHeld: { fontStyle: 'italic' },
  rowDate: { fontSize: 12, marginTop: 3 },
  delBtn: { padding: 8 },
});

export const ScheduledListModal = memo(ScheduledListModalImpl);
