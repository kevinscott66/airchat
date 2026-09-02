import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AppModal as Modal } from './AppModal';
import { useColors, useThemedStyles } from '../ThemeContext';
import { radius, scrim } from '../theme';

export type LoadingOverlayProps = {
  visible: boolean;
  message?: string;
  testID?: string;
};

/**
 * Полноэкранный индикатор поверх текущего UI (асинхронные операции).
 */
export function LoadingOverlay({
  visible,
  message = 'Загрузка…',
  testID = 'loading_overlay',
}: LoadingOverlayProps): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    overlay: {
      flex: 1,
      // Затемнение поверх экрана. Чёрный с прозрачностью работает в обеих
      // темах; прежний rgba(11,16,32,.85) — это фон тёмной темы, и на светлой
      // он превращал затемнение в глухую тёмно-синюю плиту. v4.32.412: значение
      // берётся из `scrim`, а не пишется здесь.
      backgroundColor: scrim.modal,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      padding: 24,
    },
    box: {
      backgroundColor: c.surface,
      paddingVertical: 24,
      paddingHorizontal: 28,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center' as const,
      minWidth: 200,
    },
    message: {
      marginTop: 14,
      color: c.text,
      fontSize: 15,
      textAlign: 'center' as const,
    },
  }));
  return (
    <Modal transparent visible={visible} animationType="fade">
      <View style={styles.overlay} pointerEvents="box-none" testID={testID}>
        <View style={styles.box}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.message}>{message}</Text>
        </View>
      </View>
    </Modal>
  );
}
