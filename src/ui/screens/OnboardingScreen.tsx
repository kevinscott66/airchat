import React, { useCallback, useEffect, useState } from 'react';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { useBackHandler } from '../../core/hooks/useBackHandler';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { useThemedStyles, useColors } from '../ThemeContext';
import { primaryInk, radius } from '../theme';
import {
  generateMnemonicAndStore,
  getStoredMnemonic,
  hasSeedShown,
  hasStoredMnemonic,
  importEncryptedBackup,
  restoreFromMnemonic,
  setFirstLaunchDone,
  setSeedShown,
  wipeMnemonicAndSessionFlags,
} from '../../core/backup/seedPhrase';
import { looksLikeEncryptedBackup } from '../../core/backup/backupFormat';
import { deleteKeyPairFromStore, loadKeyPair } from '../../core/crypto/keyManager';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { SafeScreen } from '../components/SafeScreen';
import { validateMnemonic } from 'bip39';
import { PermissionsScreen } from './PermissionsScreen';
import { checkSeedWordCount, normalizeSeedInput } from './seedInput';
import { rawErrorText, userErrorText } from '../components/userErrorText';
import { isCloudVaultConfigured, restoreCloudVault } from '../../core/backup/cloudVault';

type Step = 'permissions' | 'welcome' | 'restore' | 'showSeed';

type Props = {
  onComplete: (pair: KeyPairBytes) => void | Promise<void>;
};

