import React, { useCallback, useEffect, useState } from 'react';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import {
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { publicKeyToDidKey } from '../../core/identity/did';
import { buildSignedProfile } from '../../core/identity/profile';
import { log } from '../../core/logger';
import { profileManager } from '../../core/identity/profileManager';
import { OWN_DISPLAY_NAME_KEY, OWN_DISPLAY_NAME_MAX, ownFieldSet, stripOwnDisplayName } from '../../core/identity/ownProfile';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { showError } from '../components/userFeedback';
import { SafeScreen } from '../components/SafeScreen';
import { useColors, useThemedStyles } from '../ThemeContext';
import { primaryInk, radius } from '../theme';
import { shortIdentity } from '../identity/shortId';
import { rawErrorText } from '../components/userErrorText';

type Props = {
  /** Keys from onboarding / boot (avoids regenerating). */
  pair: KeyPairBytes;
  onDone: (username: string, did: string) => void;
};

export function LoginScreen({ pair: pairProp, onDone }: Props): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEv, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEv, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const init = useCallback(async () => {
    // v4.32.74: имя пользователя — обязательное поле при регистрации.
    // Раньше пустое поле молча превращалось в "anonymous"; это было плохо
    // для UX (в списках контактов/ленте показывался загадочный "anonymous")
    // и для идентификации аккаунта. Теперь пустое имя блокируется с явным
    // сообщением, кнопка disabled пока trim пустой.
    // v4.32.287: очистка та же, что на экране профиля, — одной функцией.
    // Раньше здесь стояла только проверка длины (комментарий утверждал
    // обратное), и через регистрацию в имя проходили zero-width и
    // RTL-override, а оттуда — контактам и в группы.
    const uname = stripOwnDisplayName(username);
    if (!uname) {
      showError('Введите имя пользователя');
      return;
    }
    if (uname.length > OWN_DISPLAY_NAME_MAX) {
      showError(`Имя слишком длинное (макс. ${OWN_DISPLAY_NAME_MAX} символов)`);
      return;
    }
    setBusy(true);
    try {
      const pair = pairProp;
      const id = publicKeyToDidKey(pair.publicKey);
      setDid(id);
      await ownFieldSet(OWN_DISPLAY_NAME_KEY, uname);
      // v4.32.75: переименовываем активный профиль в только что введённое имя.
      // Без этого на fresh-install/re-import profileManager создавал профиль с
      // дефолтным именем «Личный» (см. profileManager.ts:192), и под таб-баром
      // (activeProfileLabel) показывалось «Личный» вместо имени пользователя.
      // При последующем переключении между аккаунтами показывается имя каждого
      // конкретного профиля (обновляется через identity-effect в App.tsx:365/375).
      try {
        await profileManager.init();
        const active = profileManager.getActiveProfile();
        if (active && active.name.trim().toLowerCase() !== uname.toLowerCase()) {
          await profileManager.renameProfile(active.id, uname);
        }
      } catch (e) {
        // Не блокирующая операция — если что-то пошло не так, user_username
        // остаётся корректным, под таб-баром покажется fallback (username).
        log.warn('login_profile_rename_failed', {
          err: rawErrorText(e),
        });
      }
      // Не ждать IPFS: kubo add может зависать на части устройств — без перехода на Main нет auto_test_identity / тестов.
      onDone(uname, id);
      void (async () => {
        try {
          const { cid } = await buildSignedProfile(pair, uname);
          if (cid) await ownFieldSet('user_profile_cid', cid);
        } catch (e) {
          log.warn('login_profile_publish_failed', {
            err: rawErrorText(e),
          });
        }
      })();
    } catch (e) {
      const msg = rawErrorText(e);
      log.error('login_init_failed', { err: msg });
      showError(msg);
    } finally {
      setBusy(false);
    }
  }, [onDone, username, pairProp]);

  const keyboardVerticalOffset = Platform.OS === 'ios' ? insets.top : 0;

  const initBtn = useAsyncButton(init, { throttleMs: 300 });
  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    keyboardView: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      justifyContent: 'center' as const,
      paddingHorizontal: 24,
      paddingVertical: 40,
    },
    /** Без центрирования при открытой клавиатуре — иначе поле и кнопка оказываются под IME. */
    scrollContentKeyboardOpen: {
      justifyContent: 'flex-start' as const,
      paddingTop: 16,
    },
    // v4.32.41: у карточки нет своего фона — она не должна отличаться по оттенку
    // от фона экрана. Раньше #212d3b рисовал видимый прямоугольник на тёмно-синем
    // фоне — пользователь жаловался: «прямоугольник отличается по оттенку».
    inner: {
      // прозрачный — наследует фон SafeScreen
    },
    title: { fontSize: 28, fontWeight: '700' as const, color: c.text, marginBottom: 8 },
    sub: { color: c.textSecondary, marginBottom: 16 },
    did: { color: c.accent, fontSize: 12, marginBottom: 12 },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: 12,
      color: c.text,
      marginBottom: 16,
      // Поле чуть отличается от фона экрана — чтобы его было видно, но без
      // грубого контраста, который выделял бы всю карточку.
      backgroundColor: c.surface,
    },
    btn: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.md,
      alignItems: 'center' as const,
    },
    btnDisabled: { opacity: 0.4 },
    btnText: { color: primaryInk(c).text, fontWeight: '600' as const },
  }));

  return (
    <SafeScreen edges={['top', 'bottom', 'left', 'right']} backgroundColor={colors.background}>
      {/* v4.32.102 K.8: корневой KAV — на Android adjustResize уже работает, behavior=undefined чтобы избежать двойной компенсации */}
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            keyboardVisible ? styles.scrollContentKeyboardOpen : null,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.inner} testID="login_screen">
            <Text style={styles.title}>AirChat</Text>
            <Text style={styles.sub}>Ключи на месте. Осталось имя, под которым вас увидят собеседники — его можно поменять в профиле.</Text>
            {did ? (
              <Text style={styles.did} testID="user_did">
                Ваш адрес: {shortIdentity(did, 20)}
              </Text>
            ) : null}
            <TextInput
              placeholder="Имя"
              placeholderTextColor={colors.textMuted}
              value={username}
              onChangeText={setUsername}
              style={styles.input}
              autoCapitalize="none"
              testID="login_username_input"
            />
            <AppPressable
              style={[styles.btn, (!username.trim() || initBtn.loading) ? styles.btnDisabled : null]}
              onPress={initBtn.onPress}
              disabled={initBtn.loading || !username.trim()}
              testID="btn_login"
            >
              <Text style={styles.btnText}>Создать / войти</Text>
            </AppPressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <LoadingOverlay visible={busy} message="Вход…" />
    </SafeScreen>
  );
}
