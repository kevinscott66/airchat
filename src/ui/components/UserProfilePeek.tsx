// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единая точка входа для отображения профиля контакта при тапе по
// имени. Если поменять props peerPubB64/peerDid/displayName — все вызывающие
// места (ChatScreen header, GroupChatScreen sender, FeedScreen post author,
// FeedScreen comment author, StoriesRow author) сломаются молча (пропы optional).
//
// v4.32.50: «При нажатии на имя ты должен переходить в профиль пользователя».
// Лёгкая модалка-peek с аватаром/именем/DID + действия: «Открыть чат»,
// «Копировать ID», «Добавить в контакты» (если не добавлен), «Переименовать»
// (если добавлен). Открытие из любой точки UI — тап по имени.
//
// v4.32.363: пропы не тронуты — правки только внутри. Решения «как зовут»,
// «в контактах ли» и «под каким именем добавлять» уехали в profilePeekModel:
// без React их видно проверкам.
//
// v4.32.427: пропы снова не тронуты. Внутри — проверка открытого ключа до
// обращения к кривой: раньше отказ приходил из noble, и его английский текст
// показывался человеку как объяснение, почему не добавился контакт.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { AppModal } from './AppModal';
import { KeyboardHost } from './KeyboardHost';
import { AppPressable } from './AppPressable';
import { useColors } from '../ThemeContext';
import { avatarShape, font, mono, primaryInk, radius, scrim, spacing } from '../theme';
import { showSuccess, showError } from './userFeedback';
import {
  addContact,
  deleteContact,
  listContacts,
  renameContact,
  type Contact,
} from '../../core/social/contacts';
import { publicKeyToDidKey } from '../../core/identity/did';
import { publicKeyFromB64 } from '../../core/crypto/pubKeyFormat';
import { BAD_PUBLIC_KEY_MESSAGE } from '../../core/social/contacts';
import { peekIdentity, resolvePeer, shortDid } from './profilePeekModel';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { contactLabel } from '../../core/social/contactLabel';
import { userErrorText } from './userErrorText';
import { COPY_ID_ACTION, COPIED_ID } from '../clipboardText';

export interface UserProfilePeekProps {
  /** Видна ли модалка. */
  visible: boolean;
  /** Закрыть модалку. */
  onClose: () => void;
  /**
   * Идентификатор пира. Можно передать ЛИБО pubB64 ЛИБО did — внутри нормализуется.
   * Если оба null — модалка не откроется.
   */
  peerPubB64?: string | null;
  peerDid?: string | null;
  /** Подсказка для имени, если контакта ещё нет в адресной книге (например `authorName` из поста). */
  fallbackName?: string | null;
  /** Мой pair — нужен для addContact (шлёт invite-пакет). */
  pair: KeyPairBytes | null;
  /**
   * Открыть чат с этим пиром. Вызывается из кнопки «Написать сообщение».
   * Получает peerPubB64 и displayName (актуальные, с учётом возможного переименования).
   */
  onOpenChat?: (peerPubB64: string, displayName: string) => void;
}

