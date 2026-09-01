import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppModal as Modal } from '../../AppModal';
import { KeyboardHost } from '../../KeyboardHost';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { primaryInk, scrim } from '../../../theme';

// ─── ScheduleModal ────────────────────────────────────────────────────────────
export function ScheduleModal({
  visible,
  onClose,
  onSchedule,
}: {
  visible: boolean;
  onClose: () => void;
  onSchedule: (sendAt: number) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const [customHour, setCustomHour] = useState('');
  const [customMin, setCustomMin] = useState('');
  const [customTomorrow, setCustomTomorrow] = useState(false);

  const presets = [
    { label: 'Через 1 час', ms: 60 * 60_000 },
    { label: 'Через 4 часа', ms: 4 * 60 * 60_000 },
    { label: 'Сегодня вечером (20:00)', ms: (() => {
      const d = new Date(); d.setHours(20, 0, 0, 0);
      return d.getTime() > Date.now() ? d.getTime() - Date.now() : 24 * 60 * 60_000;
    })() },
    { label: 'Завтра утром (9:00)', ms: (() => {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      return d.getTime() - Date.now();
    })() },
  ];

  const scheduleCustom = () => {
    const h = parseInt(customHour, 10);
    const m = parseInt(customMin || '0', 10);
    if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
      return;
    }
    const target = new Date();
    if (customTomorrow) target.setDate(target.getDate() + 1);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    onSchedule(target.getTime());
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardHost variant="modal">
      <AppPressable style={schStyles.overlay} onPress={onClose}>
        <View style={[schStyles.sheet, { backgroundColor: colors.surface }]}>
          <Text style={[schStyles.title, { color: colors.text }]}>Запланировать отправку</Text>
          {presets.map((p) => (
            <AppPressable
              key={p.label}
              style={[schStyles.preset, { borderBottomColor: colors.border }]}
              onPress={() => { onSchedule(Date.now() + p.ms); onClose(); }}
            >
              <Text style={[schStyles.presetText, { color: colors.text }]}>{p.label}</Text>
              <Ionicons name="time-outline" size={18} color={colors.accent} />
            </AppPressable>
          ))}
          <View style={schStyles.customRow}>
            <TextInput
              style={[schStyles.timeInput, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              placeholder="ЧЧ"
              placeholderTextColor={colors.textMuted}
              value={customHour}
              onChangeText={setCustomHour}
              keyboardType="number-pad"
              maxLength={2}
            />
            <Text style={[schStyles.colon, { color: colors.textMuted }]}>:</Text>
            <TextInput
              style={[schStyles.timeInput, { color: colors.text, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
              placeholder="ММ"
              placeholderTextColor={colors.textMuted}
              value={customMin}
              onChangeText={setCustomMin}
              keyboardType="number-pad"
              maxLength={2}
            />
            <AppPressable
              style={[schStyles.dayToggle, { borderColor: colors.border, backgroundColor: customTomorrow ? colors.primary : 'transparent' }]}
              onPress={() => setCustomTomorrow((v) => !v)}
            >
              <Text style={{ color: customTomorrow ? primaryInk(colors).text : colors.textMuted, fontSize: 12 }}>Завтра</Text>
            </AppPressable>
            <AppPressable
              style={[schStyles.scheduleBtn, { backgroundColor: colors.primary }]}
              onPress={scheduleCustom}
              disabled={!customHour}
            >
              <Text style={[schStyles.scheduleBtnText, { color: primaryInk(colors).text }]}>Запланировать</Text>
            </AppPressable>
          </View>
        </View>
      </AppPressable>
      </KeyboardHost>
    </Modal>
  );
}

const schStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: scrim.modal },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32, paddingHorizontal: 16 },
  title: { fontSize: 17, fontWeight: '700', paddingVertical: 16, textAlign: 'center' },
  preset: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  presetText: { fontSize: 15 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14 },
  timeInput: { width: 48, textAlign: 'center', borderWidth: 1, borderRadius: 8, paddingVertical: 8, fontSize: 16 },
  colon: { fontSize: 18, fontWeight: '700' },
  dayToggle: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8 },
  scheduleBtn: { flex: 1, borderRadius: 8, alignItems: 'center', paddingVertical: 8 },
  // v4.32.419: цвет подписи переехал на место вызова — заливка кнопки
  // это `primary`, а лист считается один раз при загрузке модуля.
  scheduleBtnText: { fontWeight: '700', fontSize: 14 },
});
