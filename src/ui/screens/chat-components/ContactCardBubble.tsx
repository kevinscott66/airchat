import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { AppPressable } from '../../components/AppPressable';
import { showError, showSuccess } from '../../components/userFeedback';
import { avatarShape, font, identityAvatar } from '../../theme';
import { addContact } from '../../../core/social/contacts';
import { publicKeyFromB64 } from '../../../core/crypto/pubKeyFormat';
import type { KeyPairBytes } from '../../../core/crypto/keyManager';
// Напрямую из ядра, а не через реэкспорт ChatScreen: этот компонент ChatScreen
// же и рисует, то есть импорт «наверх» замыкал цикл модулей.
import { parseContactCard } from '../../../core/social/contactCardEnvelope';
import { nameInitial } from '../../../core/social/contactLabel';
import { useBubbleSurface } from '../../BubbleKindContext';
import { shortIdentity } from '../../identity/shortId';

export function ContactCardBubble({
  text,
  isOutgoing,
  pair,
}: {
  text: string;
  isOutgoing: boolean;
  pair: KeyPairBytes;
}): React.ReactElement | null {
  // v4.32.411: содержимое пузыря — от его заливки. Ключ писался белым под
  // 70 % (3.40:1 в светлой теме), линия — белым под 30 % (2.55:1 в тёмной,
  // 1.70:1 в светлой, при графическом пороге 3:1).
  const bubble = useBubbleSurface(isOutgoing);
  const card = parseContactCard(text);
  if (!card) return null;
  const accentColor = bubble.icon;
  // v4.32.409: кружок с буквой — различитель личности, как в списках
  // просмотров и голосований. Прежняя заливка `accentColor + '33'` в
  // исходящем пузыре была белым по 20 % поверх пузыря, то есть цвет под
  // буквой зависел от того, какой акцент выбран в настройках.
  const circle = identityAvatar(card.pub);
  const textColor = bubble.ink.text;
  const mutedColor = bubble.ink.secondary;
  return (
    <View style={{ minWidth: 180 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <View style={{ ...avatarShape(36), backgroundColor: circle.fill, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: circle.ink, fontSize: 16, fontWeight: '700' }}>{nameInitial(card.name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: textColor, fontWeight: '600', fontSize: 14 }}>{card.name || 'Контакт'}</Text>
          <Text style={{ color: mutedColor, fontSize: font.xs }} numberOfLines={1}>{shortIdentity(card.pub, 10)}</Text>
        </View>
      </View>
      <AppPressable
        style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: bubble.hairline, paddingTop: 8, alignItems: 'center' }}
        onPress={() => {
          Alert.alert(`Добавить ${card.name}?`, shortIdentity(card.pub, 10), [
            { text: 'Отмена', style: 'cancel' },
            {
              text: 'Добавить',
              onPress: () => {
                // v4.32.183 (Round-13 #11): validate base64 decodes to a
                // 32-byte Ed25519 pubkey before storing — otherwise a crafted
                // card corrupts the contacts store and crashes later crypto ops.
                // v4.32.427: try/catch вокруг Buffer.from был мёртвым — тот не
                // бросает на негодной base64, а молча выбрасывает лишние
                // символы, и комментарий над ним обещал защиту, которой не
                // было. Годность решают длина и алфавит, оба в publicKeyFromB64.
                const decoded = publicKeyFromB64(card.pub);
                if (!decoded) {
                  showError('Некорректный контакт');
                  return;
                }
                // v4.32.254: addContact бросает (ECDH, запись в хранилище), а
                // .then без .catch давал unhandled rejection — на экране не
                // появлялось ничего, и было не понять, добавился контакт или нет.
                void addContact(pair, decoded, card.name)
                  .then(() => showSuccess(`${card.name} добавлен в контакты`))
                  .catch(() => showError('Не удалось добавить контакт'));
              },
            },
          ]);
        }}
      >
        <Text style={{ color: accentColor, fontSize: 13, fontWeight: '600' }}>Добавить контакт</Text>
      </AppPressable>
    </View>
  );
}
