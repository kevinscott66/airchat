import React, { useState } from 'react';
import { View, Text, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { KeyboardHost } from '../../KeyboardHost';
import { useTheme } from '../../../ThemeContext';
import { primaryInk, scrim } from '../../../theme';

// ─── Poll Creator Modal ───────────────────────────────────────────────────────
export function DmPollCreatorModal({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], correctAnswer?: number, anonymous?: boolean) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [isQuiz, setIsQuiz] = useState(false);
  const [correctAnswer, setCorrectAnswer] = useState(0);
  const [anonymous, setAnonymous] = useState(false);
  const reset = () => { setQuestion(''); setOptions(['', '']); setIsQuiz(false); setCorrectAnswer(0); setAnonymous(false); };
  const submit = () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) {
      Alert.alert('Опрос', 'Укажите вопрос и хотя бы 2 варианта');
      return;
    }
    onCreate(q, opts, isQuiz ? correctAnswer : undefined, anonymous || undefined);
    reset();
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { reset(); onClose(); }}>
      <KeyboardHost variant="modal">
      <AppPressable style={{ flex: 1, backgroundColor: scrim.modal }} onPress={() => { reset(); onClose(); }}>
        <AppPressable onPress={() => {/* stop propagation */}} style={{ marginTop: 'auto', borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: colors.surface, padding: 20 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 16, textAlign: 'center' }}>{isQuiz ? '🧠 Викторина' : '📊 Опрос'}</Text>
          <TextInput
            placeholder={isQuiz ? 'Вопрос викторины' : 'Вопрос'}
            placeholderTextColor={colors.textMuted}
            value={question}
            onChangeText={setQuestion}
            style={{ backgroundColor: colors.surfaceHigh, color: colors.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12, fontSize: 15 }}
          />
          {options.map((opt, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              {isQuiz ? (
                <AppPressable onPress={() => setCorrectAnswer(i)} style={{ marginRight: 8 }}>
                  <Ionicons name={correctAnswer === i ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={correctAnswer === i ? colors.success : colors.textMuted} />
                </AppPressable>
              ) : null}
              <TextInput
                placeholder={isQuiz ? `Вариант ${i + 1}${correctAnswer === i ? ' (верный)' : ''}` : `Вариант ${i + 1}`}
                placeholderTextColor={colors.textMuted}
                value={opt}
                onChangeText={(t) => setOptions((prev) => prev.map((o, j) => j === i ? t : o))}
                style={{ flex: 1, backgroundColor: colors.surfaceHigh, color: colors.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, borderWidth: isQuiz && correctAnswer === i ? 1 : 0, borderColor: colors.success }}
              />
              {options.length > 2 ? (
                <AppPressable onPress={() => setOptions((prev) => prev.filter((_, j) => j !== i))} style={{ marginLeft: 8 }}>
                  <Ionicons name="remove-circle-outline" size={20} color={colors.textMuted} />
                </AppPressable>
              ) : null}
            </View>
          ))}
          {options.length < 8 ? (
            <AppPressable onPress={() => setOptions((prev) => [...prev, ''])} style={{ paddingVertical: 8, alignItems: 'center' }}>
              <Text style={{ color: colors.accent, fontSize: 14 }}>+ Добавить вариант</Text>
            </AppPressable>
          ) : null}
          <AppPressable onPress={() => setIsQuiz((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
            <Ionicons name={isQuiz ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={isQuiz ? colors.accent : colors.textMuted} style={{ marginRight: 8 }} />
            <Text style={{ color: isQuiz ? colors.accent : colors.textMuted, fontSize: 14 }}>Режим викторины</Text>
          </AppPressable>
          <AppPressable onPress={() => setAnonymous((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, marginBottom: 4 }}>
            <Ionicons name={anonymous ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={anonymous ? colors.accent : colors.textMuted} style={{ marginRight: 8 }} />
            <Text style={{ color: anonymous ? colors.accent : colors.textMuted, fontSize: 14 }}>Скрыть имена голосовавших</Text>
          </AppPressable>
          {/*
            v4.32.254: галочка называлась «Анонимное голосование». В личке
            собеседник ровно один, поэтому любой его голос всё равно его —
            прятать нечего, и слово «анонимное» здесь вводило в заблуждение
            сильнее, чем в группе.
          */}
          <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 4, marginLeft: 28 }}>
            В переписке на двоих собеседник всё равно видит, что голос ваш.
          </Text>
          <AppPressable onPress={submit} style={{ backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 }}>
            <Text style={{ color: primaryInk(colors).text, fontWeight: '700', fontSize: 16 }}>Создать</Text>
          </AppPressable>
        </AppPressable>
      </AppPressable>
      </KeyboardHost>
    </Modal>
  );
}
