import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { AppPressable } from './AppPressable';
import { AppModal as Modal } from './AppModal';
import { Ionicons } from '@expo/vector-icons';
import {
  profileManager,
  type Profile,
  MAX_PROFILES,
} from '../../core/identity/profileManager';
import { showError, showSuccess } from './userFeedback';
import { useThemedStyles, useColors } from '../ThemeContext';
import { font, inkOn, primaryInk, radius, scrim, tintedPlate } from '../theme';
import { shortIdentity } from '../identity/shortId';
import { userErrorText } from './userErrorText';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** После смены ключи уже в SecureStore — родитель обновляет pair. */
  onIdentityUpdated: () => void;
  activeProfile: Profile | null;
  /** true — встроен в Settings subScreen, рендерится без внешнего <Modal>
   * (fullScreen-лист профилей). Убирает задержку mount Android Dialog. */
  embedded?: boolean;
};

export function ProfileSelector({
  visible,
  onClose,
  onIdentityUpdated,
  activeProfile,
  embedded = false,
}: Props): React.ReactElement {
  const colors = useColors();
  const styles = useThemedStyles((c) => {
    // Порядок важен: сначала заливка от поверхности, потом чернила от заливки.
    const activeFill = tintedPlate(c.primary, c.surface).fill;
    const activeInk = inkOn(c, activeFill);
    return {
    modalKav: { flex: 1 },
    renameKav: { flex: 1 },
    sheetScrollContent: {
      paddingBottom: 28,
    },
    overlay: { flex: 1, justifyContent: 'flex-end' as const },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: scrim.modal },
    container: {
      backgroundColor: c.background,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      padding: 20,
      paddingBottom: 28,
      maxHeight: '88%' as const,
      borderWidth: 1,
      borderColor: c.border,
    },
    // embedded: fullscreen inline mode (Settings subScreen) — без native Modal
    embeddedOverlay: { flex: 1 },
    embeddedContainer: {
      flex: 1,
      backgroundColor: c.background,
      padding: 20,
    },
    header: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      marginBottom: 8,
    },
    title: { fontSize: 20, fontWeight: '700' as const, color: c.text },
    subtitle: { color: c.textMuted, fontSize: 12, marginBottom: 14, lineHeight: 17 },
    profileRow: { marginBottom: 12 },
    profileItem: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      padding: 12,
      borderRadius: radius.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    // v4.32.418: заливка активной карточки была вписана как '#1a2540' —
    // тёмно-синяя всегда, в том числе под светлой темой, где имя профиля
    // (`text`) даёт на ней 1.12:1, то есть активный профиль не читается
    // вовсе. Заливка теперь выводится из `primary` и поверхности, а имя и
    // адрес — из самой заливки; общие profileName/profileDid остаются для
    // неактивных строк, лежащих на `surface`.
    activeProfileItem: {
      borderColor: c.primary,
      backgroundColor: activeFill,
    },
    profileInfo: { flex: 1, marginLeft: 10 },
    profileName: { fontSize: 16, fontWeight: '600' as const, color: c.text },
    profileDid: { fontSize: font.xs, color: c.textMuted, marginTop: 4 },
    activeProfileName: { color: activeInk.text },
    activeProfileDid: { color: activeInk.muted },
    rowActions: {
      flexDirection: 'row' as const,
      justifyContent: 'flex-end' as const,
      marginTop: 6,
    },
    deleteBtn: { marginLeft: 16 },
    link: { color: c.accent, fontSize: 13, fontWeight: '600' as const },
    linkDanger: { color: c.error, fontSize: 13, fontWeight: '600' as const },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 16 },
    sectionTitle: { fontSize: 15, fontWeight: '600' as const, color: c.text, marginBottom: 10 },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 12,
      fontSize: 16,
      color: c.text,
      backgroundColor: c.surface,
      marginBottom: 12,
    },
    createButton: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
    },
    createButtonText: { color: primaryInk(c).text, fontSize: 16, fontWeight: '600' as const },
    disabledButton: { opacity: 0.6 },
    limitNote: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: 'center' as const,
      paddingVertical: 10,
      lineHeight: 18,
    },
    slotsCounter: {
      color: c.textMuted,
      fontSize: 12,
      marginBottom: 8,
    },
    renameOverlay: {
      flex: 1,
      backgroundColor: scrim.modal,
      justifyContent: 'center' as const,
      padding: 24,
    },
    renameBox: {
      backgroundColor: c.background,
      borderRadius: radius.lg,
      padding: 18,
      borderWidth: 1,
      borderColor: c.border,
    },
    renameTitle: { color: c.text, fontSize: 17, fontWeight: '700' as const, marginBottom: 12 },
    renameBtns: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, marginTop: 8 },
    renameCancel: { paddingVertical: 10, paddingHorizontal: 14 },
    renameCancelText: { color: c.textSecondary, fontSize: 16 },
    };
  });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newProfileName, setNewProfileName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');

  const loadProfiles = (): void => {
    setProfiles(profileManager.getAllProfiles());
  };

  useEffect(() => {
    if (visible) {
      loadProfiles();
      setNewProfileName('');
    }
  }, [visible]);

  const handleSwitch = async (profile: Profile): Promise<void> => {
    // v4.32.22: если уже активен — не дёргаем switchProfile (не пишет в
    // SecureStore, не перезапускает identity-effect). Просто закрыть sheet.
    if (activeProfile?.id === profile.id) {
      onClose();
      return;
    }
    const switched = await profileManager.switchProfile(profile.id);
    if (!switched) {
      showError('Не удалось переключить профиль');
      return;
    }
    onIdentityUpdated();
    onClose();
    showSuccess(`Активен профиль «${switched.name}»`);
  };

  const handleAddProfile = async (): Promise<void> => {
    if (!newProfileName.trim()) {
      showError('Введите имя профиля');
      return;
    }
    setIsCreating(true);
    try {
      await profileManager.addProfile(newProfileName.trim());
      loadProfiles();
      setNewProfileName('');
      onIdentityUpdated();
      showSuccess('Профиль создан и активирован');
    } catch (error) {
      showError(userErrorText(error, 'Ошибка создания'));
    } finally {
      setIsCreating(false);
    }
  };

  const confirmDelete = (profile: Profile): void => {
    Alert.alert(
      'Удалить профиль?',
      `«${profile.name}» — локальные данные этого аккаунта останутся в базе, но ключ сменится.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await profileManager.deleteProfile(profile.id);
                loadProfiles();
                onIdentityUpdated();
                showSuccess('Профиль удалён');
              } catch (e) {
                showError(userErrorText(e, 'Не удалось удалить профиль'));
              }
            })();
          },
        },
      ]
    );
  };

  const openRename = (p: Profile): void => {
    setRenameId(p.id);
    setRenameText(p.name);
  };

  const submitRename = async (): Promise<void> => {
    if (renameId == null) return;
    const ok = await profileManager.renameProfile(renameId, renameText);
    if (ok) {
      loadProfiles();
      setRenameId(null);
      showSuccess('Имя обновлено');
    }
  };

  const sheetContent = (
    // v4.32.102 K.8: рендерится внутри Modal (non-embedded) — на Android нужно behavior="padding" (height не работает с flex:1 sheet)
    <KeyboardAvoidingView
      style={styles.modalKav}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View style={embedded ? styles.embeddedOverlay : styles.overlay}>
        {embedded ? null : <AppPressable style={styles.backdrop} onPress={onClose} />}
        <View style={embedded ? styles.embeddedContainer : styles.container}>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.sheetScrollContent}
              >
                <View style={styles.header}>
                  <Text style={styles.title}>Мои профили</Text>
                  <AppPressable onPress={onClose} hitSlop={12}>
                    <Ionicons name="close" size={26} color={colors.text} />
                  </AppPressable>
                </View>
                <Text style={styles.subtitle}>
                  Один секретный набор слов — разные идентификаторы. История чатов привязана к активному профилю;
                  при переключении показываются только чаты этого профиля.
                </Text>

                {profiles.map((profile) => (
                  <View key={profile.id} style={styles.profileRow}>
                    <AppPressable
                      style={[
                        styles.profileItem,
                        activeProfile?.id === profile.id && styles.activeProfileItem,
                      ]}
                      onPress={() => void handleSwitch(profile)}
                    >
                      <Ionicons name="person-circle" size={40} color={colors.accent} />
                      <View style={styles.profileInfo}>
                        <Text
                          style={[
                            styles.profileName,
                            activeProfile?.id === profile.id && styles.activeProfileName,
                          ]}
                        >{profile.name}</Text>
                        <Text
                          style={[
                            styles.profileDid,
                            activeProfile?.id === profile.id && styles.activeProfileDid,
                          ]}
                          numberOfLines={1}
                        >
                          Ваш адрес: {shortIdentity(profile.did, 14)}
                        </Text>
                      </View>
                      {activeProfile?.id === profile.id ? (
                        <Ionicons name="checkmark-circle" size={24} color={colors.accent} />
                      ) : (
                        <Ionicons name="ellipse-outline" size={22} color={colors.textMuted} />
                      )}
                    </AppPressable>
                    <View style={styles.rowActions}>
                      <AppPressable onPress={() => openRename(profile)} hitSlop={8}>
                        <Text style={styles.link}>Переименовать</Text>
                      </AppPressable>
                      {profiles.length > 1 ? (
                        <AppPressable onPress={() => confirmDelete(profile)} hitSlop={8} style={styles.deleteBtn}>
                          <Text style={styles.linkDanger}>Удалить</Text>
                        </AppPressable>
                      ) : null}
                    </View>
                  </View>
                ))}

                <View style={styles.divider} />

                {/* v4.32.22: лимит 4 профиля на устройстве. Когда достигнут —
                    форма создания скрыта, показываем only info. */}
                {profiles.length >= MAX_PROFILES ? (
                  <Text style={styles.limitNote}>
                    Достигнут лимит профилей на устройстве: {MAX_PROFILES}.{"\n"}
                    Удалите один из существующих, чтобы создать новый.
                  </Text>
                ) : (
                  <>
                    <Text style={styles.sectionTitle}>Новый профиль</Text>
                    <Text style={styles.slotsCounter}>
                      Занято {profiles.length} из {MAX_PROFILES}
                    </Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Название"
                      placeholderTextColor={colors.textMuted}
                      value={newProfileName}
                      onChangeText={setNewProfileName}
                      editable={!isCreating}
                    />
                    <AppPressable
                      style={[styles.createButton, isCreating && styles.disabledButton]}
                      onPress={() => void handleAddProfile()}
                      disabled={isCreating}
                    >
                      {isCreating ? (
                        <ActivityIndicator color={primaryInk(colors).text} />
                      ) : (
                        <Text style={styles.createButtonText}>Создать профиль</Text>
                      )}
                    </AppPressable>
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
  );

  return (
    <>
      {embedded
        ? (visible ? sheetContent : null)
        : (
          <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            {sheetContent}
          </Modal>
        )}

      <Modal visible={renameId !== null} transparent animationType="fade" onRequestClose={() => setRenameId(null)}>
        {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
        <KeyboardAvoidingView
          style={styles.renameKav}
          behavior="padding"
          keyboardVerticalOffset={0}
        >
          <View style={styles.renameOverlay}>
            <View style={styles.renameBox}>
              <Text style={styles.renameTitle}>Имя профиля</Text>
              <TextInput
                style={styles.input}
                value={renameText}
                onChangeText={setRenameText}
                placeholderTextColor={colors.textMuted}
                autoFocus
              />
              <View style={styles.renameBtns}>
                <AppPressable style={[styles.renameCancel, { marginRight: 12 }]} onPress={() => setRenameId(null)}>
                  <Text style={styles.renameCancelText}>Отмена</Text>
                </AppPressable>
                <AppPressable style={[styles.createButton, { flex: 1 }]} onPress={() => void submitRename()}>
                  <Text style={styles.createButtonText}>Сохранить</Text>
                </AppPressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

