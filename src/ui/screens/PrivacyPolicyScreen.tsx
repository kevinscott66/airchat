import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { Ionicons } from '@expo/vector-icons';
import { SafeScreen } from '../components/SafeScreen';
import { useThemedStyles, useColors } from '../ThemeContext';
import type { AppColors } from '../theme';
import { LOCAL_RADIO_TRANSPORTS_AVAILABLE } from '../platformCapabilities';

type StylesSubset = ReturnType<typeof makeStyles>;

function makeStyles(c: AppColors) {
  return {
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    backBtn: { marginRight: 12 },
    title: { color: c.text, fontSize: 18, fontWeight: '700' as const },
    scroll: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, paddingBottom: 40 },
    section: { marginBottom: 16 },
    sectionTitle: { color: c.text, fontWeight: '700' as const, fontSize: 15, marginBottom: 6 },
    sectionBody: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
    contact: { color: c.textMuted, fontSize: 12, marginTop: 24, textAlign: 'center' as const },
  };
}

type Props = {
  onBack?: () => void;
};

export function PrivacyPolicyScreen({ onBack }: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
      <View style={styles.header}>
        {onBack ? (
          <AppPressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.accent} />
          </AppPressable>
        ) : null}
        <Text style={styles.title}>Политика конфиденциальности</Text>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* v4.32.594: раздел говорил «разработчики не ведут центральной базы
            данных ваших сообщений или контактов», а «Данные, хранящиеся
            локально» — что всё лежит только на телефоне. С появлением облачного
            хранилища и синхронизации аккаунта это перестало быть правдой:
            записи уезжают на сервер и возвращаются на другое устройство. Текст
            политики, который расходится с делом, хуже отсутствия текста —
            человек принимает решение о своих данных по нему. Ниже сказано и
            что уходит, и что при этом видно серверу. */}
        <Section title="Сбор данных" styles={styles}>
          AirChat — мессенджер со сквозным шифрованием. Всё, что вы пишете, шифруется на устройстве до отправки: ни разработчики, ни сервер не читают ваши сообщения. При этом аккаунт живёт на сервере — переписка, контакты, публикации и настройки хранятся там в зашифрованном виде, чтобы открываться на других ваших устройствах. Ключ к ним есть только у вас.
        </Section>

        <Section title="Шифрование" styles={styles}>
          Сообщения защищены симметричным шифрованием XChaCha20-Poly1305 с ключами, создаваемыми для каждой сессии. Ваш долгосрочный приватный ключ Ed25519 хранится на устройстве (SecureStore) и не покидает его без явного экспорта резервной копии.
        </Section>

        <Section title="Хранение аккаунта на сервере" styles={styles}>
          Сообщения, контакты, публикации и настройки уходят на сервер синхронизации отдельными записями, зашифрованными ключом, который выводится из ваших секретных слов. Сервер видит служебное: номер аккаунта и устройства, вид записи, её номер версии и время изменения — по ним он решает, что отдать другому вашему устройству. Содержимое записей и ключи к медиафайлам он не видит и расшифровать не может. Резервная копия в облачном хранилище устроена так же: она шифруется секретными словами вместе с паролем приложения ещё на телефоне, и сервер получает уже закрытый файл. Забыв и слова, и пароль, доступ не восстановит никто — включая нас.
        </Section>

        <Section title="Реестр юзернеймов" styles={styles}>
          Чтобы одно и то же «@имя» не заняли двое, имена проверяются в общем реестре на сервере. Реестр отвечает только «занято» или «свободно» и не называет владельца — по чужому имени нельзя вычислить его аккаунт. Если сервер недоступен, имя сохраняется только на устройстве, и приложение об этом прямо говорит.
        </Section>

        {/* v4.32.528: раздел политики отвечает на вопрос «что это приложение
            делает с моими данными», а не «что умеет продукт вообще». В браузере
            локальной сети приложение не касается — сокет и mDNS ему недоступны, —
            и раздел про неё описывал бы чужое поведение. Лишний раздел в политике
            не безобиден: он размывает границу того, на что пользователь
            соглашается. См. platformCapabilities. */}
        {LOCAL_RADIO_TRANSPORTS_AVAILABLE ? (
          <Section title="Wi-Fi LAN (локальная сеть)" styles={styles}>
            Приложение поддерживает обмен сообщениями через локальную Wi-Fi сеть без подключения к интернету. Все сообщения шифруются на устройстве до отправки — незашифрованный текст по сети не передаётся.
          </Section>
        ) : null}

        <Section title="Интернет (Wi-Fi / мобильная сеть)" styles={styles}>
          Для связи через интернет приложение использует зашифрованные соединения по Wi-Fi или мобильной сети. Содержимое сообщений не передаётся на серверы в открытом виде.
        </Section>

        <Section title="Ретранслятор" styles={styles}>
          Когда устройства не видят друг друга в локальной сети, зашифрованные сообщения идут через публичный ретранслятор (по умолчанию ntfy.sh). Прочитать их он не может — ключей у него нет. Но, как любой посредник, он видит служебное: адрес вашей сети, время отправки и идентификатор канала, по которому вы обмениваетесь. Ретранслятор заменяется на свой в настройках приложения.
        </Section>

        <Section title="IPFS" styles={styles}>
          При использовании IPFS зашифрованные блоки могут храниться или ретранслироваться сетью IPFS. Расшифровать содержимое могут только участники, у которых есть соответствующие ключи.
        </Section>

        <Section title="Push-уведомления (опционально)" styles={styles}>
          Если включены уведомления, устройство получает token FCM. Сервер уведомлений отправляет только идентификатор нового сообщения — без содержимого. Сервер не хранит историю чатов.
        </Section>

        <Section title="Местоположение" styles={styles}>
          Геолокация запрашивается только в тот момент, когда вы сами отправляете своё место, включаете трансляцию перемещения или добавляете место к публикации. Разрешение берётся на время работы приложения — фоновой слежки нет, и без вашего действия координаты не читаются. Отправленные координаты уходят зашифрованным сообщением ровно тем, кому вы их отправили, и остаются в переписке на устройствах: ни разработчики, ни ретранслятор, ни сервер уведомлений их не получают.
        </Section>

        <Section title="Данные на устройстве" styles={styles}>
          Приложение держит полную копию переписки, контактов и ключей на самом телефоне и работает с ней, даже когда сети нет. Приватные ключи остаются здесь всегда: на сервер они не уходят ни в каком виде. Пункт «Выйти и удалить данные на устройстве» в настройках стирает эту копию с телефона; записи, уже уехавшие на сервер, удаляются отдельно — вместе с аккаунтом.
        </Section>

        <Section title="Изменения политики" styles={styles}>
          В случае изменений политики конфиденциальности обновления будут опубликованы вместе с обновлением приложения.
        </Section>

        <Text style={styles.contact}>Вопросы: пишите через GitHub Issues или в репозиторий проекта.</Text>
      </ScrollView>
    </SafeScreen>
  );
}

function Section({
  title,
  children,
  styles,
}: {
  title: string;
  children: React.ReactNode;
  styles: StylesSubset;
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{children}</Text>
    </View>
  );
}
