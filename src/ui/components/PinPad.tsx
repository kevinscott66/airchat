/**
 * Ввод PIN-кода: точки и стеклянная клавиатура (v4.32.595).
 *
 * Раньше эта клавиатура жила внутри `PasswordScreen` и была единственной на
 * всё приложение: везде, где пароль спрашивали ещё раз — снять замок с
 * «Резервной копии», показать секретные слова, задать или сменить пароль,
 * отправить облачную копию, — стояло обычное текстовое поле. Пароль один
 * (см. `passwordPolicy`), а вводился он пятью разными способами; здесь он
 * вводится одним.
 *
 * Стекло — одной панелью на всю клавиатуру, а не по стеклу на клавишу. Двенадцать
 * отдельных размытий это двенадцать слоёв на кадр и, что важнее, двенадцать
 * мелких пятен вместо одной поверхности: язык приложения — одна стеклянная
 * панель на плоскость (см. `GlassSurface`). Клавиши внутри панели — заливка
 * прозрачностью от текста, то есть они темнеют на светлой теме и светлеют на
 * тёмной, не заводя собственных цветов.
 */
import React from 'react';
import { View, Text, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { GlassSurface } from './GlassSurface';
import { useColors, useThemedStyles } from '../ThemeContext';
import { font, radius, spacing, withAlpha } from '../theme';
import { PIN_BACKSPACE } from '../utils/lockScreen';

/** Место под Face ID в нижнем левом углу — там, где на клавиатуре пусто. */
export const PIN_BIOMETRIC = '⌘';

const PIN_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', PIN_BACKSPACE],
];

type Props = {
  pin: string;
  length: number;
  onKey: (key: string) => void;
  disabled?: boolean;
  /** Компактный размер — для клавиатуры внутри окна поверх экрана. */
  compact?: boolean;
  /** Показать клавишу Face ID слева внизу. */
  onBiometric?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function PinPad({
  pin,
  length,
  onKey,
  disabled = false,
  compact = false,
  onBiometric,
  style,
}: Props): React.ReactElement {
  const colors = useColors();
  const size = compact ? 58 : 70;
  const gap = compact ? spacing.md : spacing.lg;
  const glyph = compact ? 22 : 24;

  const styles = useThemedStyles((c) => ({
    wrap: { alignItems: 'center' as const },
    dotsRow: { flexDirection: 'row' as const, gap: spacing.lg, marginBottom: spacing.xl },
    dot: { width: 12, height: 12, borderRadius: radius.full },
    dotFilled: { backgroundColor: c.primary },
    dotEmpty: { backgroundColor: withAlpha(c.text, 0.1), borderWidth: 1, borderColor: c.border },
    panel: {
      borderRadius: radius.xl,
      overflow: 'hidden' as const,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },
    row: { flexDirection: 'row' as const },
    key: {
      borderRadius: radius.full,
      backgroundColor: withAlpha(c.text, 0.06),
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    keyPressed: { backgroundColor: withAlpha(c.text, 0.16) },
    keyBare: { backgroundColor: 'transparent' },
    keyDisabled: { opacity: 0.4 },
    keyText: { color: c.text, fontSize: font.xxl, fontWeight: '400' as const },
  }));

  const keyStyle = { width: size, height: size };

  return (
    <View style={[styles.wrap, style]}>
      <View
        style={styles.dotsRow}
        accessible
        accessibilityLabel={`Введено цифр: ${pin.length} из ${length}`}
      >
        {Array.from({ length }).map((_, i) => (
          <View key={i} style={[styles.dot, i < pin.length ? styles.dotFilled : styles.dotEmpty]} />
        ))}
      </View>

      <GlassSurface variant="regular" rim style={styles.panel}>
        {PIN_ROWS.map((row, ri) => (
          <View key={ri} style={[styles.row, { gap }, ri > 0 && { marginTop: gap }]}>
            {row.map((key, ki) => {
              // Пустое место слева внизу занимает Face ID, если он включён.
              const slot = key === '' && onBiometric ? PIN_BIOMETRIC : key;
              if (!slot) return <View key={`gap-${ki}`} style={keyStyle} />;
              const bare = slot !== PIN_BACKSPACE && slot !== PIN_BIOMETRIC ? null : true;
              return (
                <AppPressable
                  key={slot}
                  style={({ pressed }) => [
                    styles.key,
                    keyStyle,
                    bare && styles.keyBare,
                    pressed && styles.keyPressed,
                    disabled && styles.keyDisabled,
                  ]}
                  onPress={() => (slot === PIN_BIOMETRIC ? onBiometric?.() : onKey(slot))}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={
                    slot === PIN_BACKSPACE ? 'Стереть'
                      : slot === PIN_BIOMETRIC ? 'Войти по биометрии'
                        : slot
                  }
                  testID={`pin_key_${slot === PIN_BACKSPACE ? 'back' : slot === PIN_BIOMETRIC ? 'bio' : slot}`}
                >
                  {slot === PIN_BACKSPACE ? (
                    <Ionicons name="backspace-outline" size={glyph} color={colors.text} />
                  ) : slot === PIN_BIOMETRIC ? (
                    <Ionicons
                      name={Platform.OS === 'ios' ? 'scan-outline' : 'finger-print-outline'}
                      size={glyph}
                      color={colors.accent}
                    />
                  ) : (
                    <Text style={styles.keyText}>{slot}</Text>
                  )}
                </AppPressable>
              );
            })}
          </View>
        ))}
      </GlassSurface>
    </View>
  );
}
