/**
 * ProfileEditModal — отдельный раздел «Редактировать профиль» (v4.32.572).
 *
 * Раньше свой профиль правился прямо на карточке: карандаш возле имени,
 * карандаш возле юзернейма, карандаш возле местоимений, отдельное окно для
 * статуса, ещё одно для ссылок и нажатие на «О себе», превращавшее строку в
 * поле ввода. Шесть редакторов, шесть состояний «сейчас редактируется» и
 * шесть пар кнопок «Отмена/Сохранить» — и ни одного места, где всё это
 * называлось бы одним словом. Человек, зашедший «поправить профиль», правил
 * то, на что случайно нажал.
 *
 * Теперь редактор один, и он здесь: имя, юзернейм, местоимения, статус,
 * «О себе», ссылки и фотография — на одном экране, с одной кнопкой
 * «Сохранить».
 *
 * Окно само читает и само пишет, а не получает значения пропами: его
 * открывают из двух мест — с вкладки «Профиль» и из карточки своего профиля,
 * — и передавать в него семь полей и семь обработчиков дважды значило бы
 * держать два списка полей, которые обязаны совпадать. Совпадать они
 * перестают в первый же день.
 *
 * Пишется ровно то, что изменили: `saveOwnUsernameGlobally` ходит в реестр по
 * сети, а `broadcastMyProfile` рассылает карточку контактам — делать это
 * из-за нетронутого поля значит слать людям сообщение о том, что ничего не
 * произошло.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';

import { AppModal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { GlassSurface } from '../../GlassSurface';
import { KeyboardHost } from '../../KeyboardHost';
import { SafeScreen } from '../../SafeScreen';
import { VerifiedMark } from '../../VerifiedMark';
import { showError, showSuccess } from '../../userFeedback';
import { userErrorText } from '../../userErrorText';
import { useColors } from '../../../ThemeContext';
import { font, glass, radius, spacing, withAlpha } from '../../../theme';
import {
  PRONOUNS_MAX,
  profileCompletionPct,
  usernameClaimErrorText,
  usernameSavedText,
  usernameSaveErrorText,
} from './ownProfileEditModel';
import {
  OWN_DISPLAY_NAME_KEY,
  getOwnDisplayName,
  getOwnUsername,
  ownFieldGet,
  ownFieldSet,
  sanitizeOwnDisplayName,
} from '../../../../core/identity/ownProfile';
import { checkUsernameClaim } from '../../../../core/identity/reservedUsernames';
import { saveOwnUsernameGlobally } from '../../../../core/identity/usernameRegistry';
import { applyOwnBadgeGrant, ownBadgeClaim } from '../../../../core/identity/ownBadge';
import type { VerificationClaim } from '../../../../core/identity/verification';
import { ownAvatarUri, saveOwnAvatar } from '../../../../core/identity/ownAvatar';
import { refreshAvatarTable } from '../../../../core/social/avatarRegistry';
import { broadcastMyProfile, markProfileChanged } from '../../../../core/social/profileSync';
import { republishProfileFromKv } from '../../../../core/identity/profile';
import { profileManager } from '../../../../core/identity/profileManager';
import { loadKeyPair } from '../../../../core/crypto/keyManager';
import { sanitizeDisplayName } from '../../../../core/social/sysLineGuard';
import { normalizeOwnBio, OWN_BIO_MAX } from '../../../../core/social/profileEnvelope';
import { MAX_CUSTOM_STATUS_LEN, normalizeOwnStatus } from '../../../../core/social/peerStatus';

const cleanPronouns = (v: unknown): string => sanitizeDisplayName(v, PRONOUNS_MAX) ?? '';
const cleanLink = (s: string): string => (sanitizeDisplayName(s, 256) ?? '').trim();

export interface ProfileEditModalProps {
  visible: boolean;
  onClose: () => void;
  /** Профиль сохранён: вызывающему экрану пора перечитать поля. */
  onSaved?: (displayName: string) => void;
}

