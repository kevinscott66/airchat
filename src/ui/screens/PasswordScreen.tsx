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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppPressable } from '../components/AppPressable';
import { AUTH_MAX_ATTEMPTS, authGuard } from '../../core/security/authGuard';
import { isBiometricUnlockEnabled, readBiometricPassword } from '../../core/security/biometricUnlock';
import { SafeScreen } from '../components/SafeScreen';
import { AuthBackdrop } from '../components/AuthBackdrop';
import { GlassSurface } from '../components/GlassSurface';
import { PinPad } from '../components/PinPad';
import { showError } from '../components/userFeedback';
import { useColors, useThemedStyles } from '../ThemeContext';
import { AirChatLockup } from '../components/AirChatLockup';
import { font, primaryInk, radius, spacing } from '../theme';
import {
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

/** Задержка перед авто-проверкой набранного PIN — заодно окно на «стереть». */
const PIN_AUTOSUBMIT_DELAY_MS = 50;

/** Подпись замка, когда открывают лицом, а не кодом. */
const BIOMETRIC_HINT = Platform.OS === 'ios' ? 'Вход по Face ID' : 'Вход по отпечатку';

/** Знак лица — во весь круг: он здесь вместо клавиатуры, а не значок при ней. */
const FACE_GLYPH = 92;
const FACE_CIRCLE = 156;

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
  const [biometricReady, setBiometricReady] = useState(false);
  /**
   * Чем замок открывают прямо сейчас.
   *
   * v4.32.598: пока Face ID работает, клавиатуры на экране нет. Лицо и шесть
   * цифр — два разных способа войти, и показывать оба разом значит звать
   * набирать код там, где набирать нечего: человек смотрит в экран, а под
   * системным запросом уже нарисованы клавиши. Поэтому `face` — это знак лица
   * на месте клавиатуры, и клавиатура встаёт туда, только когда Face ID
   * отказал, был отменён или его не включали.
   *
   * `checking` — те доли секунды, пока признак читается из хранилища (очередь
   * к Keystore на запуске не пустая). Показать за это время клавиатуру значило
   * бы моргнуть ею и убрать.
   */
  const [unlockBy, setUnlockBy] = useState<'checking' | 'face' | 'pin'>('checking');
  /**
   * Запрос Face ID уже был. Ровно один автоматический на открытие экрана:
   * отмена запроса не должна тут же вызывать его снова — из такой петли
   * человеку было бы не выйти к клавиатуре.
   */
  const biometricAskedRef = useRef(false);

  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    flex: { flex: 1 },
    container: {
      flex: 1,
      justifyContent: 'center' as const,
      padding: spacing.lg,
    },
    /** Знак стоит вместо заголовка, поэтому и отступ снизу у него заголовочный. */
    lockup: {
      marginBottom: spacing.sm,
      alignSelf: 'center' as const,
    },
    title: {
      fontSize: font.xxl,
      fontWeight: '700' as const,
      marginBottom: spacing.sm,
      textAlign: 'center' as const,
      color: c.text,
    },
    hint: {
      fontSize: font.sm,
      color: c.textMuted,
      textAlign: 'center' as const,
      marginBottom: spacing.xl,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      fontSize: font.lg,
      marginBottom: spacing.lg,
      color: c.text,
      backgroundColor: c.surface,
    },
    button: {
      backgroundColor: c.primary,
      padding: spacing.md,
      borderRadius: radius.md,
      alignItems: 'center' as const,
    },
    buttonDisabled: { opacity: 0.7 },
    buttonText: { color: primaryInk(c).text, fontSize: font.lg, fontWeight: '600' as const },
    forgotWrap: { marginTop: spacing.lg, alignItems: 'center' as const },
    forgotLink: { color: c.accent, fontSize: font.md },
    forgotLinkSmall: { color: c.accent, fontSize: font.sm },
    attemptsText: {
      marginTop: spacing.lg,
      textAlign: 'center' as const,
      color: c.error,
      fontSize: font.sm,
    },
    message: {
      textAlign: 'center' as const,
      marginBottom: spacing.xl,
      color: c.textSecondary,
      lineHeight: font.xxl,
    },
    spinner: { marginTop: spacing.lg },
    shakeWrap: { width: '100%' as const },
    faceWrap: { alignItems: 'center' as const },
    facePress: { borderRadius: radius.full },
    faceCircle: {
      width: FACE_CIRCLE,
      height: FACE_CIRCLE,
      borderRadius: radius.full,
      overflow: 'hidden' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    facePressed: { opacity: 0.7 },
    faceCaption: {
      marginTop: spacing.lg,
      textAlign: 'center' as const,
      color: c.textMuted,
      fontSize: font.sm,
    },
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
    async (value: string): Promise<boolean> => {
      if (!value) {
        showError('Введите пароль');
        return false;
      }
      // v4.32.326: пока проверка идёт, вторая отправка того же значения просто
      // списала бы ещё одну попытку из пяти.
      if (submittingRef.current) return false;
      submittingRef.current = true;
      setLoading(true);
      try {
        if (await authGuard.checkPassword(value)) {
          onSuccess();
          return true;
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
        return false;
      } finally {
        submittingRef.current = false;
        setLoading(false);
      }
    },
    [onSuccess, refreshStatus, shake]
  );

  /**
   * Разблокировать по Face ID.
   *
   * Под биометрией лежит сам пароль, и дальше он идёт обычным путём — через
   * `checkPassword` с теми же пятью попытками. Отдельной двери в приложение
   * Face ID не открывает: он только избавляет от набора.
   */
  const handleBiometric = useCallback(async (): Promise<boolean> => {
    if (submittingRef.current) return false;
    const stored = await readBiometricPassword();
    // Отказ или отмена — молча: на месте лица встанет клавиатура, код наберут сами.
    if (!stored) return false;
    return submitValue(stored);
  }, [submitValue]);

  /**
   * Всегда свежий `handleBiometric` — но не в зависимостях эффекта.
   *
   * v4.32.599: `onSuccess` приходит из `App` новой стрелкой на каждую его
   * перерисовку, и через `submitValue` эта новизна доходила до эффекта ниже.
   * Эффект перезапускался прямо посреди проверки пароля, видел, что запрос уже
   * был, и ставил клавиатуру — поверх удавшегося Face ID, пока крутится
   * ожидание. Заодно каждый такой перезапуск заново спрашивал у хранилища
   * признак биометрии.
   */
  const handleBiometricRef = useRef(handleBiometric);
  useEffect(() => {
    handleBiometricRef.current = handleBiometric;
  });

  // Ровно один раз на открытие экрана — отсюда и пустые зависимости.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enabled = await isBiometricUnlockEnabled();
      if (cancelled) return;
      setBiometricReady(enabled);
      if (!enabled) {
        setUnlockBy('pin');
        return;
      }
      if (biometricAskedRef.current) {
        // Повторный проход (в разработке React дёргает эффект дважды): запрос
        // уже был, второй раз лицо не спрашиваем и вид не трогаем.
        setUnlockBy((v) => (v === 'checking' ? 'pin' : v));
        return;
      }
      biometricAskedRef.current = true;
      setUnlockBy('face');
      const opened = await handleBiometricRef.current();
      // Открылось — экран сейчас снимут, менять на нём нечего. Нет — за знаком
      // лица встаёт клавиатура.
      if (!cancelled && !opened) setUnlockBy('pin');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        <AuthBackdrop />
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
  const hint =
    unlockBy === 'face' ? BIOMETRIC_HINT
      : usePinMode ? `Введите PIN-код (${PIN_LENGTH} цифр)`
        : 'Введите пароль';

  return (
    <SafeScreen edges={['top', 'bottom']} backgroundColor={colors.background}>
      <AuthBackdrop />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.container}>
          <AirChatLockup height={30} style={styles.lockup} />
          {unlockBy === 'checking' ? (
            <ActivityIndicator style={styles.spinner} color={colors.accent} />
          ) : (
            <>
              <Text style={styles.hint}>{hint}</Text>

              <Animated.View style={[styles.shakeWrap, { transform: [{ translateX: shakeAnim }] }]}>
                {unlockBy === 'face' ? (
                  <View style={styles.faceWrap}>
                    <AppPressable
                      onPress={() => void handleBiometric()}
                      style={({ pressed }) => [styles.facePress, pressed && styles.facePressed]}
                      disabled={loading}
                      accessibilityRole="button"
                      accessibilityLabel={BIOMETRIC_HINT}
                      testID="app_password_face"
                    >
                      <GlassSurface variant="regular" rim style={styles.faceCircle}>
                        <MaterialCommunityIcons
                          name={Platform.OS === 'ios' ? 'face-recognition' : 'fingerprint'}
                          size={FACE_GLYPH}
                          color={colors.accent}
                        />
                      </GlassSurface>
                    </AppPressable>
                    <Text style={styles.faceCaption}>Нажмите, если запрос не появился</Text>
                  </View>
                ) : usePinMode ? (
                  <PinPad
                    pin={pin}
                    length={PIN_LENGTH}
                    onKey={handlePinKey}
                    disabled={loading}
                    onBiometric={biometricReady ? () => void handleBiometric() : undefined}
                  />
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

              {unlockBy === 'face' ? (
                <AppPressable
                  onPress={() => setUnlockBy('pin')}
                  style={styles.forgotWrap}
                  accessibilityRole="button"
                  testID="app_password_use_pin"
                >
                  <Text style={styles.forgotLink}>Ввести код</Text>
                </AppPressable>
              ) : (
                <AppPressable
                  onPress={() => setUsePinMode((v) => !v)}
                  style={styles.forgotWrap}
                  accessibilityRole="button"
                >
                  <Text style={styles.forgotLink}>
                    {usePinMode ? 'Ввести текстовый пароль' : 'Ввести PIN-код'}
                  </Text>
                </AppPressable>
              )}
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
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}