export function UserProfilePeek({
  visible,
  onClose,
  peerPubB64,
  peerDid,
  fallbackName,
  pair,
  onOpenChat,
}: UserProfilePeekProps): React.ReactElement | null {
  const colors = useColors();

  const resolved = useMemo(
    () => resolvePeer(peerPubB64, peerDid),
    [peerPubB64, peerDid]
  );

  // Пытаемся найти контакт в адресной книге (даёт displayName + знание, что он в контактах).
  const [contact, setContact] = useState<Contact | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isSelf, setIsSelf] = useState(false);

  useEffect(() => {
    // Сброс делаем на любую смену пира, а не только на закрытие: иначе, пока
    // грузится адресная книга нового, на карточке висит имя предыдущего.
    setContact(null);
    setRenaming(false);
    setRenameDraft('');
    setIsSelf(false);
    if (!visible || !resolved) return;
    let cancelled = false;
    void (async () => {
      try {
        // Self-detection: сравниваем DID (публичный идентификатор, безопасно логировать).
        // Присваиваем результат сравнения, а не только `true`: иначе смена пира
        // при открытой карточке оставила бы «(Вы)» на чужом профиле.
        if (pair && !cancelled) {
          setIsSelf(publicKeyToDidKey(pair.publicKey) === resolved.did);
        }
        const all = await listContacts();
        if (cancelled) return;
        const found = all.find((c) => c.peerPublicKey === resolved.pubB64) ?? null;
        setContact(found);
        setRenameDraft(contactLabel(found?.displayName, fallbackName ?? ''));
      } catch {
        /* ignore — модалка всё равно покажет fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, resolved, pair, fallbackName]);

  // `identity` считается и когда пир не разобрался: хуков нельзя вызывать
  // меньше, чем в прошлый раз, а ранний выход стоит ниже.
  const identity = useMemo(
    () => peekIdentity({ contact, fallbackName, did: resolved?.did ?? '', isSelf }),
    [contact, fallbackName, resolved, isSelf]
  );
  // Имя для действий: у безымянного это заглушка из DID, а не слово «Контакт»
  // — иначе двое добавленных незнакомцев станут в списке чатов неразличимы.
  const displayName = identity.contactName;

  const handleCopyId = useCallback(async () => {
    if (!resolved) return;
    try {
      await Clipboard.setStringAsync(resolved.did);
      showSuccess(COPIED_ID);
    } catch {
      showError('Не удалось скопировать');
    }
  }, [resolved]);

  const handleShareId = useCallback(async () => {
    if (!resolved) return;
    try {
      // У безымянного заглушка — тот же DID, обрезанный: в сообщении он
      // выглядел бы напечатанным дважды.
      const who = identity.named ? `AirChat: ${identity.title}\n` : 'AirChat\n';
      await Share.share({ message: `${who}${resolved.did}` });
    } catch {
      /* user cancelled или share недоступен */
    }
  }, [resolved, identity]);

  const handleAddContact = useCallback(async () => {
    if (!resolved || !pair) return;
    try {
      // v4.32.427: ключ проверяется до кривой. Раньше сюда уезжали любые
      // байты, отказ приходил из noble, и в русское окно попадал его текст —
      // «"point" expected Uint8Array of length 32, got length=10».
      const raw = publicKeyFromB64(resolved.pubB64);
      if (!raw) {
        showError(BAD_PUBLIC_KEY_MESSAGE);
        return;
      }
      await addContact(pair, raw, displayName);
      setContact({ peerPublicKey: resolved.pubB64, displayName });
      showSuccess('Контакт добавлен');
    } catch {
      // Текст ошибки наружу не показывается: сюда приходят сбои хранилища и
      // сети, и их сообщения — английские строки чужих библиотек.
      showError('Не удалось добавить контакт');
    }
  }, [resolved, pair, displayName]);

  const handleSubmitRename = useCallback(async () => {
    if (!resolved) return;
    const next = renameDraft.trim();
    if (!next) {
      showError('Имя не может быть пустым');
      return;
    }
    try {
      await renameContact(resolved.pubB64, next);
      setContact((prev) => (prev ? { ...prev, displayName: next } : prev));
      setRenaming(false);
      showSuccess('Имя обновлено');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось переименовать'));
    }
  }, [resolved, renameDraft]);

  const handleDeleteContact = useCallback(() => {
    if (!resolved) return;
    Alert.alert('Удалить контакт?', 'Контакт будет удалён из вашей адресной книги.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteContact(resolved.pubB64);
            setContact(null);
            showSuccess('Контакт удалён');
          } catch (e) {
            showError(userErrorText(e, 'Не удалось удалить'));
          }
        },
      },
    ]);
  }, [resolved]);

  const handleOpenChat = useCallback(() => {
    if (!resolved) return;
    onOpenChat?.(resolved.pubB64, displayName);
    onClose();
  }, [resolved, displayName, onOpenChat, onClose]);

  if (!resolved) return null;

  return (
    <AppModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardHost variant="modal">
      {/* Backdrop: тап по полупрозрачному фону закрывает модалку. */}
      <View style={styles.backdrop}>
        <AppPressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Закрыть"
        />
        {/* Card поверх backdrop; inner-тапы не закрывают модалку. */}
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
              <View style={styles.header}>
                <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
                  <Text style={[styles.avatarText, { color: primaryInk(colors).text }]}>{identity.initials}</Text>
                </View>
                {renaming ? (
                  <View style={{ flex: 1, marginLeft: spacing.md }}>
                    <TextInput
                      value={renameDraft}
                      onChangeText={setRenameDraft}
                      placeholder="Имя контакта"
                      placeholderTextColor={colors.textSecondary}
                      style={[
                        styles.renameInput,
                        { color: colors.text, borderColor: colors.border },
                      ]}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={() => void handleSubmitRename()}
                    />
                    <View style={styles.renameActions}>
                      <AppPressable
                        onPress={() => {
                          setRenaming(false);
                          setRenameDraft(contactLabel(contact?.displayName, fallbackName ?? ''));
                        }}
                      >
                        <Text style={[styles.renameCancel, { color: colors.textSecondary }]}>
                          Отмена
                        </Text>
                      </AppPressable>
                      <AppPressable onPress={() => void handleSubmitRename()}>
                        <Text style={[styles.renameSave, { color: colors.accent }]}>
                          Сохранить
                        </Text>
                      </AppPressable>
                    </View>
                  </View>
                ) : (
                  <View style={{ flex: 1, marginLeft: spacing.md }}>
                    <Text
                      style={[
                        styles.name,
                        { color: identity.named ? colors.text : colors.textSecondary },
                      ]}
                      numberOfLines={2}
                    >
                      {identity.title}
                      {isSelf ? ' (Вы)' : ''}
                    </Text>
                    <Text style={[styles.hint, { color: colors.textSecondary }]}>
                      {identity.hint}
                    </Text>
                  </View>
                )}
              </View>

              <View style={[styles.didBox, { borderColor: colors.border }]}>
                <Text style={[styles.didLabel, { color: colors.textSecondary }]}>DID</Text>
                <Text
                  style={[styles.didValue, { color: colors.text }]}
                  numberOfLines={1}
                  selectable
                >
                  {shortDid(resolved.did, 10)}
                </Text>
              </View>

              <View style={styles.actions}>
                {!isSelf && (
                  <AppPressable
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={handleOpenChat}
                  >
                    <Ionicons
                      name="chatbubble-ellipses-outline"
                      size={20}
                      color={colors.accent}
                    />
                    <Text style={[styles.actionText, { color: colors.text }]}>
                      Написать сообщение
                    </Text>
                  </AppPressable>
                )}

                <AppPressable
                  style={[styles.actionRow, { borderTopColor: colors.border }]}
                  onPress={() => void handleCopyId()}
                >
                  <Ionicons name="copy-outline" size={20} color={colors.text} />
                  <Text style={[styles.actionText, { color: colors.text }]}>{COPY_ID_ACTION}</Text>
                </AppPressable>

                <AppPressable
                  style={[styles.actionRow, { borderTopColor: colors.border }]}
                  onPress={() => void handleShareId()}
                >
                  <Ionicons name="share-outline" size={20} color={colors.text} />
                  <Text style={[styles.actionText, { color: colors.text }]}>Поделиться ID…</Text>
                </AppPressable>

                {/* Implicit-строка контактом не считается: именно тут человеку
                    и нужно «Добавить», а кнопка пряталась. */}
                {!isSelf && !identity.inContacts && (
                  <AppPressable
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={() => void handleAddContact()}
                  >
                    <Ionicons name="person-add-outline" size={20} color={colors.accent} />
                    <Text style={[styles.actionText, { color: colors.text }]}>
                      Добавить в контакты
                    </Text>
                  </AppPressable>
                )}

                {!isSelf && contact && !renaming && (
                  <AppPressable
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={() => {
                      setRenameDraft(contact.displayName);
                      setRenaming(true);
                    }}
                  >
                    <Ionicons name="create-outline" size={20} color={colors.text} />
                    <Text style={[styles.actionText, { color: colors.text }]}>
                      Переименовать
                    </Text>
                  </AppPressable>
                )}

                {/* Удаление — только для добавленного руками. У implicit-строки
                    удалять нечего: человек в адресную книгу не попадал, а
                    вместе со строкой ушёл бы ключ переписки с ним. */}
                {!isSelf && identity.inContacts && !renaming && (
                  <AppPressable
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={handleDeleteContact}
                  >
                    <Ionicons name="trash-outline" size={20} color={colors.error} />
                    <Text style={[styles.actionText, { color: colors.error }]}>
                      Удалить контакт
                    </Text>
                  </AppPressable>
                )}

                <AppPressable
                  style={[styles.actionRow, { borderTopColor: colors.border }]}
                  onPress={onClose}
                >
                  <Ionicons name="close-outline" size={20} color={colors.textSecondary} />
                  <Text style={[styles.actionText, { color: colors.textSecondary }]}>
                    Закрыть
                  </Text>
                </AppPressable>
              </View>
        </View>
      </View>
      </KeyboardHost>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: scrim.modal,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  card: {
    borderRadius: radius.xl,
    padding: spacing.md,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  avatar: {
    ...avatarShape(56),
    alignItems: 'center',
    justifyContent: 'center',
  },
  // v4.32.419: цвет инициалов переехал на место вызова — заливка кружка
  // это `primary`, который выбирает пользователь, а лист стилей считается
  // один раз при загрузке модуля и о теме не знает.
  avatarText: {
    fontSize: font.xl,
    fontWeight: '700',
  },
  name: {
    fontSize: font.lg,
    fontWeight: '700',
  },
  hint: {
    fontSize: font.sm,
    marginTop: 2,
  },
  didBox: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  didLabel: {
    fontSize: font.xs,
    marginBottom: 2,
  },
  didValue: {
    fontSize: font.md,
    fontFamily: mono,
  },
  actions: {
    marginTop: spacing.xs,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    fontSize: font.md,
  },
  renameInput: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: font.md,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  renameCancel: {
    fontSize: font.sm,
    paddingVertical: spacing.xs,
  },
  renameSave: {
    fontSize: font.sm,
    fontWeight: '600',
    paddingVertical: spacing.xs,
  },
});

export default UserProfilePeek;
