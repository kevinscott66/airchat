/**
 * SeedVerifyForm — проверка, что секретные слова действительно записаны.
 *
 * AC-21. Раньше «Я сохранил секретные слова» сразу пускало в приложение, и
 * человек, не записавший слова, узнавал об этом, только потеряв телефон.
 * Теперь спрашиваем три случайных слова по номеру. Неверный ответ дальше не
 * пускает, но к словам можно вернуться; «Сделаю позже» — честный выход для
 * того, у кого сейчас нет бумаги: приложение запомнит и напомнит.
 *
 * Слова в форму приходят пропсом и никуда отсюда не уходят: ни в журнал, ни в
 * колбэки — наружу сообщается только исход. Поля — под тем же щитом от снимка
 * экрана, что и сами слова, и закрыты от автозаполнения и словаря клавиатуры.
 * Номера выбираются при монтировании: вернулся к словам и пришёл снова —
 * спросим другие.
 */
import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { useColors, useThemedStyles } from '../ThemeContext';
import { authCardRim, font, primaryInk, radius } from '../theme';
import { checkVerifyAnswers, pickVerifyIndices } from '../screens/seedVerify';
import { AppPressable } from './AppPressable';
import { SecretScreenGuard } from './SecretScreenGuard';

export const SEED_VERIFY_MISMATCH_TEXT =
  'Слова не совпадают с записью. Проверьте номера или вернитесь к словам.';

type Props = {
  words: readonly string[];
  /** Все ответы верны. */
  onVerified: () => void | Promise<void>;
  /** Неверный ответ (для события в журнале — без слов). */
  onMismatch?: () => void;
  /** «Назад к словам». */
  onBack: () => void;
  /** «Сделаю позже»; без него кнопки нет. */
  onDefer?: () => void | Promise<void>;
  busy?: boolean;
};

export function SeedVerifyForm({
  words,
  onVerified,
  onMismatch,
  onBack,
  onDefer,
  busy = false,
}: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    hint: { color: c.textSecondary, marginBottom: 16, lineHeight: 20 },
    fieldLabel: {
      fontSize: font.sm,
      fontWeight: '600' as const,
      color: c.textSecondary,
      marginBottom: 6,
    },
    input: {
      borderWidth: 1,
      borderColor: authCardRim(c),
      borderRadius: radius.md,
      padding: 12,
      color: c.text,
      backgroundColor: c.surface,
      marginBottom: 12,
    },
    error: { color: c.error, marginBottom: 12, lineHeight: 20, fontWeight: '600' as const },
    btn: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
      marginTop: 4,
      marginBottom: 12,
    },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: primaryInk(c).text, fontWeight: '600' as const },
    linkBtn: { alignSelf: 'center' as const, paddingVertical: 8, marginBottom: 4 },
    linkText: { color: c.accent, fontWeight: '600' as const },
    laterText: { color: c.textSecondary, fontWeight: '600' as const },
  }));

  const [indices] = useState(() => pickVerifyIndices(words.length));
  const [answers, setAnswers] = useState<string[]>(() => indices.map(() => ''));
  const [mismatch, setMismatch] = useState(false);

  const filled = answers.every((a) => a.trim().length > 0);
  const canSubmit = filled && !busy;

  const setAnswer = (i: number, text: string): void => {
    setAnswers((prev) => prev.map((a, j) => (j === i ? text : a)));
    if (mismatch) setMismatch(false);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    if (!checkVerifyAnswers(words, indices, answers)) {
      setMismatch(true);
      onMismatch?.();
      return;
    }
    await onVerified();
  };

  return (
    <View testID="seed_verify">
      <Text style={styles.hint}>
        Проверим запись: введите слова под этими номерами — так, как они записаны у вас.
      </Text>
      <SecretScreenGuard testID="seed_verify_guard">
        {indices.map((wordIndex, i) => {
          const labelId = `seed_verify_label_${i}`;
          const label = `Слово №${wordIndex + 1}`;
          return (
            <View key={wordIndex}>
              <Text style={styles.fieldLabel} nativeID={labelId}>
                {label}
              </Text>
              <TextInput
                style={styles.input}
                value={answers[i]}
                onChangeText={(t) => setAnswer(i, t)}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                // Те же запреты, что у поля ввода 24 слов при восстановлении:
                // иначе слово уходит в подсказки клавиатуры и в менеджер паролей.
                autoComplete="off"
                importantForAutofill="no"
                spellCheck={false}
                textContentType="none"
                editable={!busy}
                returnKeyType={i === indices.length - 1 ? 'done' : 'next'}
                onSubmitEditing={i === indices.length - 1 ? () => { void submit(); } : undefined}
                testID={`seed_verify_input_${i}`}
                accessibilityLabel={label}
                accessibilityLabelledBy={labelId}
              />
            </View>
          );
        })}
      </SecretScreenGuard>
      {mismatch ? (
        <Text style={styles.error} testID="seed_verify_error" accessibilityLiveRegion="polite">
          {SEED_VERIFY_MISMATCH_TEXT}
        </Text>
      ) : null}
      <AppPressable
        style={[styles.btn, !canSubmit && styles.btnDisabled]}
        onPress={() => { void submit(); }}
        disabled={!canSubmit}
        testID="btn_seed_verify"
        accessibilityRole="button"
        accessibilityLabel="Проверить"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <Text style={styles.btnText}>Проверить</Text>
      </AppPressable>
      <AppPressable
        style={styles.linkBtn}
        onPress={onBack}
        disabled={busy}
        testID="btn_seed_verify_back"
        accessibilityRole="button"
        accessibilityLabel="Назад к словам"
      >
        <Text style={styles.linkText}>Назад к словам</Text>
      </AppPressable>
      {onDefer ? (
        <AppPressable
          style={styles.linkBtn}
          onPress={() => { void onDefer(); }}
          disabled={busy}
          testID="btn_seed_verify_later"
          accessibilityRole="button"
          accessibilityLabel="Сделаю позже"
        >
          <Text style={styles.laterText}>Сделаю позже</Text>
        </AppPressable>
      ) : null}
    </View>
  );
}
