import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { Ionicons } from '@expo/vector-icons';
import { SafeScreen } from '../components/SafeScreen';
import { useThemedStyles, useColors } from '../ThemeContext';
import { LOCAL_RADIO_TRANSPORTS_AVAILABLE } from '../platformCapabilities';
import { radius } from '../theme';

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
      borderRadius: radius.lg,
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
        {/* v4.32.594: карточки переписаны под то, чем приложение стало.
            Прежний текст описывал вещь, которая живёт на телефоне и умеет
            обходиться без интернета, — «связь без интернета» стояла вторым
            экраном, а про сервер было сказано одно расплывчатое предложение
            про «распределённое облако». Сегодня наоборот: аккаунт, переписка,
            публикации и настройки едут через сервер, с него же поднимаются на
            новом устройстве, а радио и локальная сеть — запасной путь. Слова
            должны называть это прямо, иначе человек не понимает, что у него
            где лежит и что он потеряет, забыв ключи. */}
        <View style={styles.card}>
          <Ionicons name="lock-closed" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Сообщения читаете только вы</Text>
          <Text style={styles.cardText}>
            Текст шифруется на телефоне до отправки, и ключ есть только у вас и у собеседника. Через сервер
            сообщение проходит закрытым: он передаёт его дальше, но прочитать не может.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="cloud-outline" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Аккаунт хранится на сервере</Text>
          <Text style={styles.cardText}>
            Переписка, контакты, публикации и настройки уходят на сервер и возвращаются на любое ваше
            устройство — после переустановки или на новом телефоне ничего не нужно переносить руками.
            Уходят они зашифрованными ключом вашего аккаунта: сервер видит, что запись изменилась, и не
            видит, что в ней написано.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="phone-portrait-outline" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Несколько устройств сразу</Text>
          <Text style={styles.cardText}>
            Один аккаунт открывается на телефоне, планшете и в браузере одновременно. Список устройств
            виден в настройках — «Активные сессии»: там же лишнее отключается.
          </Text>
        </View>

        {/* v4.32.528: карточка — не описание продукта, а инструкция: «подключитесь
            к одной точке доступа». В браузере выполнить её нельзя, и выполнивший
            всё равно никого не увидит. Такая подсказка не просто бесполезна, она
            уводит от рабочих способов связи, которые на этой платформе есть.
            См. platformCapabilities. */}
        {LOCAL_RADIO_TRANSPORTS_AVAILABLE && (
          <View style={styles.card}>
            <Ionicons name="wifi" size={32} color={colors.accent} />
            <Text style={styles.cardTitle}>Запасной путь без интернета</Text>
            <Text style={styles.cardText}>
              Если интернета нет, а собеседник рядом, сообщение уйдёт по локальной Wi-Fi сети — подключитесь
              к одной точке доступа. Это запасной путь, а не основной: синхронизация с сервером и звонки
              так не работают, они догонят при первом выходе в сеть.
            </Text>
          </View>
        )}

        <View style={styles.card}>
          <Ionicons name="key" size={32} color={colors.accent} />
          <Text style={styles.cardTitle}>Секретные слова и облачный пароль</Text>
          <Text style={styles.cardText}>
            Секретные слова — это сам аккаунт: по ним он открывается на новом устройстве, и без них вход не
            восстановит никто, включая нас. Облачный пароль отпирает то, что лежит на сервере. Запишите
            слова на бумаге и храните отдельно от телефона.
          </Text>
        </View>
      </ScrollView>
    </SafeScreen>
  );
}
