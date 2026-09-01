import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { Ionicons } from '@expo/vector-icons';
import { SafeScreen } from '../components/SafeScreen';
import { useThemedStyles, useColors } from '../ThemeContext';

type Props = {
  onClose: () => void;
};

export function HelpScreen({ onClose }: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' as const },
    scroll: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, paddingBottom: 32 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardTitle: { color: c.text, fontSize: 17, fontWeight: '700' as const, marginTop: 8, marginBottom: 8 },
    cardText: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  }));

  return (
    <SafeScreen edges={['left', 'right', 'top']} style={{ flex: 1 }}>
      <View style={styles.header}>
        <AppPressable onPress={onClose} hitSlop={12} testID="help_close">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </AppPressable>
        <Text style={styles.headerTitle}>О приложении</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Ionicons name="lock-closed" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Сообщения только для вас</Text>
          <Text style={styles.cardText}>
            Текст шифруется на телефоне до отправки. Прочитать переписку могут только вы и собеседник — не
            сервис и не посторонние.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="wifi" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Связь без интернета</Text>
          <Text style={styles.cardText}>
            AirChat работает в локальной Wi-Fi сети без подключения к интернету. Подключитесь к одной
            точке доступа с собеседником — и общайтесь даже там, где нет мобильной связи.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="cloud-outline" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Хранение и сеть</Text>
          <Text style={styles.cardText}>
            Копии данных могут храниться в распределённом облаке, но в открытом виде там нет ваших сообщений —
            только зашифрованные фрагменты.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="key" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Секретные слова</Text>
          <Text style={styles.cardText}>
            Это резервная копия доступа к аккаунту. Запишите их на бумаге и храните отдельно от телефона.
            Без них восстановить вход нельзя.
          </Text>
        </View>
      </ScrollView>
    </SafeScreen>
  );
}