export function OnboardingScreen({ onComplete }: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    kav: { flex: 1, backgroundColor: c.background },
    restoreScrollContent: {
      flexGrow: 1,
      paddingHorizontal: 24,
      paddingVertical: 40,
      justifyContent: 'center' as const,
    },
    restoreInner: { backgroundColor: c.background },
    flex: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, padding: 24, justifyContent: 'center' as const, backgroundColor: c.background },
    scroll: { flex: 1, backgroundColor: c.background },
    scrollContent: { padding: 20, paddingBottom: 40 },
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
    title: { fontSize: 26, fontWeight: '700' as const, color: c.text, marginBottom: 12 },
    sub: { color: c.textSecondary, marginBottom: 20, lineHeight: 22 },
    warn: {
      color: c.warning,
      marginBottom: 16,
      lineHeight: 22,
      fontWeight: '600' as const,
    },
    encHint: {
      color: c.textSecondary,
      marginBottom: 20,
      lineHeight: 20,
      fontSize: 13,
    },
    grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8, marginBottom: 24 },
    word: { width: '48%' as const, color: c.text, fontSize: 14 },
    btn: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
      marginBottom: 12,
    },
    btnSecondary: {
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
    },
    btnText: { color: primaryInk(c).text, fontWeight: '600' as const },
    btnTextDark: { color: c.text, fontWeight: '600' as const },
    textarea: {
      minHeight: 120,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 12,
      color: c.text,
      backgroundColor: c.surface,
      marginBottom: 16,
      textAlignVertical: 'top' as const,
    },
    pwdInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 12,
      color: c.text,
      backgroundColor: c.surface,
      marginBottom: 16,
    },
  }));
  // Show permissions screen first on Android, skip on iOS (handled by OS)
  const [step, setStep] = useState<Step>(
    Platform.OS === 'android' ? 'permissions' : 'welcome'
  );
  const [seedWords, setSeedWords] = useState<string[]>([]);
  const [pendingPair, setPendingPair] = useState<KeyPairBytes | null>(null);
  const [restoreText, setRestoreText] = useState('');
  const [restorePwd, setRestorePwd] = useState('');
  const [cloudPwd, setCloudPwd] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * v4.32.376: в это же поле вставляют зашифрованную резервную копию — ту, что
   * выдаёт «Резервная копия» в профиле. Загрузить её раньше было негде вовсе.
   */
  const isBackupPaste = looksLikeEncryptedBackup(restoreText);

  /**
   * Если seed уже сгенерирован и сохранён в SecureStore, но пользователь не подтвердил, что записал его,
   * нужно показывать сидку снова (иначе можно «пропустить» важный шаг, выйдя со страницы).
   */
  useEffect(() => {
    let cancelled = false;
    if (step !== 'welcome') return;
    void (async () => {
      try {
        if (!(await hasStoredMnemonic())) return;
        if (await hasSeedShown()) return;
        const mnemonic = await getStoredMnemonic();
        if (!mnemonic?.trim()) return;
        const words = mnemonic.trim().split(/\s+/);
        let pair = await loadKeyPair();
        if (!pair) {
          // В редких случаях ключи могли не сохраниться/восстановиться — восстановим из mnemonic.
          pair = await restoreFromMnemonic(mnemonic);
        }
        if (cancelled) return;
        setPendingPair(pair);
        setSeedWords(words);
        setStep('showSeed');
      } catch {
        // ignore — fallback: обычный welcome
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  const handleCreateNew = async (): Promise<void> => {
    setBusy(true);
    try {
      const { mnemonic, pair } = await generateMnemonicAndStore();
      setPendingPair(pair);
      setSeedWords(mnemonic.trim().split(/\s+/));
      setStep('showSeed');
    } catch (e) {
      Alert.alert('AirChat', userErrorText(e, 'Не удалось создать ключи. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Восстановление из зашифрованной копии. Ключи ставит importEncryptedBackup —
   * ровно тем же путём, что и восстановление по словам: внутри он и есть
   * расшифровка плюс restoreFromMnemonic.
   */
  const handleRestoreFromBackup = async (): Promise<void> => {
    if (!restorePwd) {
      Alert.alert('AirChat', 'Введите пароль, которым защищена копия.');
      return;
    }
    setBusy(true);
    try {
      await importEncryptedBackup(restoreText.trim(), restorePwd);
      const pair = await loadKeyPair();
      if (!pair) {
        // До сюда не дойти: импорт сохраняет ключи перед возвратом. Но молча
        // «восстановить» аккаунт без ключей нельзя — экран уйдёт, а войти
        // будет нечем.
        Alert.alert('AirChat', 'Копия принята, но ключи не сохранились. Попробуйте ещё раз.');
        return;
      }
      setRestorePwd('');
      await setFirstLaunchDone();
      await setSeedShown();
      await onComplete(pair);
    } catch (e) {
      Alert.alert('AirChat', userErrorText(e, 'Не удалось восстановить из копии. Проверьте пароль и текст копии.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (): Promise<void> => {
    if (isBackupPaste) {
      await handleRestoreFromBackup();
      return;
    }
    const trimmed = normalizeSeedInput(restoreText);
    const countCheck = checkSeedWordCount(trimmed);
    if (!countCheck.ok) {
      Alert.alert('AirChat', countCheck.message);
      return;
    }
    if (!validateMnemonic(trimmed)) {
      Alert.alert(
        'AirChat',
        'Неверные секретные слова. Проверьте правильность написания каждого слова.'
      );
      return;
    }
    setBusy(true);
    try {
      const pair = await restoreFromMnemonic(trimmed);
      if (cloudPwd && isCloudVaultConfigured()) {
        const cloudStatus = await restoreCloudVault(trimmed, cloudPwd);
        if (cloudStatus === 'not_found') {
          Alert.alert('AirChat', 'Локальный аккаунт восстановлен. Облачной копии для этой фразы пока нет.');
        }
      }
      await setFirstLaunchDone();
      await setSeedShown();
      await onComplete(pair);
    } catch (e) {
      Alert.alert('AirChat', userErrorText(e, 'Не удалось восстановить аккаунт или облачную копию. Проверьте фразу и облачный пароль.'));
    } finally {
      setBusy(false);
    }
  };

  const handleSeedConfirmed = async (): Promise<void> => {
    if (!pendingPair) {
      Alert.alert('AirChat', 'Внутренняя ошибка: нет ключей.');
      return;
    }
    setBusy(true);
    try {
      await setFirstLaunchDone();
      await setSeedShown();
      await onComplete(pendingPair);
    } catch (e) {
      Alert.alert('AirChat', userErrorText(e, 'Не удалось завершить настройку. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  };

  const handleWelcomeRestore = (): void => {
    setStep('restore');
  };

  const doWipeAndGoBack = useCallback(async (): Promise<void> => {
    // Важно: чистим реально сохранённые seed/флаги и ключи, иначе boot пропустит экран сидки.
    //
    // v4.32.340: порядок здесь не безразличен. Раньше первой стиралась фраза, и
    // сбой на втором шаге оставлял ключи без резервной копии — аккаунт живой, а
    // восстановить его нечем. В обратном порядке та же осечка безобидна: фраза
    // на месте, и welcome сам поднимет по ней ключи обратно.
    try {
      await deleteKeyPairFromStore();
      await wipeMnemonicAndSessionFlags();
    } catch (e) {
      // Молчать нельзя: человек нажал «Да, назад» и вправе знать, что не вышло.
      Alert.alert('AirChat', `Не удалось отменить создание аккаунта: ${
        rawErrorText(e)
      }`);
      return;
    }
    setPendingPair(null);
    setSeedWords([]);
    setStep('welcome');
  }, []);

  const handleBack = useCallback((): void => {
    if (step === 'showSeed') {
      Alert.alert(
        'Отменить создание аккаунта?',
        'Сгенерированные секретные слова будут сброшены. Вы сможете начать заново.',
        [
          { text: 'Нет', style: 'cancel' },
          {
            text: 'Да, назад',
            style: 'destructive',
            onPress: () => { void doWipeAndGoBack(); },
          },
        ]
      );
      return;
    }
    if (step === 'restore') {
      setRestoreText('');
      setStep('welcome');
    }
  }, [step, doWipeAndGoBack]);

  // Аппаратная «назад» на Android вела себя как выход из приложения: на экране
  // восстановления это теряло уже набранные слова, а на экране сидки — уводило
  // из приложения на полушаге, минуя вопрос о сбросе.
  useBackHandler(step === 'restore' || step === 'showSeed', handleBack);

  // ── useAsyncButton wrappers ──────────────────────────────────────────────────
  const createNewBtn = useAsyncButton(handleCreateNew, { throttleMs: 300 });
  const restoreBtn = useAsyncButton(handleRestore, { throttleMs: 300 });
  const seedConfirmedBtn = useAsyncButton(handleSeedConfirmed, { throttleMs: 300 });

  if (step === 'permissions') {
    return <PermissionsScreen onDone={() => setStep('welcome')} />;
  }

  if (step === 'welcome') {
    return (
      <SafeScreen>
      <View style={styles.center} testID="onboarding_welcome" collapsable={false}>
        <LoadingOverlay visible={busy} message="Генерация ключей…" />
        <Text style={styles.title}>AirChat</Text>
        <Text style={styles.sub}>
          Чат с защитой сообщений. Секретные слова (24 слова) — ваш ключ восстановления. Без них на новом
          устройстве восстановить доступ нельзя.
        </Text>
        <AppPressable
          style={styles.btn}
          onPress={createNewBtn.onPress}
          disabled={createNewBtn.loading}
          testID="btn_create_new"
        >
          <Text style={styles.btnText}>Создать новый аккаунт</Text>
        </AppPressable>
        <AppPressable
          style={styles.btnSecondary}
          onPress={handleWelcomeRestore}
          disabled={busy}
          testID="btn_restore"
        >
          {/* v4.32.376: копия — второй способ, и до этой версии её было некуда
              загрузить. Кнопка не должна обещать только один из двух. */}
          <Text style={styles.btnTextDark}>Восстановить аккаунт</Text>
        </AppPressable>
      </View>
      </SafeScreen>
    );
  }

  if (step === 'restore') {
    return (
      <SafeScreen>
        {/* v4.32.102 K.8: корневой KAV — на Android adjustResize уже работает, behavior=undefined чтобы избежать двойной компенсации */}
        <KeyboardAvoidingView
          style={styles.kav}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView
            contentContainerStyle={styles.restoreScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.restoreInner} testID="onboarding_restore">
              <LoadingOverlay visible={busy} message="Восстановление…" />
              <AppPressable
                style={styles.backRow}
                onPress={handleBack}
                hitSlop={12}
                testID="back_button"
                accessibilityRole="button"
                accessibilityLabel="Назад"
              >
                <Text style={styles.backChevron}>‹</Text>
                <Text style={styles.backText}>Назад</Text>
              </AppPressable>
              <Text style={styles.title}>Восстановление</Text>
              <Text style={styles.sub}>
                {isBackupPaste
                  ? 'Это зашифрованная резервная копия. Введите пароль, которым вы её защитили.'
                  : 'Секретные слова (24 слова), через пробел, в правильном порядке. Сюда же можно вставить зашифрованную резервную копию.'}
              </Text>
              <TextInput
                style={styles.textarea}
                multiline
                value={restoreText}
                onChangeText={setRestoreText}
                placeholder="слово1 слово2 …"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                // v4.32.340: поле, куда вводят 24 слова от аккаунта, было открыто
                // системному автозаполнению. Android по умолчанию считает любое
                // текстовое поле кандидатом и предлагает менеджеру паролей его
                // сохранить, а iOS — подставить из связки ключей; и то и другое
                // означает копию фразы за пределами приложения. Подсказки
                // клавиатуры уже отключены через autoCorrect, осталось закрыть
                // автозаполнение и словарь проверки орфографии.
                autoComplete="off"
                importantForAutofill="no"
                spellCheck={false}
                textContentType="none"
                textAlignVertical="top"
                testID="seed_input"
              />
      {isBackupPaste ? (
                <TextInput
                  style={styles.pwdInput}
                  value={restorePwd}
                  onChangeText={setRestorePwd}
                  placeholder="Пароль резервной копии"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  // Те же запреты, что и у поля со словами рядом: пароль от
                  // копии открывает ту же самую фразу.
                  autoComplete="off"
                  importantForAutofill="no"
                  spellCheck={false}
                  textContentType="none"
                  testID="backup_password_input"
                />
              ) : null}
              {!isBackupPaste ? (
                <>
                  <Text style={styles.encHint}>
                    Если у вас есть облачная копия, введите её дополнительный пароль. Он не сохраняется и нужен вместе с 24 словами.
                  </Text>
                  <TextInput
                    style={styles.pwdInput}
                    value={cloudPwd}
                    onChangeText={setCloudPwd}
                    placeholder="Дополнительный облачный пароль (необязательно)"
                    placeholderTextColor={colors.textMuted}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    importantForAutofill="no"
                    spellCheck={false}
                    textContentType="none"
                    testID="cloud_password_input"
                  />
                </>
              ) : null}
              <AppPressable
                style={styles.btn}
                onPress={restoreBtn.onPress}
                disabled={restoreBtn.loading}
                testID="btn_restore_confirm"
              >
                <Text style={styles.btnText}>Восстановить</Text>
              </AppPressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeScreen>
    );
  }

  if (step === 'showSeed') {
    return (
      <SafeScreen>
      <View style={styles.flex} testID="seed_phrase_screen">
        <LoadingOverlay visible={busy} message="Сохранение…" />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          testID="seed_scroll"
        >
          <AppPressable
            style={styles.backRow}
            onPress={handleBack}
            hitSlop={12}
            testID="back_button"
            accessibilityRole="button"
            accessibilityLabel="Назад"
          >
            <Text style={styles.backChevron}>‹</Text>
            <Text style={styles.backText}>Назад</Text>
          </AppPressable>
          <Text style={styles.warn}>
            Запишите 24 слова по порядку и храните в безопасном месте. Без них вы не сможете восстановить аккаунт.
          </Text>
          <Text style={styles.encHint}>
            Копия на этом устройстве уже сохранена в зашифрованном виде. После подтверждения можно пользоваться
            приложением — вводить слова снова не понадобится.
          </Text>
          <View style={styles.grid} testID="seed_words">
            {seedWords.map((word, i) => (
              <Text key={`${i}-${word}`} style={styles.word}>
                {i + 1}. {word}
              </Text>
            ))}
          </View>
          <AppPressable
            style={styles.btn}
            onPress={seedConfirmedBtn.onPress}
            disabled={seedConfirmedBtn.loading}
            testID="btn_seed_confirmed"
            accessibilityLabel="Я сохранил секретные слова"
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>Я сохранил секретные слова</Text>
          </AppPressable>
        </ScrollView>
      </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen>
    <View style={styles.center}>
      <Text style={styles.sub}>Загрузка…</Text>
    </View>
    </SafeScreen>
  );
}
