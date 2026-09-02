import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Vibration,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { Ionicons } from '@expo/vector-icons';
import { AUTH_MAX_ATTEMPTS, authGuard } from '../../core/security/authGuard';
import { SafeScreen } from '../components/SafeScreen';
import { showError } from '../components/userFeedback';
import { useColors, useThemedStyles } from '../ThemeContext';
import { AirChatWordmark } from '../components/AirChatWordmark';
import { primaryInk, radius } from '../theme';
import {
  PIN_BACKSPACE,
  PIN_LENGTH,
  applyPinKey,
  attemptsHint,
  isPinComplete,
  lockoutDeadline,
  lockoutMinutesLeft,
} from '../utils/lockScreen';

type Props = {
  onSuccess: () => void;
  onForgot: () => void;
};

const PIN_DIGITS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', PIN_BACKSPACE],
];

/** Задержка перед авто-проверкой набранного PIN — заодно окно на «стереть». */
const PIN_AUTOSUBMIT_DELAY_MS = 50;

function PinPad({
  pin,
  onKey,
  disabled,
}: {
  pin: string;
  onKey: (key: string) => void;
  disabled: boolean;
}): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    container: { alignItems: 'center' as const, paddingVertical: 8 },
    dotsRow: { flexDirection: 'row' as const, gap: 16, marginBottom: 32 },
    dot: { width: 14, height: 14, borderRadius: 7 },
    dotFilled: { backgroundColor: c.primary },
    dotEmpty: { backgroundColor: c.border, borderWidth: 1, borderColor: c.textMuted },
    row: { flexDirection: 'row' as const, gap: 20, marginBottom: 12 },
    btn: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: c.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    emptyBtn: { width: 72, height: 72 },
    btnPressed: { backgroundColor: c.surfaceHigh },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: c.text, fontSize: 24, fontWeight: '400' as const },
  }));

  return (
    <View style={styles.container}>
      {/* Точки */}
      <View
        style={styles.dotsRow}
        accessible
        accessibilityLabel={`Введено цифр: ${pin.length} из ${PIN_LENGTH}`}
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <View
            key={i}
            style={[styles.dot, i < pin.length ? styles.dotFilled : styles.dotEmpty]}
          />
        ))}
      </View>
      {/* Клавиатура */}
      {PIN_DIGITS.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {row.map((key) => {
            if (!key) return <View key="empty" style={styles.emptyBtn} />;
            return (
              <AppPressable
                key={key}
                style={({ pressed }) => [
                  styles.btn,
                  pressed && styles.btnPressed,
                  disabled && styles.btnDisabled,
                ]}
                onPress={() => onKey(key)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={key === PIN_BACKSPACE ? 'Стереть' : key}
              >
                {key === PIN_BACKSPACE ? (
                  <Ionicons name="backspace-outline" size={24} color={colors.text} />
                ) : (
                  <Text style={styles.btnText}>{key}</Text>
                )}
              </AppPressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function PasswordScreen({ onSuccess, onForgot }: Props): React.ReactElement {
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [usePinMode, setUsePinMode] = useState(true);
  const [loading, setLoading] = useState(false);
  const [remainingAttempts, setRemainingAttempts] = useState(AUTH_MAX_ATTEMPTS);
  const [lockoutMs, setLockoutMs] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  /**
   * Проверка уже идёт. Ref, а не состояние `loading`: он выставляется
   * синхронно, до перерисовки, — а именно в этом промежутке и успевала
   * проскочить вторая отправка (v4.32.326).
   */
  const submittingRef = useRef(false);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    flex: { flex: 1 },
    container: {
      flex: 1,
      justifyContent: 'center' as const,
      padding: 20,
      backgroundColor: c.background,
    },
    /** Знак стоит вместо заголовка, поэтому и отступ снизу у него заголовочный. */
    wordmark: {
      marginBottom: 8,
      alignSelf: 'center' as const,
    },
    title: {
      fontSize: 24,
      fontWeight: '700' as const,
      marginBottom: 8,
      textAlign: 'center' as const,
      color: c.text,
    },
    hint: {
      fontSize: 13,
      color: c.textMuted,
      textAlign: 'center' as const,
      marginBottom: 24,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 14,
      fontSize: 16,
      marginBottom: 16,
      color: c.text,
      backgroundColor: c.surface,
    },
    button: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
    },
    buttonDisabled: { opacity: 0.7 },
    buttonText: { color: primaryInk(c).text, fontSize: 16, fontWeight: '600' as const },
    forgotWrap: { marginTop: 20, alignItems: 'center' as const },
    forgotLink: { color: c.accent, fontSize: 16 },
    forgotLinkSmall: { color: c.accent, fontSize: 13 },
    attemptsText: {
      marginTop: 16,
      textAlign: 'center' as const,
      color: c.error,
      fontSize: 13,
    },
    message: {
      textAlign: 'center' as const,
      marginBottom: 24,
      color: c.textSecondary,
      lineHeight: 22,
    },
    spinner: { marginTop: 16 },
    shakeWrap: { width: '100%' as const },
  }));

  /**
   * Перечитать счётчик и блокировку. Возвращает прочитанное, чтобы вызывающему
   * не пришлось спрашивать хранилище второй раз ради тех же двух чисел.
   */
  const refreshStatus = useCallback(async (): Promise<{ remaining: number; lockout: number }> => {
    const remaining = await authGuard.getRemainingAttempts();
    const lockout = await authGuard.getLockoutTimeRemaining();
    setRemainingAttempts(remaining);
    setLockoutMs(lockout);
    setLockoutUntil(lockoutDeadline(lockout, Date.now()));
    return { remaining, lockout };
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /**
   * Обратный отсчёт блокировки.
   *
   * v4.32.326: считается от момента окончания, а хранилище спрашивается один
   * раз — когда срок вышел. Раньше каждую секунду перечитывались и счётчик
   * попыток, и отметка времени: четыре обращения к Keystore в секунду на
   * пятнадцать минут, в одной очереди с ключом шифрования базы. Заодно
   * отсчёт от момента окончания переживает сон телефона, при котором таймеры
   * не идут, — вычитание по секунде показывало бы неправду.
   */
  useEffect(() => {
    if (lockoutUntil <= 0) return;
    const t = setInterval(() => {
      const left = lockoutUntil - Date.now();
      setLockoutMs(Math.max(0, left));
      if (left <= 0) {
        setLockoutUntil(0);
        void refreshStatus();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [lockoutUntil, refreshStatus]);

  const shake = useCallback(() => {
    Vibration.vibrate(200);
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const submitValue = useCallback(
    async (value: string): Promise<void> => {
      if (!value) {
        showError('Введите пароль');
        return;
      }
      // v4.32.326: пока проверка идёт, вторая отправка того же значения просто
      // списала бы ещё одну попытку из пяти.
      if (submittingRef.current) return;
      submittingRef.current = true;
      setLoading(true);
      try {
        if (await authGuard.checkPassword(value)) {
          onSuccess();
          return;
        }
        setPin('');
        setPassword('');
        shake();
        const { remaining, lockout } = await refreshStatus();
        if (lockout > 0) {
          showError(`Слишком много попыток. Попробуйте через ${lockoutMinutesLeft(lockout)} мин.`);
        } else {
          showError(`Неверный пароль. Осталось попыток: ${remaining}`);
        }
      } finally {
        submittingRef.current = false;
        setLoading(false);
      }
    },
    [onSuccess, refreshStatus, shake]
  );

  const handlePinKey = useCallback((key: string) => {
    if (submittingRef.current) return;
    setPin((p) => applyPinKey(p, key));
  }, []);

  /**
   * Авто-проверка набранного PIN.
   *
   * v4.32.326: отдельным эффектом, а не отправкой изнутри обновления состояния.
   * React вправе выполнить функцию-обновление дважды, и тогда планировались две
   * проверки одного и того же кода — две списанные попытки из пяти за одно
   * нажатие. Вторая польза: если сразу после шестой цифры нажать «стереть»,
   * эффект отменит отправку прежнего кода — раньше исправление опечатки само
   * стоило попытки.
   */
  useEffect(() => {
    if (!usePinMode || !isPinComplete(pin)) return;
    const t = setTimeout(() => {
      void submitValue(pin);
    }, PIN_AUTOSUBMIT_DELAY_MS);
    return () => clearTimeout(t);
  }, [pin, usePinMode, submitValue]);

  if (lockoutMs > 0) {
    return (
      <SafeScreen edges={['top', 'bottom']} backgroundColor={colors.background}>
        <View style={styles.container}>
          <Text style={styles.title}>Доступ заблокирован</Text>
          <Text style={styles.message}>
            Слишком много неудачных попыток. Попробуйте через {lockoutMinutesLeft(lockoutMs)} мин.
            или восстановите доступ.
          </Text>
          <AppPressable style={styles.button} onPress={onForgot} accessibilityRole="button">
            <Text style={styles.buttonText}>Восстановить по секретным словам</Text>
          </AppPressable>
        </View>
      </SafeScreen>
    );
  }

  const attempts = attemptsHint(remainingAttempts, AUTH_MAX_ATTEMPTS);

  return (
    <SafeScreen edges={['top', 'bottom']} backgroundColor={colors.background}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.container}>
          <AirChatWordmark height={24} style={styles.wordmark} />
          <Text style={styles.hint}>
            {usePinMode ? `Введите PIN-код (${PIN_LENGTH} цифр)` : 'Введите пароль'}
          </Text>

          <Animated.View style={[styles.shakeWrap, { transform: [{ translateX: shakeAnim }] }]}>
            {usePinMode ? (
              <PinPad pin={pin} onKey={handlePinKey} disabled={loading} />
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Пароль"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  value={password}
                  onChangeText={setPassword}
                  // v4.32.326: без trim. Пароль сохраняется ровно таким, каким
                  // его набрали в настройках, — а здесь у него молча снимались
                  // пробелы по краям. Пароль с пробелом было не ввести вовсе:
                  // пять попыток, пятнадцать минут, и так до сброса по словам.
                  onSubmitEditing={() => void submitValue(password)}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="app_password_input"
                />
                <AppPressable
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={() => void submitValue(password)}
                  disabled={loading}
                  accessibilityRole="button"
                  testID="app_password_submit"
                >
                  {loading ? (
                    <ActivityIndicator color={primaryInk(colors).text} />
                  ) : (
                    <Text style={styles.buttonText}>Войти</Text>
                  )}
                </AppPressable>
              </>
            )}
          </Animated.View>

          <AppPressable
            onPress={() => setUsePinMode((v) => !v)}
            style={styles.forgotWrap}
            accessibilityRole="button"
          >
            <Text style={styles.forgotLink}>
              {usePinMode ? 'Ввести текстовый пароль' : 'Ввести PIN-код'}
            </Text>
          </AppPressable>
          <AppPressable
            onPress={onForgot}
            style={styles.forgotWrap}
            accessibilityRole="button"
            testID="app_password_forgot"
          >
            <Text style={styles.forgotLinkSmall}>Забыли пароль?</Text>
          </AppPressable>
          {attempts ? <Text style={styles.attemptsText}>{attempts}</Text> : null}
          {loading ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}
