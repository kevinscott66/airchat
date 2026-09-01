import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { setBackupWarnAck } from '../../core/backup/seedPhrase';
import { SafeScreen } from '../components/SafeScreen';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { useColors, useThemedStyles } from '../ThemeContext';
import { primaryInk } from '../theme';

type Props = {
  onContinue: () => void;
};

/** Shown for legacy installs: keys exist but no BIP39 mnemonic in SecureStore. */
export function BackupWarningScreen({ onContinue }: Props): React.ReactElement {
  const acknowledge = async (): Promise<void> => {
    await setBackupWarnAck();
    onContinue();
  };

  const acknowledgeBtn = useAsyncButton(acknowledge, { throttleMs: 300 });
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    center: { flex: 1, padding: 24, justifyContent: 'center' as const, backgroundColor: c.background },
    backRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      alignSelf: 'flex-start' as const,
      marginBottom: 16,
      paddingVertical: 8,
      paddingRight: 12,
    },
    backChevron: { color: c.accent, fontSize: 28, marginRight: 4, marginTop: -2 },
    backText: { color: c.accent, fontSize: 16, fontWeight: '600' as const },
    title: { fontSize: 22, fontWeight: '700' as const, color: c.text, marginBottom: 16 },
    body: { color: c.textSecondary, lineHeight: 22, marginBottom: 24 },
    btn: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: 10,
      alignItems: 'center' as const,
    },
    btnText: { color: primaryInk(c).text, fontWeight: '600' as const },
  }));

  return (
    <SafeScreen backgroundColor={colors.background}>
    <View style={styles.center} testID="backup_warning_screen">
      <AppPressable
        style={styles.backRow}
        onPress={acknowledgeBtn.onPress}
        disabled={acknowledgeBtn.loading}
        testID="back_button"
        accessibilityRole="button"
        accessibilityLabel="Назад"
      >
        <Text style={styles.backChevron}>‹</Text>
        <Text style={styles.backText}>Назад</Text>
      </AppPressable>
      <Text style={styles.title}>Резервная копия</Text>
      <Text style={styles.body}>
        Для этого устройства не сохранены секретные слова для резервной копии. Если вы обновились с предыдущей
        версии, ключи уже есть на телефоне, но без записанных слов восстановить доступ на новом устройстве нельзя.
        Вы можете сменить аккаунт через переустановку и первый запуск или продолжить как есть.
      </Text>
      <AppPressable
        style={styles.btn}
        onPress={acknowledgeBtn.onPress}
        disabled={acknowledgeBtn.loading}
        testID="btn_backup_continue"
      >
        {acknowledgeBtn.loading ? <ActivityIndicator color={primaryInk(colors).text} /> : <Text style={styles.btnText}>Понятно, продолжить</Text>}
      </AppPressable>
    </View>
    </SafeScreen>
  );
}