type Loaded = {
  name: string;
  handle: string;
  pronouns: string;
  status: string;
  bio: string;
  website: string;
  twitter: string;
  github: string;
};

const EMPTY: Loaded = {
  name: '', handle: '', pronouns: '', status: '', bio: '', website: '', twitter: '', github: '',
};

export function ProfileEditModal({
  visible,
  onClose,
  onSaved,
}: ProfileEditModalProps): React.ReactElement | null {
  const colors = useColors();
  const [saved, setSaved] = useState<Loaded>(EMPTY);
  const [draft, setDraft] = useState<Loaded>(EMPTY);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [badge, setBadge] = useState<VerificationClaim | null>(null);
  const [busy, setBusy] = useState(false);

  // Читается на каждое открытие: между открытиями профиль мог измениться и с
  // другого устройства, и из другого профиля этого же телефона.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      const [name, handle, pronouns, status, bio, website, twitter, github, face, claim] =
        await Promise.all([
          getOwnDisplayName(),
          getOwnUsername(),
          ownFieldGet('user_pronouns'),
          ownFieldGet('user_custom_status'),
          ownFieldGet('user_bio'),
          ownFieldGet('user_website'),
          ownFieldGet('user_twitter'),
          ownFieldGet('user_github'),
          ownAvatarUri(),
          ownBadgeClaim(),
        ]);
      if (!alive) return;
      const next: Loaded = {
        name: name ?? '',
        handle: handle ?? '',
        pronouns: cleanPronouns(pronouns),
        status: normalizeOwnStatus(status),
        bio: normalizeOwnBio(bio),
        website: website ?? '',
        twitter: twitter ?? '',
        github: github ?? '',
      };
      setSaved(next);
      setDraft(next);
      setAvatar(face ?? null);
      setBadge(claim);
    })();
    return () => { alive = false; };
  }, [visible]);

  const completion = profileCompletionPct({
    name: draft.name,
    bio: draft.bio,
    avatar: !!avatar,
    handle: draft.handle,
    status: draft.status,
    pronouns: draft.pronouns,
    links: `${draft.website}${draft.twitter}${draft.github}`,
  });

  /**
   * Разослать профиль контактам личными сообщениями (v4.32.247): единственный
   * путь, который работает на телефоне — IPFS там выключен.
   */
  const publish = useCallback(async (): Promise<void> => {
    try {
      await markProfileChanged();
      await broadcastMyProfile();
    } catch {
      /* офлайн — разошлётся при следующем запуске */
    }
  }, []);

  const pickAvatar = useCallback(async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('AirChat', 'Нужен доступ к галерее для выбора фото профиля.');
      return;
    }
    // v4.32.54: quality:1 + exif:false избегает NoSuchMethodError в CompressionImageExporter.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const rawUri = result.assets[0].uri;
    if (!rawUri || typeof rawUri !== 'string') {
      Alert.alert('AirChat', 'Не удалось получить изображение');
      return;
    }
    // v4.32.175: resize до 512×512 + jpeg 85% (OOM guard). v4.32.180: при
    // отказе manipulateAsync временный URI не сохраняем — после перезапуска он
    // нечитаем, и человек увидел бы пустой кружок вместо «сохранённого» фото.
    let resizedUri: string;
    try {
      const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');
      const resized = await manipulateAsync(rawUri, [{ resize: { width: 512 } }], {
        compress: 0.85,
        format: SaveFormat.JPEG,
      });
      resizedUri = resized.uri;
    } catch (e) {
      console.warn('avatar_resize_failed', e);
      Alert.alert('AirChat', 'Не удалось обработать изображение (неподдерживаемый формат?)');
      return;
    }
    const finalUri = await saveOwnAvatar(resizedUri);
    if (!finalUri) {
      Alert.alert('AirChat', 'Не удалось сохранить фото профиля');
      return;
    }
    setAvatar(finalUri);
    // v4.32.565: реестр лиц слушает контакты, а своё лицо — не контакт.
    void refreshAvatarTable();
    void publish();
    showSuccess('Фото профиля обновлено');
  }, [publish]);

  const pasteBadge = useCallback(async (): Promise<void> => {
    try {
      const raw = (await Clipboard.getStringAsync())?.trim();
      if (!raw) { showError('Буфер обмена пуст'); return; }
      const claim = await applyOwnBadgeGrant(raw);
      if (!claim) {
        showError('Это подтверждение выдано не вашему аккаунту или испорчено');
        return;
      }
      setBadge(claim);
      await markProfileChanged();
      void broadcastMyProfile();
      showSuccess(claim.username === draft.handle
        ? 'Аккаунт подтверждён'
        : `Подтверждение принято на @${claim.username} — займите этот юзернейм, чтобы галочка появилась`);
    } catch (e) {
      showError(userErrorText(e, 'Не удалось прочитать буфер обмена'));
    }
  }, [draft.handle]);

  /**
   * Сохранить изменённое.
   *
   * Порядок важен только в одном месте: юзернейм может не сохраниться (занят,
   * оставлен приложению, реестр недоступен), и тогда окно остаётся открытым —
   * человеку есть что исправить. Остальные поля к этому моменту уже записаны,
   * и это правильно: терять набранное «О себе» из-за спора о юзернейме не за
   * что.
   */
  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      let touchedProfile = false;

      const name = sanitizeOwnDisplayName(draft.name);
      if (!name) {
        showError('Имя не может быть пустым');
        return;
      }
      if (name !== saved.name) {
        await ownFieldSet(OWN_DISPLAY_NAME_KEY, name);
        await profileManager.init();
        const ap = profileManager.getActiveProfile();
        if (ap) await profileManager.renameProfile(ap.id, name);
        const kp = await loadKeyPair();
        if (kp) void republishProfileFromKv(kp).catch(() => { /* офлайн: облако необязательно */ });
        touchedProfile = true;
      }

      const bio = normalizeOwnBio(draft.bio);
      if (bio !== saved.bio) {
        await ownFieldSet('user_bio', bio);
        const kp = await loadKeyPair();
        if (kp) void republishProfileFromKv(kp).catch(() => { /* офлайн: облако необязательно */ });
        touchedProfile = true;
      }

      const status = normalizeOwnStatus(draft.status);
      if (status !== saved.status) {
        await ownFieldSet('user_custom_status', status);
        touchedProfile = true;
      }

      const pronouns = cleanPronouns(draft.pronouns);
      if (pronouns !== saved.pronouns) await ownFieldSet('user_pronouns', pronouns);

      const website = cleanLink(draft.website);
      const twitter = cleanLink(draft.twitter).replace(/^@/, '');
      const github = cleanLink(draft.github).replace(/^@/, '');
      if (website !== saved.website || twitter !== saved.twitter || github !== saved.github) {
        await Promise.all([
          ownFieldSet('user_website', website),
          ownFieldSet('user_twitter', twitter),
          ownFieldSet('user_github', github),
        ]);
      }

      let handle = saved.handle;
      const wanted = draft.handle.trim().replace(/^@/, '').toLowerCase();
      if (wanted !== saved.handle) {
        // v4.32.547: второй аргумент — имя из своей бумаги: только оно проходит
        // мимо списка оставленных приложению имён.
        const claim = checkUsernameClaim(wanted, badge?.username);
        if (!claim.ok) {
          showError(usernameClaimErrorText(claim.reason));
          setSaved({ ...saved, name, bio, status, pronouns, website, twitter, github });
          return;
        }
        // v4.32.543: имя занимается в общем реестре, а не только среди
        // профилей этого телефона.
        const done = await saveOwnUsernameGlobally(claim.username);
        if (!done.ok) {
          showError(usernameSaveErrorText(done.reason));
          setSaved({ ...saved, name, bio, status, pronouns, website, twitter, github });
          return;
        }
        handle = claim.username;
        touchedProfile = true;
        showSuccess(usernameSavedText(done.scope));
      }

      const next: Loaded = { name, handle, pronouns, status, bio, website, twitter, github };
      setSaved(next);
      setDraft(next);
      if (touchedProfile) void publish();
      onSaved?.(name);
      if (!handle || handle === saved.handle) showSuccess('Профиль сохранён');
      onClose();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось сохранить профиль'));
    } finally {
      setBusy(false);
    }
  }, [draft, saved, badge, publish, onSaved, onClose]);

  if (!visible) return null;

  const fieldStyle = [styles.input, { color: colors.text, borderColor: colors.border }];
  const set = (patch: Partial<Loaded>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <AppModal visible animationType="slide" onRequestClose={onClose} testID="profile_edit_modal">
      <KeyboardHost variant="modal">
        <SafeScreen
          edges={['top', 'left', 'right']}
          backgroundColor={colors.background}
          style={styles.screen}
        >
          {/* Шапка — стекло: под ней проезжает содержимое, и глухая полоса
              отрезала бы его, вместо того чтобы показать, что оно уходит. */}
          <GlassSurface style={styles.header} variant="regular" wash>
            <AppPressable onPress={onClose} hitSlop={8} accessibilityLabel="Отмена">
              <Text style={[styles.headerSide, { color: colors.textSecondary }]}>Отмена</Text>
            </AppPressable>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Редактировать профиль</Text>
            <AppPressable
              onPress={() => void save()}
              disabled={busy}
              hitSlop={8}
              accessibilityLabel="Сохранить"
              testID="profile_edit_save"
            >
              <Text style={[styles.headerSave, { color: busy ? colors.textSecondary : colors.accent }]}>
                {busy ? '…' : 'Сохранить'}
              </Text>
            </AppPressable>
          </GlassSurface>

          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.avatarBox}>
              <AppPressable
                style={[styles.avatar, { backgroundColor: colors.surface, borderColor: colors.border }]}
                onPress={() => void pickAvatar()}
                testID="profile_edit_avatar"
                accessibilityLabel="Изменить фото профиля"
              >
                {avatar ? (
                  <Image source={{ uri: avatar }} style={styles.avatarImage} />
                ) : (
                  <Ionicons name="person" size={44} color={colors.accent} />
                )}
              </AppPressable>
              <AppPressable onPress={() => void pickAvatar()} hitSlop={8}>
                <Text style={[styles.avatarAction, { color: colors.accent }]}>
                  {avatar ? 'Изменить фото' : 'Добавить фото'}
                </Text>
              </AppPressable>
              <View style={[styles.meter, { backgroundColor: colors.border }]}>
                <View
                  style={[styles.meterFill, { width: `${completion}%`, backgroundColor: colors.primary }]}
                />
              </View>
              <Text style={[styles.meterLabel, { color: colors.textSecondary }]}>
                Профиль заполнен на {completion}%
              </Text>
            </View>

            <Text style={[styles.label, { color: colors.textSecondary }]}>Имя</Text>
            <TextInput
              style={fieldStyle}
              value={draft.name}
              onChangeText={(v) => set({ name: v })}
              placeholder="Ваше имя"
              placeholderTextColor={colors.textSecondary}
              testID="profile_edit_name"
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>Юзернейм</Text>
            <View style={[styles.handleBox, { borderColor: colors.border }]}>
              <Text style={[styles.handleAt, { color: colors.textSecondary }]}>@</Text>
              <TextInput
                style={[styles.handleInput, { color: colors.text }]}
                value={draft.handle}
                onChangeText={(v) => set({ handle: v.replace(/^@/, '').toLowerCase() })}
                placeholder="username"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={32}
                testID="profile_edit_handle"
              />
              {badge && badge.username === draft.handle ? (
                <VerifiedMark size={15} label="Официальный аккаунт" />
              ) : null}
            </View>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              По нему вас находят и узнают. Латиница, цифры и «_».
            </Text>

            <Text style={[styles.label, { color: colors.textSecondary }]}>Местоимения</Text>
            <TextInput
              style={fieldStyle}
              value={draft.pronouns}
              onChangeText={(v) => set({ pronouns: v })}
              placeholder="он/его, она/её, они/их…"
              placeholderTextColor={colors.textSecondary}
              maxLength={PRONOUNS_MAX}
              testID="profile_edit_pronouns"
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>Статус</Text>
            <TextInput
              style={fieldStyle}
              value={draft.status}
              onChangeText={(v) => set({ status: v })}
              placeholder="💬 Что у вас нового?"
              placeholderTextColor={colors.textSecondary}
              maxLength={MAX_CUSTOM_STATUS_LEN}
              testID="profile_edit_status"
            />
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              Виден контактам под вашим именем.
            </Text>

            <Text style={[styles.label, { color: colors.textSecondary }]}>О себе</Text>
            <TextInput
              style={[...fieldStyle, styles.bio]}
              value={draft.bio}
              onChangeText={(v) => set({ bio: v })}
              placeholder="Расскажите о себе…"
              placeholderTextColor={colors.textSecondary}
              multiline
              maxLength={OWN_BIO_MAX}
              testID="profile_edit_bio"
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>Ссылки</Text>
            <TextInput
              style={fieldStyle}
              value={draft.website}
              onChangeText={(v) => set({ website: v })}
              placeholder="https://example.com"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              testID="profile_edit_website"
            />
            <TextInput
              style={[...fieldStyle, styles.stacked]}
              value={draft.twitter}
              onChangeText={(v) => set({ twitter: v })}
              placeholder="@username в X"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              testID="profile_edit_twitter"
            />
            <TextInput
              style={[...fieldStyle, styles.stacked]}
              value={draft.github}
              onChangeText={(v) => set({ github: v })}
              placeholder="username на GitHub"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              testID="profile_edit_github"
            />

            {/* v4.32.547: бумага на галочку принимается из буфера — строка
                длинная, руками её никто не набирает. Показывается, только
                пока бумаги нет: у подтверждённого аккаунта она превратилась бы
                в приглашение сменить подтверждение, а такого действия нет. */}
            {badge ? null : (
              <AppPressable
                style={[styles.badgeRow, { borderColor: colors.border }]}
                onPress={() => void pasteBadge()}
                testID="profile_edit_badge_paste"
              >
                <Ionicons name="shield-checkmark-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
                  Вставить подтверждение аккаунта
                </Text>
              </AppPressable>
            )}
          </ScrollView>
        </SafeScreen>
      </KeyboardHost>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerSide: { fontSize: font.md },
  headerTitle: { fontSize: font.md, fontWeight: '700', flex: 1, textAlign: 'center' },
  headerSave: { fontSize: font.md, fontWeight: '700' },
  body: { padding: spacing.md, paddingBottom: spacing.xl },
  avatarBox: { alignItems: 'center', gap: spacing.xs, marginBottom: spacing.md },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarAction: { fontSize: font.sm, fontWeight: '600' },
  meter: { height: 4, borderRadius: radius.full, alignSelf: 'stretch', overflow: 'hidden', marginTop: spacing.sm },
  meterFill: { height: 4, borderRadius: radius.full },
  meterLabel: { fontSize: font.xs },
  label: {
    fontSize: font.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: font.md,
  },
  stacked: { marginTop: spacing.xs },
  bio: { minHeight: 96, textAlignVertical: 'top' },
  handleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
  },
  handleAt: { fontSize: font.md },
  handleInput: { flex: 1, paddingVertical: spacing.sm, fontSize: font.md },
  hint: { fontSize: font.xs, marginTop: spacing.xs },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: withAlpha(glass.shadeInk, glass.shade),
  },
  badgeText: { fontSize: font.sm },
});

export default ProfileEditModal;
