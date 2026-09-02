import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { KeyboardHost } from '../../KeyboardHost';
import { useTheme } from '../../../ThemeContext';
import { font, primaryInk, radius, scrim } from '../../../theme';

// ─────────────────────────────────────────────────────────────────────────────
// PollCreatorModal
// ─────────────────────────────────────────────────────────────────────────────

export function PollCreatorModal({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], correctAnswer?: number, anonymous?: boolean, allowMultiple?: boolean) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [isQuiz, setIsQuiz] = useState(false);
  const [correctAnswer, setCorrectAnswer] = useState<number>(0);
  const [anonymous, setAnonymous] = useState(false);
  const [allowMultiple, setAllowMultiple] = useState(false);

  const addOption = () => { if (options.length < 10) setOptions((prev) => [...prev, '']); };
  const removeOption = (i: number) => { if (options.length > 2) setOptions((prev) => prev.filter((_, j) => j !== i)); };
  const updateOption = (i: number, v: string) => setOptions((prev) => prev.map((o, j) => j === i ? v : o));

  const submit = () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) return;
    onCreate(q, opts, isQuiz ? correctAnswer : undefined, anonymous || undefined, (!isQuiz && allowMultiple) || undefined);
    setQuestion('');
    setOptions(['', '']);
    setIsQuiz(false);
    setCorrectAnswer(0);
    setAnonymous(false);
    setAllowMultiple(false);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardHost variant="modal">
      <View style={pollStyles.overlay}>
        <View style={[pollStyles.sheet, { backgroundColor: colors.surface }]}>
          <Text style={[pollStyles.title, { color: colors.text }]}>{isQuiz ? '🧠 Новая викторина' : '📊 Новый опрос'}</Text>
          <TextInput
            style={[pollStyles.questionInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
            value={question}
            onChangeText={setQuestion}
            placeholder={isQuiz ? 'Вопрос викторины…' : 'Вопрос…'}
            placeholderTextColor={colors.textMuted}
          />
          {options.map((opt, i) => (
            <View key={i} style={pollStyles.optionRow}>
              {isQuiz ? (
                <AppPressable onPress={() => setCorrectAnswer(i)} style={{ padding: 6 }}>
                  <Ionicons name={correctAnswer === i ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={correctAnswer === i ? colors.success : colors.textMuted} />
                </AppPressable>
              ) : null}
              <TextInput
                style={[pollStyles.optionInput, { color: colors.text, backgroundColor: colors.background, borderColor: isQuiz && correctAnswer === i ? colors.success : colors.border, flex: 1 }]}
                value={opt}
                onChangeText={(v) => updateOption(i, v)}
                placeholder={isQuiz ? `Вариант ${i + 1}${correctAnswer === i ? ' (верный)' : ''}` : `Вариант ${i + 1}`}
                placeholderTextColor={colors.textMuted}
              />
              {options.length > 2 ? (
                <AppPressable onPress={() => removeOption(i)} style={{ padding: 8 }}>
                  <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                </AppPressable>
              ) : null}
            </View>
          ))}
          {options.length < 10 ? (
            <AppPressable onPress={addOption} style={pollStyles.addOption}>
              <Ionicons name="add-circle-outline" size={18} color={colors.accent} />
              <Text style={{ color: colors.accent, marginLeft: 4 }}>Добавить вариант</Text>
            </AppPressable>
          ) : null}
          {/* Quiz mode toggle */}
          <AppPressable onPress={() => setIsQuiz((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 4 }}>
            <Ionicons name={isQuiz ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={isQuiz ? colors.accent : colors.textMuted} style={{ marginRight: 8 }} />
            <Text style={{ color: isQuiz ? colors.accent : colors.textMuted, fontSize: 14 }}>Режим викторины</Text>
          </AppPressable>
          {isQuiz ? (
            <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8, marginLeft: 28 }}>Отметьте правильный вариант (●)</Text>
          ) : null}
          {/* Multiple answers toggle */}
          {!isQuiz ? (
            <AppPressable onPress={() => setAllowMultiple((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Ionicons name={allowMultiple ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={allowMultiple ? colors.accent : colors.textMuted} style={{ marginRight: 8 }} />
              <Text style={{ color: allowMultiple ? colors.accent : colors.textMuted, fontSize: 14 }}>Несколько вариантов ответа</Text>
            </AppPressable>
          ) : null}
          {/* Anonymous mode toggle */}
          <AppPressable onPress={() => setAnonymous((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Ionicons name={anonymous ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={anonymous ? colors.accent : colors.textMuted} style={{ marginRight: 8 }} />
            <Text style={{ color: anonymous ? colors.accent : colors.textMuted, fontSize: 14 }}>Скрыть имена голосовавших</Text>
          </AppPressable>
          {/*
            v4.32.254: раньше галочка называлась «Анонимное голосование» и
            обещала больше, чем даёт. Общего сервера у групп нет: голос
            приезжает участникам подписанным личным сообщением, то есть
            отправитель известен каждому получателю, и приложение просто не
            показывает имена. Настоящей анонимности здесь быть не может, а
            обещать её на экране, где люди высказываются, — прямой вред.
          */}
          <Text style={{ color: colors.textMuted, fontSize: font.xs, marginBottom: 8, marginLeft: 28 }}>
            Имена не показываются в результатах. Полной анонимности нет: голос
            приходит участникам подписанным сообщением.
          </Text>
          <View style={pollStyles.btnRow}>
            <AppPressable style={[pollStyles.btn, { borderColor: colors.border }]} onPress={onClose}>
              <Text style={{ color: colors.text }}>Отмена</Text>
            </AppPressable>
            <AppPressable style={[pollStyles.btn, { backgroundColor: colors.primary, borderColor: colors.primary }]} onPress={submit}>
              <Text style={{ color: primaryInk(colors).text, fontWeight: '600' }}>Создать</Text>
            </AppPressable>
          </View>
        </View>
      </View>
      </KeyboardHost>
    </Modal>
  );
}

const pollStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: scrim.modal },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 40 },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 16 },
  questionInput: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 12 },
  optionRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  optionInput: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  addOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { flex: 1, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', paddingVertical: 12 },
});
