import React, { memo, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import type { QuickReply } from '../../../../core/storage/local';

export interface ChatQuickRepliesModalProps {
  visible: boolean;
  onClose: () => void;
  onPick: (text: string) => void;
  quickReplies: QuickReply[];
}

function ChatQuickRepliesModalImpl({ visible, onClose, onPick, quickReplies }: ChatQuickRepliesModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => {}, []);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <AppPressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheetWrap}>
          <AppPressable
            onPress={stopPropagation}
            style={[styles.sheet, { backgroundColor: colors.surface }]}
          >
            {mounted ? (
              <>
                <View style={styles.handleWrap}>
                  <View style={[styles.handle, { backgroundColor: colors.border }]} />
                </View>
                <Text style={[styles.title, { color: colors.text }]}>Быстрые ответы</Text>
                {quickReplies.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>
                    Нет шаблонов. Добавьте в Настройки → Быстрые ответы.
                  </Text>
                ) : (
                  <ScrollView style={styles.scroll}>
                    {quickReplies.map((qr) => (
                      <QuickReplyRow
                        key={qr.id}
                        text={qr.text}
                        onPick={onPick}
                        onClose={onClose}
                        textColor={colors.text}
                        surfaceColor={colors.surface}
                        surfaceHighColor={colors.surfaceHigh}
                        borderColor={colors.border}
                      />
                    ))}
                  </ScrollView>
                )}
              </>
            ) : null}
          </AppPressable>
        </View>
      </AppPressable>
    </Modal>
  );
}

interface RowProps {
  text: string;
  onPick: (text: string) => void;
  onClose: () => void;
  textColor: string;
  surfaceColor: string;
  surfaceHighColor: string;
  borderColor: string;
}

function QuickReplyRowImpl({ text, onPick, onClose, textColor, surfaceColor, surfaceHighColor, borderColor }: RowProps) {
  const getStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => ({
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: pressed ? surfaceHighColor : surfaceColor,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: borderColor,
    }),
    [surfaceColor, surfaceHighColor, borderColor],
  );
  const handlePress = useCallback(() => {
    onPick(text);
    onClose();
  }, [onPick, onClose, text]);
  return (
    <AppPressable style={getStyle} onPress={handlePress}>
      <Text style={[styles.rowText, { color: textColor }]}>{text}</Text>
    </AppPressable>
  );
}
const QuickReplyRow = memo(QuickReplyRowImpl);

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    maxHeight: 360,
  },
  handleWrap: { alignItems: 'center', paddingVertical: 8 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  title: { fontSize: 16, fontWeight: '600', paddingHorizontal: 16, paddingBottom: 8 },
  empty: { textAlign: 'center', padding: 24 },
  scroll: { maxHeight: 280 },
  rowText: { fontSize: 15 },
});

export const ChatQuickRepliesModal = memo(ChatQuickRepliesModalImpl);
