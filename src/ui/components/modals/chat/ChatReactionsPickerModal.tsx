import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';

export interface ChatReactionsPickerModalProps {
  visible: boolean;
  onClose: () => void;
  renderPanel: () => React.ReactNode;
}

const noop = () => {};

function ChatReactionsPickerModalImpl({ visible, onClose, renderPanel }: ChatReactionsPickerModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheetWrap}>
          <AppPressable onPress={noop}>
            <View style={[styles.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
              <Text style={[styles.title, { color: colors.text }]}>Выбрать реакцию</Text>
              <AppPressable onPress={onClose}>
                <Ionicons name="close" size={22} color={colors.text} />
              </AppPressable>
            </View>
            {mounted ? renderPanel() : null}
          </AppPressable>
        </View>
      </AppPressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
});

export const ChatReactionsPickerModal = memo(ChatReactionsPickerModalImpl);
