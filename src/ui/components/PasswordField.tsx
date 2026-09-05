/**
 * Поле ввода пароля приложения (v4.32.595).
 *
 * Пароль в приложении один (см. `passwordPolicy`), а спрашивают его в пяти
 * местах, и до этой версии каждое спрашивало по-своему: экран блокировки —
 * клавиатурой из цифр, настройки — обычным текстовым полем. Здесь оба способа
 * лежат в одном компоненте, и переключение между ними — дело человека, а не
 * того, в каком окне он оказался.
 *
 * Цифровой режим — основной: шесть цифр набираются одной рукой и не поднимают
 * системную клавиатуру поверх окна. Текстовый нужен тем, у кого пароль со
 * словами; спрятать его было бы нельзя — такой человек просто не вошёл бы.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, type StyleProp, type ViewStyle } from 'react-native';
import { AppPressable } from './AppPressable';
import { PinPad } from './PinPad';
import { useColors, useThemedStyles } from '../ThemeContext';
import { font, radius, spacing } from '../theme';
import { PIN_LENGTH, applyPinKey, isPinComplete } from '../utils/lockScreen';

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Набраны все цифры — можно проверять, не дожидаясь нажатия кнопки. */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Клавиша Face ID слева внизу; без неё там пусто. */
  onBiometric?: () => void;
  autoFocus?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function PasswordField({
  value,
  onChange,
  onComplete,
  disabled = false,
  placeholder = 'Пароль',
  onBiometric,
  autoFocus = false,
  testID,
  style,
}: Props): React.ReactElement {
  const [pinMode, setPinMode] = useState(true);
  const colors = useColors();
  /**
   * Значение, о котором уже сообщили. Без него `onComplete` срабатывал бы на
   * каждой перерисовке с полным кодом — то есть по нескольку раз на один набор,
   * а каждая проверка списывает попытку из пяти.
   */
  const reportedRef = useRef<string | null>(null);

  const styles = useThemedStyles((c) => ({
    wrap: { alignItems: 'stretch' as const },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: font.lg,
      color: c.text,
      backgroundColor: c.surface,
    },
    toggle: { marginTop: spacing.sm, alignSelf: 'center' as const },
    toggleText: { color: c.accent, fontSize: font.sm },
  }));

  const handleKey = useCallback(
    (key: string) => {
      if (disabled) return;
      onChange(applyPinKey(value, key));
    },
    [disabled, onChange, value],
  );

  useEffect(() => {
    if (!pinMode || !onComplete) return;
    if (!isPinComplete(value)) {
      // Стёрли цифру — набор снова считается незавершённым.
      if (reportedRef.current !== null) reportedRef.current = null;
      return;
    }
    if (reportedRef.current === value) return;
    reportedRef.current = value;
    onComplete(value);
  }, [pinMode, value, onComplete]);

  const toggle = useCallback(() => {
    setPinMode((v) => !v);
    reportedRef.current = null;
    onChange('');
  }, [onChange]);

  return (
    <View style={[styles.wrap, style]}>
      {pinMode ? (
        <PinPad
          pin={value}
          length={PIN_LENGTH}
          onKey={handleKey}
          disabled={disabled}
          compact
          onBiometric={onBiometric}
        />
      ) : (
        <TextInput
          style={styles.input}
          secureTextEntry
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          textContentType="none"
          editable={!disabled}
          autoFocus={autoFocus}
          testID={testID}
        />
      )}
      <AppPressable onPress={toggle} style={styles.toggle} accessibilityRole="button">
        <Text style={styles.toggleText}>
          {pinMode ? 'Ввести текстовый пароль' : `Ввести код из ${PIN_LENGTH} цифр`}
        </Text>
      </AppPressable>
    </View>
  );
}
