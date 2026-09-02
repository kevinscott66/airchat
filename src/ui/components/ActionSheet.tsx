// v4.32.227 (BUG-09): Cross-platform scrollable action sheet.
//
// Зачем: на Android RN `Alert.alert(title, msg, buttons)` рендерит только ПЕРВЫЕ 3
// кнопки (native AlertDialog поддерживает лишь positive/negative/neutral) и молча
// отбрасывает остальные — включая хвостовую { text: 'Отмена', style: 'cancel' }.
// Поэтому длинные меню (≈15 пунктов «Настройки группы», меню действий с сообщением)
// на Android превращались в неотменяемую ловушку. Этот компонент — тёмная, в тему
// приложения, прокручиваемая модалка со списком пунктов и липкой кнопкой «Отмена».
// Закрывается тапом по подложке и аппаратной кнопкой BACK (onRequestClose).
//
// Использование (state-driven): держите состояние
//   const [sheet, setSheet] = useState<ActionSheetState>(null);
// рендерите <ActionSheet state={sheet} onClose={() => setSheet(null)} /> один раз
// в дереве, и открывайте меню через setSheet({ title, options }).

import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppPressable } from './AppPressable';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTheme } from '../ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, scrim } from '../theme';

export interface ActionSheetOption {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export interface ActionSheetSpec {
  title: string;
  /** Необязательное описание под заголовком (как message у Alert). */
  message?: string;
  options: ActionSheetOption[];
}

export type ActionSheetState = ActionSheetSpec | null;

export function ActionSheet({
  state,
  onClose,
}: {
  state: ActionSheetState;
  onClose: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const visible = state !== null;

  const handlePick = (opt: ActionSheetOption) => {
    // Сначала закрываем лист, затем вызываем onPress на следующем кадре —
    // чтобы вложенные меню/Alert не конфликтовали с анимацией закрытия Modal.
    onClose();
    requestAnimationFrame(() => opt.onPress());
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.flex}>
        {/* Подложка: тап закрывает лист */}
        <AppPressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          {state ? (
            <>
              {state.title ? (
                <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{state.title}</Text>
              ) : null}
              {state.message ? (
                <Text style={[styles.message, { color: colors.textSecondary }]}>{state.message}</Text>
              ) : null}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={{ paddingBottom: 4 }}
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator
              >
                {state.options.map((opt, idx) => (
                  <AppPressable
                    key={`${opt.label}-${idx}`}
                    style={[styles.row, { borderTopColor: colors.border }]}
                    onPress={() => handlePick(opt)}
                  >
                    <Text
                      style={[styles.rowText, { color: opt.destructive ? colors.error : colors.text }]}
                      numberOfLines={2}
                    >
                      {opt.label}
                    </Text>
                  </AppPressable>
                ))}
              </ScrollView>
              {/* Липкая «Отмена» */}
              <AppPressable
                style={[styles.cancel, { backgroundColor: colors.surfaceHigh }]}
                onPress={onClose}
              >
                <Text style={[styles.cancelText, { color: colors.text }]}>Отмена</Text>
              </AppPressable>
            </>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: scrim.modal },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '80%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  handleWrap: { alignItems: 'center', paddingVertical: 6 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  title: { fontSize: 16, fontWeight: '700', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 4 },
  message: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 8 },
  scroll: { flexGrow: 0 },
  row: { paddingVertical: 15, paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { fontSize: 16 },
  cancel: { marginHorizontal: 12, marginTop: 8, borderRadius: radius.lg, paddingVertical: 15, alignItems: 'center' },
  cancelText: { fontSize: 16, fontWeight: '600' },
});

export default ActionSheet;
