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
import {
  markPasswordBoundCopiesStale,
  passwordChangeAftermathText,
} from '../../core/security/passwordChangeAftermath';
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from '../../core/security/passwordPolicy';
import { checkSeedWordCount, normalizeSeedInput } from './seedInput';
import { SafeScreen } from '../components/SafeScreen';
import { AuthBackdrop } from '../components/AuthBackdrop';
import { GlassSurface } from '../components/GlassSurface';
import { SecretScreenGuard } from '../components/SecretScreenGuard';
import { showError, showSuccess } from '../components/userFeedback';
import { userErrorText } from '../components/userErrorText';
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
    // v4.32.651: экран восстановления пароля разбирал ввод сам — одним
    // `trim()`. Свои же 24 слова приложение показывает нумерованными, и
    // вставленная оттуда фраза не проходила: `verifyMnemonicMatchesWallet`
    // только схлопывает пробелы, не убирая ни номеров, ни запятых, ни верхнего
    // регистра. Человеку при этом отвечали «Слова не совпадают с аккаунтом на
    // этом устройстве» — то есть обвиняли его в чужой фразе при полностью
    // правильной. Разбор тот же, что на экране восстановления аккаунта.
    const m = normalizeSeedInput(mnemonic);
    const countCheck = checkSeedWordCount(m);
    if (!countCheck.ok) {
      showError(countCheck.message);
      return;
    }
    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      showError(policyError);
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
      // v4.32.868: копии секретных слов на сервере — конверт у Apple ID и архив
      // в облаке — зашифрованы ключом, выведенным из СТАРОГО пароля, и новым не
      // откроются. Штатная смена пароля это учитывает, а этот путь проходил
      // мимо: настройки продолжали обещать запасной путь, и узнать правду можно
      // было только на новом телефоне, когда слов на руках уже нет.
      const text = passwordChangeAftermathText(await markPasswordBoundCopiesStale());
      if (text) showError(text);
      // Нечитаемая подсказка (`unknown`) молчит: была ли копия, отсюда не видно
      // — на этом экране свидетеля нет, в отличие от настроек. Пугать человека
      // копией, которой могло не быть, в минуту, когда он только что вернул
      // себе доступ, хуже, чем промолчать: настройки покажут состояние сами.
      onSuccess();
    } catch (e: unknown) {
      // v4.32.626: обе проверки выше ходят в защищённое хранилище и умеют
      // бросать. Вызов стоит под `void submit()`, ловить отказ было некому —
      // и нажатие «Сохранить» не делало ничего: ни пароля, ни объяснения.
      showError(userErrorText(e, 'Не удалось сохранить пароль'));
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

          <Text style={styles.label} nativeID="forgot_seed_label">Секретные слова</Text>
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
              accessibilityLabel="Секретные слова"
              accessibilityLabelledBy="forgot_seed_label"
            />
          </SecretScreenGuard>

          <Text style={styles.label} nativeID="forgot_new_pwd_label">Новый пароль</Text>
          <TextInput
            style={styles.input}
            placeholder={`Минимум ${PASSWORD_MIN_LENGTH} символов`}
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
            autoCapitalize="none"
            testID="forgot_new_pwd"
            accessibilityLabel="Новый пароль"
            accessibilityLabelledBy="forgot_new_pwd_label"
          />

          <Text style={styles.label} nativeID="forgot_confirm_pwd_label">Повтор пароля</Text>
          <TextInput
            style={styles.input}
            placeholder="Ещё раз"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            value={confirm}
            onChangeText={setConfirm}
            autoCapitalize="none"
            testID="forgot_confirm_pwd"
            accessibilityLabel="Повтор пароля"
            accessibilityLabelledBy="forgot_confirm_pwd_label"
          />

          <AppPressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={() => void submit()}
            disabled={busy}
            accessibilityState={{ disabled: busy, busy: busy }}
            testID="forgot_submit"
            accessibilityRole="button"
            accessibilityLabel="Сохранить"
          >
            {busy ? <ActivityIndicator color={primaryInk(colors).text} /> : <Text style={styles.buttonText}>Сохранить</Text>}
          </AppPressable>

          <AppPressable
            onPress={onCancel}
            style={styles.cancelWrap}
            testID="forgot_cancel"
            accessibilityRole="button"
            accessibilityLabel="Назад к вводу пароля"
          >
            <Text style={styles.cancelText}>Назад к вводу пароля</Text>
          </AppPressable>
          </GlassSurface>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}
