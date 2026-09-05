import React, { useState } from 'react';
import {
  Text,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { authGuard } from '../../core/security/authGuard';
import { SafeScreen } from '../components/SafeScreen';
import { AuthBackdrop } from '../components/AuthBackdrop';
import { GlassSurface } from '../components/GlassSurface';
import { SecretScreenGuard } from '../components/SecretScreenGuard';
import { showError, showSuccess } from '../components/userFeedback';
import { useThemedStyles, useColors } from '../ThemeContext';
import { authCardRim, formColumn, primaryInk, radius } from '../theme';

type Props = {
  onSuccess: () => void;
  onCancel: () => void;
};

export function ForgotPasswordScreen({ onSuccess, onCancel }: Props): React.ReactElement {
  const [mnemonic, setMnemonic] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    flex: { flex: 1 },
    // v4.32.591: прокрутка только центрирует, ширину и поля держит карточка.
    scroll: {
      flexGrow: 1,
      padding: 20,
      paddingBottom: 40,
      justifyContent: 'center' as const,
    },
    // Тот же потолок ширины и то же стекло, что у экранов заведения аккаунта:
    // это тот же разговор с человеком без аккаунта, и поле со словами с
    // кнопкой «сбросить» не должны растягиваться на всю ширину окна браузера.
    card: {
      width: '100%' as const,
      maxWidth: formColumn.maxWidth,
      alignSelf: 'center' as const,
      padding: 20,
      borderRadius: radius.lg,
    },
    title: {
      fontSize: 22,
      fontWeight: '700' as const,
      color: c.text,
      marginBottom: 8,
      textAlign: 'center' as const,
    },
    desc: {
      fontSize: 14,
      color: c.textSecondary,
      lineHeight: 20,
      marginBottom: 20,
      textAlign: 'center' as const,
    },
    label: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: c.textSecondary,
      marginBottom: 6,
    },
    // Кромка, а не `border`: на стеклянной карточке палитровый контур даёт
    // около 1.2:1 при пороге графики 3:1 — поля исчезают (см. authCardRim).
    input: {
      borderWidth: 1,
      borderColor: authCardRim(c),
      borderRadius: radius.md,
      padding: 12,
      fontSize: 16,
      color: c.text,
      backgroundColor: c.surface,
      marginBottom: 14,
    },
    multiline: { minHeight: 100, textAlignVertical: 'top' as const },
    button: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
      marginTop: 8,
    },
    buttonDisabled: { opacity: 0.7 },
    buttonText: { color: primaryInk(c).text, fontSize: 16, fontWeight: '600' as const },
    cancelWrap: { marginTop: 16, alignItems: 'center' as const },
    cancelText: { color: c.accent, fontSize: 16 },
  }));

  const submit = async (): Promise<void> => {
    const m = mnemonic.trim();
    if (!m) {
      showError('Введите секретные слова');
      return;
    }
    if (newPassword.length < authGuard.minPasswordLength) {
      showError(`Пароль не короче ${authGuard.minPasswordLength} символов`);
      return;
    }
    if (newPassword !== confirm) {
      showError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    try {
      const match = await authGuard.verifyMnemonicMatchesWallet(m);
      if (!match) {
        showError('Слова не совпадают с аккаунтом на этом устройстве');
        return;
      }
      const ok = await authGuard.resetPasswordWithVerifiedSeed(m, newPassword);
      if (!ok) {
        showError('Не удалось сохранить пароль');
        return;
      }
      showSuccess('Новый пароль сохранён');
      onSuccess();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeScreen edges={['top', 'bottom']} backgroundColor={colors.background}>
      <AuthBackdrop />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          testID="forgot_password_screen"
        >
          <GlassSurface variant="prominent" style={styles.card}>
          <Text style={styles.title}>Восстановление по секретным словам</Text>
          <Text style={styles.desc}>
            Введите те же секретные слова (24 слова), что сохранены для этого аккаунта, и задайте новый пароль
            приложения.
          </Text>

          <Text style={styles.label}>Секретные слова</Text>
          {/* Введённые слова так же дороги, как показанные при заведении
              аккаунта, — тот же щит (v4.32.581). `textContentType`/
              `autoComplete` тут не для удобства: без них слова из этого поля
              попадают в словарь подсказок клавиатуры и всплывают потом в
              чужой переписке. */}
          <SecretScreenGuard>
            <TextInput
              style={[styles.input, styles.multiline]}
              placeholder="24 слова…"
              placeholderTextColor={colors.textMuted}
              value={mnemonic}
              onChangeText={setMnemonic}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              testID="forgot_seed_input"
            />
          </SecretScreenGuard>

          <Text style={styles.label}>Новый пароль</Text>
          <TextInput
            style={styles.input}
            placeholder="Минимум 4 символа"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
            autoCapitalize="none"
            testID="forgot_new_pwd"
          />

          <Text style={styles.label}>Повтор пароля</Text>
          <TextInput
            style={styles.input}
            placeholder="Ещё раз"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            value={confirm}
            onChangeText={setConfirm}
            autoCapitalize="none"
            testID="forgot_confirm_pwd"
          />

          <AppPressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={() => void submit()}
            disabled={busy}
            testID="forgot_submit"
          >
            {busy ? <ActivityIndicator color={primaryInk(colors).text} /> : <Text style={styles.buttonText}>Сохранить</Text>}
          </AppPressable>

          <AppPressable onPress={onCancel} style={styles.cancelWrap} testID="forgot_cancel">
            <Text style={styles.cancelText}>Назад к вводу пароля</Text>
          </AppPressable>
          </GlassSurface>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}
