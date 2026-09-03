import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { useTabRef } from '../TabRefContext';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  Share,
  Image,
  KeyboardAvoidingView,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { AppModal as Modal } from '../components/AppModal';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { appleColorEmojiTextStyle } from '../emojiStyles';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import QRCode from 'react-native-qrcode-svg';
import { runSyncIfOnline } from '../../core/storage/sync';
import { ipfsId } from '../../core/transport/ipfs/node';
import { deleteContact, listContacts, subscribeContactsChanged } from '../../core/social/contacts';
import { ContactsScreen } from './ContactsScreen';
import { LOCAL_RADIO_TRANSPORTS_AVAILABLE } from '../platformCapabilities';
import { loadFeedPosts } from '../../core/social/feedService';
import {
  exportEncryptedBackup,
  getStoredMnemonic,
  hasStoredMnemonic,
} from '../../core/backup/seedPhrase';
import { listStarredMessages, setMessageStarred, setGroupMessageStarred, getProfileStats, type StarredMessageEntry, type ProfileStats } from '../../core/storage/local';
import { approxCountLabel, approxCountNotice } from '../../core/storage/approxCount';
import { isUnreadableMessage, UNREADABLE_MESSAGE_TEXT } from '../../core/storage/unreadableText';
import { clearCallLog, getCallLog, subscribeCallLog, type CallLogEntry } from '../../core/social/callService';
import { loadKeyPair } from '../../core/crypto/keyManager';
import { profileManager } from '../../core/identity/profileManager';
import { republishProfileFromKv } from '../../core/identity/profile';
import { OWN_DISPLAY_NAME_KEY, getOwnDisplayName, getOwnUsername, ownFieldGet, ownFieldSet, sanitizeOwnDisplayName } from '../../core/identity/ownProfile';
import { checkUsernameClaim, USERNAME_MIN_SELF_SERVICE } from '../../core/identity/reservedUsernames';
import { applyOwnBadgeGrant, ownBadgeClaim } from '../../core/identity/ownBadge';
import type { VerificationClaim } from '../../core/identity/verification';
import { saveOwnUsernameGlobally } from '../../core/identity/usernameRegistry';
import { sanitizeDisplayName } from '../../core/social/sysLineGuard';
import { MAX_CUSTOM_STATUS_LEN, normalizeOwnStatus } from '../../core/social/peerStatus';
import { OWN_BIO_MAX, normalizeOwnBio } from '../../core/social/profileEnvelope';
import { ownAvatarUri, saveOwnAvatar } from '../../core/identity/ownAvatar';
import { broadcastMyProfile, markProfileChanged } from '../../core/social/profileSync';
import { authGuard } from '../../core/security/authGuard';
import {
  SENSITIVE_NO_PASSWORD_TEXT,
  unlockSensitiveAccess,
} from '../../core/security/sensitiveAccess';
import { VerifiedMark } from '../components/VerifiedMark';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { SafeScreen } from '../components/SafeScreen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WallpaperBackground } from '../components/WallpaperBackground';
import { defaultWallpaper, feedGround } from '../wallpapers';
import { showError, showPasswordRejected, showSuccess } from '../components/userFeedback';
import { accentOnFill, avatarShape, BRAND_X, font, inkOn, primaryInk, QR_CODE, radius, scrim, spacing, type AppColors } from '../theme';
import { useTheme, useScaledFont } from '../ThemeContext';
import { useTabBarInset } from '../TabBarInset';
import { safeExternalUrl } from '../../core/net/externalLink';
import { openExternal, openTypedExternal } from '../utils/openExternal';
import { formatSpokenDuration } from '../time/durationLabel';
import { shortIdentity } from '../identity/shortId';
import { dayMonthShort, dayMonthShortTime } from '../../core/time/ruDateTime';
import { userErrorText } from '../components/userErrorText';
import { COPY_ID_ACTION, COPIED_ID } from '../clipboardText';

/**
 * Разбивает биографию на куски так, чтобы кандидаты в ссылки шли отдельными
 * элементами. Кандидат — ещё не ссылка: решает `safeExternalUrl`.
 */
function splitBioParts(bio: string): string[] {
  return bio.split(/(\S+:\/\/\S+)/g);
}

type Props = {
  did: string;
  /** v4.32.31: пара ключей нужна ContactsScreen для addContact (ECDH shared secret). */
  pair?: import('../../core/crypto/keyManager').KeyPairBytes;
  onOpenSettings?: () => void;
  multiProfileEnabled?: boolean;
  onOpenProfiles?: () => void;
  activeProfileName?: string | null;
  /** После сохранения отображаемого имени — обновить заголовок и т.д. */
  onDisplayNameChanged?: (name: string) => void;
  /** v4.32.30: открыть DM с контактом. Переключает таб на chat и прыгает на нужный peer. */
  onOpenChatWithPeer?: (peerPublicKey: string) => void;
};

/**
 * Местоимения: строка в одну строчку под именем. Дальше своего устройства не
 * уезжают, поэтому правило живёт здесь, а не в конверте профиля — но чистка
 * нужна и им: строка рисуется рядом с именем, и подделать её вид можно ровно
 * теми же невидимыми метками (v4.32.378). Стоит и на чтении: записанное
 * прежним редактором чистить некому.
 */
const PRONOUNS_MAX = 30;
const cleanPronouns = (v: unknown): string => sanitizeDisplayName(v, PRONOUNS_MAX) ?? '';

const appVersion =
  Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '1.0.0';

function ProfileScreenImpl({
  did,
  pair,
  onOpenSettings,
  multiProfileEnabled,
  onOpenProfiles,
  activeProfileName,
  onDisplayNameChanged,
  onOpenChatWithPeer,
}: Props): React.ReactElement {
  // v4.32.16: gate через tabRef из Context; prop isActive удалён — React.memo bail-out.
  const tabRef = useTabRef();
  const { colors, scheme } = useTheme();
  // v4.32.540: отступ под часы — теперь дело экрана, а не оболочки (см. App.tsx).
  const insets = useSafeAreaInsets();
  // v4.32.573: постоянный идентификатор аккаунта с экрана убран. Он никуда не
  // делся и по-прежнему выводится из ключа, но человеку показывать его незачем:
  // сверяют собеседника по адресу для связи ниже, а ссылка на аккаунт нужна
  // коду — она читается через core/identity/accountRef.
  // v4.32.540: у профиля появился фон. Это тот же слой, что под перепиской, и
  // тот же пресет по умолчанию — «aurora» в тёмной теме, «daylight» в светлой.
  // Своего выбора у профиля нет умышленно: обои настраиваются у разговора,
  // где их видно за текстом; здесь фон — фирменная подложка, а не настройка,
  // и второй ручкой к тому же предмету он быть не должен.
  const profileWallpaper = useMemo(() => defaultWallpaper(scheme), [scheme]);
  const profileGround = useMemo(
    () => feedGround(colors, profileWallpaper),
    [colors, profileWallpaper],
  );
  const scaleFont = useScaledFont();
  const tabInset = useTabBarInset();
  const styles = useMemo(() => makeStyles(colors, scaleFont), [colors, scaleFont]);
  const [displayName, setDisplayName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameDraft, setEditNameDraft] = useState('');
  const [bio, setBio] = useState('');
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [editBioDraft, setEditBioDraft] = useState('');
  const [handle, setHandle] = useState('');
  /**
   * v4.32.547: своя бумага на официальную галочку — уже проверенная на
   * собственный DID (см. identity/ownBadge). Держим весь разбор, а не одну
   * галочку: имя из бумаги нужно и полю ввода — оно разрешает занять
   * зарезервированное имя, на которое бумага и выдана.
   */
  const [badge, setBadge] = useState<VerificationClaim | null>(null);
  const [isEditingHandle, setIsEditingHandle] = useState(false);
  const [editHandleDraft, setEditHandleDraft] = useState('');
  const [peer, setPeer] = useState<string | null>(null);
  const [seedModal, setSeedModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [starredVisible, setStarredVisible] = useState(false);
  const [starredEntries, setStarredEntries] = useState<StarredMessageEntry[]>([]);
  const [seedWords, setSeedWords] = useState<string[]>([]);
  const [hasSeed, setHasSeed] = useState(false);
  const [exportPwd, setExportPwd] = useState('');
  const [exportModal, setExportModal] = useState(false);
  const [busy, _setBusy] = useState(false);
  const [seedPwdModal, setSeedPwdModal] = useState(false);
  const [seedPwd, setSeedPwd] = useState('');
  const [seedPwdBusy, setSeedPwdBusy] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [postCount, setPostCount] = useState(0);
  const [contactCount, setContactCount] = useState(0);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  // Custom status
  const [customStatus, setCustomStatus] = useState('');
  const [editStatusVisible, setEditStatusVisible] = useState(false);
  const [editStatusDraft, setEditStatusDraft] = useState('');
  const [callLogVisible, setCallLogVisible] = useState(false);
  const [callLogEntries, setCallLogEntries] = useState<CallLogEntry[]>(() => getCallLog());
  /** v4.32.30: список контактов открывается из Профиля в модалке (VK-style «Друзья»). */
  const [contactsVisible, setContactsVisible] = useState(false);
  // Pronouns
  const [pronouns, setPronouns] = useState('');
  const [isEditingPronouns, setIsEditingPronouns] = useState(false);
  const [editPronounsDraft, setEditPronounsDraft] = useState('');
  // Social links
  const [website, setWebsite] = useState('');
  const [twitterHandle, setTwitterHandle] = useState('');
  const [githubHandle, setGithubHandle] = useState('');
  const [socialLinksVisible, setSocialLinksVisible] = useState(false);
  const [websiteDraft, setWebsiteDraft] = useState('');
  const [twitterDraft, setTwitterDraft] = useState('');
  const [githubDraft, setGithubDraft] = useState('');
  // Account age
  const [accountCreatedAt, setAccountCreatedAt] = useState<number | null>(null);

  const shortDid = shortIdentity(did);

  /** 0-100 profile completion score */
  const completionPct = useMemo(() => {
    const fields = [
      !!displayName.trim(),
      !!bio.trim(),
      !!avatarUri,
      !!handle.trim(),
      !!customStatus.trim(),
      !!pronouns.trim(),
      !!(website || twitterHandle || githubHandle),
    ];
    return Math.round((fields.filter(Boolean).length / fields.length) * 100);
  }, [displayName, bio, avatarUri, handle, customStatus, pronouns, website, twitterHandle, githubHandle]);

  const accountAgeLabel = useMemo(() => {
    if (!accountCreatedAt) return null;
    const now = Date.now();
    const diffMs = now - accountCreatedAt;
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 1) return 'Сегодня';
    if (days === 1) return '1 день';
    if (days < 30) return `${days} дн.`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} мес.`;
    const years = Math.floor(months / 12);
    return `${years} г.`;
  }, [accountCreatedAt]);

  const loadDisplayName = useCallback(async (): Promise<void> => {
    const kvName = (await getOwnDisplayName()) ?? '';
    await profileManager.init();
    const ap = profileManager.getActiveProfile();
    const profileName = ap?.name?.trim();
    const initial = multiProfileEnabled
      ? profileName || kvName || ''
      : kvName || profileName || '';
    setDisplayName(initial);
    setEditNameDraft(initial);
  }, [multiProfileEnabled]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const id = await ipfsId();
      if (alive) setPeer(id);
      await runSyncIfOnline();
      setHasSeed(await hasStoredMnemonic());
      await loadDisplayName();
      const savedAvatar = await ownAvatarUri();
      if (alive && savedAvatar) setAvatarUri(savedAvatar);
      // v4.32.378: и на чтении — «О себе», набранное до этой версии, лежит в
      // базе без всякой чистки, а показывается оно здесь как есть.
      const savedBio = normalizeOwnBio(await ownFieldGet('user_bio'));
      if (alive && savedBio) { setBio(savedBio); setEditBioDraft(savedBio); }
      // v4.32.375: чистится и на чтении — в базе лежат строки, набранные
      // прежним редактором в настройках: многострочные и до ста символов.
      const savedStatus = normalizeOwnStatus(await ownFieldGet('user_custom_status'));
      if (alive && savedStatus) setCustomStatus(savedStatus);
      const savedHandle = await getOwnUsername();
      if (alive && savedHandle) { setHandle(savedHandle); setEditHandleDraft(savedHandle); }
      const claim = await ownBadgeClaim();
      if (alive) setBadge(claim);
      const savedPronouns = cleanPronouns(await ownFieldGet('user_pronouns'));
      if (alive && savedPronouns) { setPronouns(savedPronouns); setEditPronounsDraft(savedPronouns); }
      // Social links
      const savedWebsite = await ownFieldGet('user_website');
      const savedTwitter = await ownFieldGet('user_twitter');
      const savedGithub = await ownFieldGet('user_github');
      if (alive) {
        setWebsite(savedWebsite ?? '');
        setTwitterHandle(savedTwitter ?? '');
        setGithubHandle(savedGithub ?? '');
        setWebsiteDraft(savedWebsite ?? '');
        setTwitterDraft(savedTwitter ?? '');
        setGithubDraft(savedGithub ?? '');
      }
      // Account creation date — store on first launch
      let createdAt = await ownFieldGet('account_created_at');
      if (!createdAt) {
        createdAt = String(Date.now());
        await ownFieldSet('account_created_at', createdAt);
      }
      if (alive) setAccountCreatedAt(parseInt(createdAt, 10));
      const pid = profileManager.getActiveProfile()?.id ?? 1;
      const [posts, contacts, profileStats] = await Promise.all([
        loadFeedPosts(200, 0),
        listContacts(),
        getProfileStats(pid),
      ]);
      if (alive) {
        // v4.32.528: чтение не удалось — счётчик публикаций не трогаем. Ноль
        // здесь был бы неправдой: человек увидел бы «0 публикаций» вместо
        // прежнего числа только потому, что база была занята.
        if (posts !== null) setPostCount(posts.filter((p) => p.authorDid === did).length);
        // v4.32.32: one-off migration — если в БД остался self-contact от v4.32.30
        // (когда ChatScreen auto-добавлял «Сохранённые сообщения»), удаляем физически.
        const mine = pair ? Buffer.from(pair.publicKey).toString('base64') : null;
        if (mine && contacts.some((c) => c.peerPublicKey === mine)) {
          try { await deleteContact(mine); } catch { /* ignore */ }
        }
        const realContacts = mine ? contacts.filter((c) => c.peerPublicKey !== mine) : contacts;
        setContactCount(realContacts.length);
        setStats(profileStats);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadDisplayName, pair, did]);

  useEffect(() => {
    void loadDisplayName();
  }, [activeProfileName, loadDisplayName]);

  // Subscribe to call log updates — v4.32.16: подписка 1 раз, gate через tabRef.
  useEffect(() => {
    const unsub = subscribeCallLog((log) => {
      if (tabRef.current !== 'profile') return;
      setCallLogEntries(log);
    });
    return unsub;
  }, [tabRef]);

  // v4.32.32: live-обновление счётчика контактов при add/rename/delete.
  // Без этого контактов можно добавить в модалке, закрыть её, а цифра в карточке
  // «Контакты» на Профиле останется старой до перезагрузки вкладки.
  // v4.32.169: auto-close seed modal after 60s so words don't remain on-screen
  // indefinitely. Also clears the state on unmount/close so re-opening requires
  // re-auth rather than flashing the previous session's words.
  useEffect(() => {
    if (!seedModal) return;
    const t = setTimeout(() => { setSeedModal(false); setSeedWords([]); }, 60_000);
    return () => clearTimeout(t);
  }, [seedModal]);

  useEffect(() => {
    // v4.32.189 (Round-19 #6): alive guard — listContacts resolves after
    // unmount on fast nav, triggering setContactCount on an unmounted
    // component (RN warns and on strict mode is reproducible).
    let alive = true;
    const unsub = subscribeContactsChanged(() => {
      void listContacts().then((contacts) => {
        if (!alive) return;
        const mine = pair ? Buffer.from(pair.publicKey).toString('base64') : null;
        const realContacts = mine ? contacts.filter((c) => c.peerPublicKey !== mine) : contacts;
        setContactCount(realContacts.length);
      });
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [pair]);

  /**
   * v4.32.247: разослать профиль контактам личными сообщениями — единственный
   * путь, который работает на телефоне (IPFS выключен). Сначала отметка
   * «профиль изменён»: по ней получатель отличает новую версию от старой,
   * а отправка идёт по одному разу на версию.
   */
  const publishProfileToContacts = async (): Promise<void> => {
    try {
      await markProfileChanged();
      await broadcastMyProfile();
    } catch {
      /* офлайн — разошлётся при следующем запуске */
    }
  };

  const saveDisplayName = async (): Promise<void> => {
    // v4.32.175: без очистки можно было записать имя в 10 КБ и RTL-override,
    // которые расходились контактам. v4.32.287: правило переехало в
    // core/identity/ownProfile — в LoginScreen стояла лишь проверка длины,
    // хотя здесь было написано, что правила совпадают. Теперь совпадают.
    const trimmed = sanitizeOwnDisplayName(editNameDraft);
    if (!trimmed) {
      showError('Имя не может быть пустым');
      return;
    }
    try {
      await ownFieldSet(OWN_DISPLAY_NAME_KEY, trimmed);
      await profileManager.init();
      const ap = profileManager.getActiveProfile();
      if (ap) {
        await profileManager.renameProfile(ap.id, trimmed);
      }
      const kp = await loadKeyPair();
      if (kp) {
        void republishProfileFromKv(kp).catch(() => {
          /* офлайн: облако необязательно */
        });
      }
      // v4.32.247: рабочий путь до контактов — личное сообщение. republish
      // выше кладёт профиль в IPFS, который на телефоне выключен, поэтому
      // раньше новое имя не узнавал никто.
      void publishProfileToContacts();
      setDisplayName(trimmed);
      setIsEditingName(false);
      onDisplayNameChanged?.(trimmed);
      showSuccess('Имя сохранено');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось сохранить имя'));
    }
  };

  /**
   * v4.32.547: принять бумагу из буфера обмена.
   *
   * Проверка идёт целиком в ownBadge и на собственный DID: чужую бумагу сюда
   * вставить можно, но записана она не будет — галочка привязана к аккаунту, и
   * именно это отличает её от поля, которое каждый ставит себе сам.
   */
  const applyBadgeFromClipboard = async (): Promise<void> => {
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
      showSuccess(claim.username === handle
        ? 'Аккаунт подтверждён'
        : `Подтверждение принято на @${claim.username} — займите этот юзернейм, чтобы галочка появилась`);
    } catch (e) {
      showError(userErrorText(e, 'Не удалось прочитать буфер обмена'));
    }
  };

  const saveHandle = async (): Promise<void> => {
    // v4.32.540: причина отказа называется вслух. Раньше на все случаи была
    // одна строка про занятость, и человек, набравший имя из двух букв, шёл
    // подбирать варианты — получая на каждый тот же ответ.
    // v4.32.547: второй аргумент — имя из своей бумаги. Только оно проходит
    // мимо списка зарезервированных: иначе выданная галочка на `@founder`
    // упиралась бы в тот самый список, который её и охраняет.
    const claim = checkUsernameClaim(editHandleDraft, badge?.username);
    if (!claim.ok) {
      showError(
        claim.reason === 'empty' ? 'Введите юзернейм'
          : claim.reason === 'charset' ? 'Только латиница, цифры и «_» — без пробелов и знаков'
            : claim.reason === 'too_long' ? 'Юзернейм длиннее 32 символов'
              : claim.reason === 'too_short'
                ? `Юзернейм короче ${USERNAME_MIN_SELF_SERVICE} символов — короткие имена оставлены приложению`
                : 'Это имя оставлено приложению: выберите другое',
      );
      return;
    }
    const raw = claim.username;
    // v4.32.543: имя занимается в общем реестре, а не только среди профилей
    // этого телефона. Раньше два незнакомых человека занимали одно `@name`, и
    // получатель конверта не мог сказать, от кого он.
    const saved = await saveOwnUsernameGlobally(raw);
    if (!saved.ok) {
      showError(
        saved.reason === 'taken' ? 'Этот юзернейм уже занят другим человеком'
          : saved.reason === 'rejected' ? 'Реестр не принял это имя: выберите другое'
            : 'Юзернейм уже используется другим аккаунтом или не сохранён',
      );
      return;
    }
    setHandle(raw);
    setIsEditingHandle(false);
    await markProfileChanged();
    void broadcastMyProfile();
    showSuccess(saved.scope === 'global'
      ? 'Юзернейм закреплён за вами'
      : 'Юзернейм сохранён, но реестр недоступен — закрепим при следующем выходе в сеть');
  };

  const saveBio = async (): Promise<void> => {
    // v4.32.378: чистка та же, что на приёме чужого профиля. Без неё хранилось
    // одно, а контактам уезжало другое: вставленная из буфера метка U+202E
    // переворачивала строку у автора на экране и вычищалась у всех остальных.
    const trimmed = normalizeOwnBio(editBioDraft);
    await ownFieldSet('user_bio', trimmed);
    setBio(trimmed);
    setIsEditingBio(false);
    const kp = await loadKeyPair();
    if (kp) void republishProfileFromKv(kp).catch(() => { /* offline ok */ });
    void publishProfileToContacts();
    showSuccess('О себе сохранено');
  };

  const savePronouns = async (): Promise<void> => {
    const trimmed = cleanPronouns(editPronounsDraft);
    await ownFieldSet('user_pronouns', trimmed);
    setPronouns(trimmed);
    setIsEditingPronouns(false);
    showSuccess(trimmed ? 'Местоимения сохранены' : 'Местоимения удалены');
  };

  const saveSocialLinks = async (): Promise<void> => {
    // v4.32.191 (Round-21 #7): cap length 256 + strip C0 control chars so
    // paste of a novel into the field doesn't bloat kvStore or let a \r\n
    // sneak into a rendered link.
    // v4.32.369: чистка общая. Ссылка показывается как текст, и U+202E в ней
    // переворачивает адрес на экране — домен виден один, открывается другой.
    const clean = (s: string): string => (sanitizeDisplayName(s, 256) ?? '').trim();
    const web = clean(websiteDraft);
    const tw = clean(twitterDraft).replace(/^@/, '');
    const gh = clean(githubDraft).replace(/^@/, '');
    await Promise.all([
      ownFieldSet('user_website', web),
      ownFieldSet('user_twitter', tw),
      ownFieldSet('user_github', gh),
    ]);
    setWebsite(web);
    setTwitterHandle(tw);
    setGithubHandle(gh);
    setSocialLinksVisible(false);
    showSuccess('Ссылки сохранены');
  };

  const copyDid = async (): Promise<void> => {
    await Clipboard.setStringAsync(did);
    showSuccess(COPIED_ID);
  };

  const showSeedWordsModal = async (): Promise<void> => {
    const m = await getStoredMnemonic();
    if (!m) return;
    setSeedWords(m.trim().split(/\s+/));
    setSeedModal(true);
  };

  const openSeed = async (): Promise<void> => {
    const ok = await hasStoredMnemonic();
    if (!ok) {
      Alert.alert('AirChat', 'Секретные слова не сохранены на этом устройстве.');
      return;
    }
    // v4.32.548: пароль обязателен. Раньше при незаданном пароле слова
    // показывались сразу — вторая дверь к той же seed-фразе, что и в
    // «Настройки → Резервная копия», см. sensitiveAccess.
    if (!(await authGuard.hasPassword())) {
      Alert.alert('AirChat', SENSITIVE_NO_PASSWORD_TEXT);
      return;
    }
    setSeedPwd('');
    setSeedPwdModal(true);
  };

  const submitSeedPwd = async (): Promise<void> => {
    if (!seedPwd.trim()) {
      showError('Введите пароль');
      return;
    }
    setSeedPwdBusy(true);
    try {
      const result = await unlockSensitiveAccess(seedPwd);
      if (result === 'no_password') {
        Alert.alert('AirChat', SENSITIVE_NO_PASSWORD_TEXT);
        return;
      }
      if (result !== 'ok') {
        await showPasswordRejected();
        return;
      }
      setSeedPwdModal(false);
      setSeedPwd('');
      await showSeedWordsModal();
    } finally {
      setSeedPwdBusy(false);
    }
  };

  const pickAvatar = async (): Promise<void> => {
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
    // v4.32.175: resize до 512×512 + jpeg 85% (OOM guard).
    // v4.32.180 (Round-10 #9): on manipulateAsync failure (HEIC on old Android
    // OEMs, content:// URI from PHPicker), don't silently keep transient URI —
    // it's unreadable after app restart. Show error and bail.
    // Also copy the resized JPEG to app-scoped dir so stable across reinstalls.
    let resizedUri: string;
    try {
      const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');
      const resized = await manipulateAsync(rawUri, [{ resize: { width: 512 } }], { compress: 0.85, format: SaveFormat.JPEG });
      resizedUri = resized.uri;
    } catch (e) {
      console.warn('avatar_resize_failed', e);
      Alert.alert('AirChat', 'Не удалось обработать изображение (неподдерживаемый формат?)');
      return;
    }
    // v4.32.556: копия файла, удаление прежнего и запись в базу — в
    // identity/ownAvatar одним куском. Экран этого знать не должен: правило
    // «что именно считается сохранённой фотографией» одно и на показ, и на
    // рассылку карточки, и на уборку осиротевших файлов.
    //
    // v4.32.309: сохранение могло не лечь (нет ключа шифрования, нет места), а
    // экран отвечал «Фото профиля обновлено» — и при следующем открытии
    // возвращался прежний кружок с буквой, будто человеку показалось.
    const finalUri = await saveOwnAvatar(resizedUri);
    if (!finalUri) {
      Alert.alert('AirChat', 'Не удалось сохранить фото профиля');
      return;
    }
    setAvatarUri(finalUri);
    // v4.32.247: до этой версии фото профиля вообще никуда не уходило —
    // контакты всегда видели кружок с буквой.
    void publishProfileToContacts();
    showSuccess('Фото профиля обновлено');
  };

  const runExport = async (): Promise<void> => {
    if (!exportPwd.trim() || exportPwd.length < 8) {
      Alert.alert('AirChat', 'Пароль не короче 8 символов.');
      return;
    }
    try {
      const json = await exportEncryptedBackup(exportPwd);
      setExportModal(false);
      setExportPwd('');
      await Share.share({ message: json, title: 'Резервная копия AirChat' });
    } catch (e) {
      Alert.alert('AirChat', userErrorText(e, 'Не удалось создать резервную копию'));
    }
  };

  // ── useAsyncButton wrappers — prevent double-tap on async actions ────────────
  const saveNameBtn = useAsyncButton(saveDisplayName, { throttleMs: 300 });
  const copyDidBtn = useAsyncButton(copyDid, { throttleMs: 300 });
  const pickAvatarBtn = useAsyncButton(pickAvatar, { throttleMs: 300 });
  const openSeedBtn = useAsyncButton(openSeed, { throttleMs: 300 });
  const submitSeedPwdBtn = useAsyncButton(submitSeedPwd, { throttleMs: 300 });
  const runExportBtn = useAsyncButton(runExport, { throttleMs: 300 });

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <WallpaperBackground wallpaper={profileWallpaper} ground={profileGround.ground} />
      {/* Лента профиля прозрачна — иначе фон под ней не виден; карточки внутри
          и так залиты своими поверхностями. Отступ под часы уходит в
          contentContainer, а не в контейнер: скроллу нужно уезжать ПОД полосу,
          а не начинаться под ней. */}
      <ScrollView style={[styles.container, { backgroundColor: 'transparent' }]} contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: tabInset + 40 }]} testID="profile_screen">
        <LoadingOverlay visible={busy} message="Обработка…" />

        {multiProfileEnabled && onOpenProfiles ? (
          <View style={styles.profileSwitchGlass}>
          <AppPressable style={styles.profileSwitchCard} onPress={onOpenProfiles}>
            <Ionicons name="person-circle" size={44} color={colors.accent} />
            <View style={styles.profileSwitchBody}>
              <Text style={styles.profileSwitchLabel}>Активный профиль</Text>
              <Text style={styles.profileSwitchName}>{activeProfileName ?? 'Профиль'}</Text>
              <Text style={styles.profileSwitchHint}>Нажмите, чтобы сменить или добавить</Text>
            </View>
            <Ionicons name="chevron-down" size={22} color={colors.textMuted} />
          </AppPressable>
          </View>
        ) : null}

        <View style={styles.avatarSection}>
          <AppPressable
            style={styles.avatarCircle}
            onPress={pickAvatarBtn.onPress}
            testID="avatar_picker"
            accessibilityLabel="Изменить фото профиля"
          >
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
            ) : (
              <Ionicons name="person" size={48} color={colors.accent} />
            )}
            <View style={styles.avatarEditBadge}>
              <Ionicons name="camera" size={14} color={primaryInk(colors).text} />
            </View>
          </AppPressable>
          {isEditingName ? (
            <View style={styles.nameEditBlock}>
              <TextInput
                style={styles.nameInput}
                value={editNameDraft}
                onChangeText={setEditNameDraft}
                autoFocus
                placeholder="Ваше имя"
                placeholderTextColor={colors.textMuted}
                testID="profile_display_name_input"
              />
              <View style={styles.nameEditActions}>
                <AppPressable
                  onPress={() => {
                    setEditNameDraft(displayName);
                    setIsEditingName(false);
                  }}
                >
                  <Text style={styles.nameEditCancel}>Отмена</Text>
                </AppPressable>
                <AppPressable onPress={saveNameBtn.onPress} testID="profile_save_display_name">
                  <Text style={styles.nameEditSave}>Сохранить</Text>
                </AppPressable>
              </View>
            </View>
          ) : (
            <View style={styles.nameRow}>
              <Text style={styles.username} testID="profile_display_name">
                {displayName || 'Без имени'}
              </Text>
              <AppPressable
                onPress={() => {
                  setEditNameDraft(displayName);
                  setIsEditingName(true);
                }}
                hitSlop={8}
                testID="profile_edit_display_name"
              >
                <Ionicons name="create-outline" size={22} color={colors.accent} />
              </AppPressable>
            </View>
          )}
          {/* One canonical username per account */}
          {isEditingHandle ? (
            <View style={styles.handleEditBlock}>
              <Text style={styles.handleAt}>@</Text>
              <TextInput
                style={styles.handleInput}
                value={editHandleDraft.replace(/^@/, '')}
                onChangeText={(t) => setEditHandleDraft(t.replace(/^@/, '').toLowerCase())}
                autoFocus
                placeholder="username"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={32}
                testID="profile_handle_input"
              />
              <AppPressable onPress={() => void saveHandle()} hitSlop={8}>
                <Ionicons name="checkmark" size={20} color={colors.accent} />
              </AppPressable>
              <AppPressable onPress={() => { setEditHandleDraft(handle); setIsEditingHandle(false); }} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </AppPressable>
            </View>
          ) : (
            <AppPressable
              style={styles.handleRow}
              onPress={() => { setEditHandleDraft(handle); setIsEditingHandle(true); }}
              testID="profile_handle"
            >
              <Text style={handle ? styles.handleText : styles.handlePlaceholder}>
                {handle ? `@${handle}` : 'Добавить @юзернейм'}
              </Text>
              {/* Галочка показывается только при совпадении имени с бумагой:
                  переименовавшийся аккаунт контакты видят без неё, и он должен
                  видеть себя так же — иначе он об этом не узнает. */}
              {badge && badge.username === handle ? (
                <VerifiedMark size={15} label="Официальный аккаунт" />
              ) : null}
              <Ionicons name="create-outline" size={16} color={colors.textMuted} style={{ marginLeft: 6 }} />
            </AppPressable>
          )}
          {/*
            v4.32.540: постоянный идентификатор аккаунта. Юзернейм меняют, имя
            и фотографию тем более — а это выводится из ключа и не меняется
            никогда, поэтому по нему собеседник и сверяет, тот ли это человек.
          */}
          {/* Pronouns */}
          {isEditingPronouns ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <TextInput
                style={[styles.handleInput, { flex: 1 }]}
                value={editPronounsDraft}
                onChangeText={setEditPronounsDraft}
                autoFocus
                placeholder="он/его, она/её, они/их…"
                placeholderTextColor={colors.textMuted}
                maxLength={PRONOUNS_MAX}
              />
              <AppPressable onPress={() => void savePronouns()} hitSlop={8}>
                <Ionicons name="checkmark" size={20} color={colors.accent} />
              </AppPressable>
              <AppPressable onPress={() => { setEditPronounsDraft(pronouns); setIsEditingPronouns(false); }} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </AppPressable>
            </View>
          ) : (
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 }}
              onPress={() => { setEditPronounsDraft(pronouns); setIsEditingPronouns(true); }}
            >
              <Text style={{ color: pronouns ? colors.textSecondary : colors.textMuted, fontSize: scaleFont(13) }}>
                {pronouns || 'Добавить местоимения'}
              </Text>
              <Ionicons name="create-outline" size={14} color={colors.textMuted} />
            </AppPressable>
          )}

          {/*
            v4.32.547: приём бумаги на галочку. Из буфера, а не отдельным окном
            ввода: строка длинная, набирать её руками никто не станет, а
            приходит она всегда откуда-то, откуда её копируют.

            Строка показывается, только когда бумаги ещё нет: у аккаунта с
            галочкой она превратилась бы в приглашение сменить подтверждение —
            действие, которого не бывает.
          */}
          {badge ? null : (
            <AppPressable
              style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 }}
              onPress={() => void applyBadgeFromClipboard()}
              testID="profile_badge_paste"
            >
              <Ionicons name="shield-checkmark-outline" size={14} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, fontSize: scaleFont(13) }}>
                Вставить подтверждение аккаунта
              </Text>
            </AppPressable>
          )}

          <Text style={styles.userIdLabel}>Ваш адрес для связи</Text>
          <AppPressable style={styles.userIdBox} onPress={copyDidBtn.onPress} testID="user_did">
            <Text style={styles.userIdText} numberOfLines={1}>
              {shortDid}
            </Text>
            <Ionicons name="copy-outline" size={18} color={colors.textSecondary} />
          </AppPressable>
          <Text style={styles.userIdHint}>Нажмите, чтобы скопировать. Нужен для добавления вручную.</Text>
        </View>

        {/* Bio section */}
        <View style={styles.bioSection}>
          {isEditingBio ? (
            <>
              <TextInput
                style={styles.bioInput}
                value={editBioDraft}
                onChangeText={setEditBioDraft}
                multiline
                maxLength={OWN_BIO_MAX}
                placeholder="Расскажите о себе…"
                placeholderTextColor={colors.textMuted}
                autoFocus
                testID="profile_bio_input"
              />
              <View style={styles.bioEditActions}>
                <AppPressable onPress={() => { setEditBioDraft(bio); setIsEditingBio(false); }}>
                  <Text style={styles.nameEditCancel}>Отмена</Text>
                </AppPressable>
                <AppPressable onPress={() => void saveBio()} testID="profile_save_bio">
                  <Text style={styles.nameEditSave}>Сохранить</Text>
                </AppPressable>
              </View>
            </>
          ) : (
            <AppPressable
              style={styles.bioRow}
              onPress={() => { setEditBioDraft(bio); setIsEditingBio(true); }}
              testID="profile_bio"
            >
              {bio ? (
                <Text style={styles.bioText} numberOfLines={3}>
                  {/* Подчёркнутым рисуется РОВНО то, что дверь согласна
                      открыть: решение одно и принимается один раз, иначе
                      можно подчеркнуть ссылку, по которой ничего не будет
                      (v4.32.420). */}
                  {splitBioParts(bio).map((part, idx) => {
                    const href = safeExternalUrl(part);
                    return href ? (
                      <Text
                        key={idx}
                        style={{ color: colors.accent, textDecorationLine: 'underline' }}
                        onPress={() => openExternal(href, 'profile_bio')}
                      >
                        {part}
                      </Text>
                    ) : (
                      <Text key={idx}>{part}</Text>
                    );
                  })}
                </Text>
              ) : (
                <Text style={styles.bioPlaceholder}>Добавить описание…</Text>
              )}
              <Ionicons name="create-outline" size={18} color={colors.textMuted} style={{ marginLeft: 8 }} />
            </AppPressable>
          )}
        </View>

        {/* Custom status */}
        <AppPressable
          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 10 }}
          onPress={() => { setEditStatusDraft(customStatus); setEditStatusVisible(true); }}
        >
          <Text style={{ fontSize: scaleFont(20) }}>{customStatus ? customStatus.match(/^\p{Emoji}/u)?.[0] ?? '💬' : '💬'}</Text>
          <Text style={{ color: customStatus ? colors.text : colors.textMuted, fontSize: scaleFont(14), flex: 1 }}>
            {customStatus || 'Установить статус…'}
          </Text>
          <Ionicons name="create-outline" size={16} color={colors.textMuted} />
        </AppPressable>

        {/* Profile completion bar */}
        {completionPct < 100 ? (
          <View style={{ marginHorizontal: 20, marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ color: colors.textMuted, fontSize: scaleFont(12) }}>Заполненность профиля</Text>
              <Text style={{ color: colors.accent, fontSize: scaleFont(12), fontWeight: '700' }}>{completionPct}%</Text>
            </View>
            <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' }}>
              <View style={{ height: 4, width: `${completionPct}%`, backgroundColor: colors.primary, borderRadius: 2 }} />
            </View>
          </View>
        ) : null}

        {/* Social links */}
        <AppPressable
          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8, gap: 10 }}
          onPress={() => {
            setWebsiteDraft(website);
            setTwitterDraft(twitterHandle ? `@${twitterHandle}` : '');
            setGithubDraft(githubHandle ? `@${githubHandle}` : '');
            setSocialLinksVisible(true);
          }}
        >
          <Ionicons name="link-outline" size={18} color={colors.textMuted} />
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {/* Поле сайта заполняет сам владелец профиля, поэтому здесь
                допускается адрес без схемы — «example.com». Всё остальное
                правило то же, что и для чужих ссылок (v4.32.420). */}
            {website ? (
              <AppPressable onPress={() => openTypedExternal(website, 'profile_site')}>
                <Text style={{ color: colors.accent, fontSize: scaleFont(13) }} numberOfLines={1}>{website.replace(/^https?:\/\//, '')}</Text>
              </AppPressable>
            ) : null}
            {twitterHandle && /^[A-Za-z0-9_]{1,15}$/.test(twitterHandle) ? (
              // v4.32.183 (Round-13 #10): enforce Twitter handle charset to avoid
              // open-redirect via `foo/../../evil`.
              <AppPressable onPress={() => openExternal(`https://twitter.com/${twitterHandle}`, 'profile_twitter')}>
                <Text style={{ color: accentOnFill(BRAND_X, colors.background, colors.accent), fontSize: scaleFont(13) }}>𝕏 @{twitterHandle}</Text>
              </AppPressable>
            ) : null}
            {githubHandle && /^[A-Za-z0-9-]{1,39}$/.test(githubHandle) ? (
              <AppPressable onPress={() => openExternal(`https://github.com/${githubHandle}`, 'profile_github')}>
                <Text style={{ color: colors.text, fontSize: scaleFont(13) }}>⌥ {githubHandle}</Text>
              </AppPressable>
            ) : null}
            {!website && !twitterHandle && !githubHandle ? (
              <Text style={{ color: colors.textMuted, fontSize: scaleFont(13) }}>Добавить ссылки…</Text>
            ) : null}
          </View>
          <Ionicons name="create-outline" size={16} color={colors.textMuted} />
        </AppPressable>

        <View style={styles.actionsGrid}>
          <AppPressable style={styles.actionCard} onPress={() => setShowQrModal(true)}>
            <View style={styles.actionIcon}>
              <Ionicons name="qr-code" size={28} color={colors.accent} />
            </View>
            <Text style={styles.actionTitle}>Мой QR-код</Text>
            <Text style={styles.actionDesc}>Покажите другу для добавления</Text>
          </AppPressable>

          <AppPressable style={styles.actionCard} onPress={openSeedBtn.onPress} testID="btn_backup_seed">
            <View style={styles.actionIcon}>
              <Ionicons name="shield-checkmark" size={28} color={colors.accent} />
            </View>
            <Text style={styles.actionTitle}>Секретные слова</Text>
            <Text style={styles.actionDesc}>Для восстановления аккаунта</Text>
          </AppPressable>

          <AppPressable style={styles.actionCard} onPress={() => {
            const pid = profileManager.getActiveProfile()?.id ?? 1;
            void listStarredMessages(pid).then((entries) => {
              setStarredEntries(entries);
              setStarredVisible(true);
            });
          }}>
            <View style={styles.actionIcon}>
              <Ionicons name="star" size={28} color={colors.star} />
            </View>
            <Text style={styles.actionTitle}>Избранные</Text>
            <Text style={styles.actionDesc}>Отмеченные сообщения</Text>
          </AppPressable>
          <AppPressable style={styles.actionCard} onPress={() => setCallLogVisible(true)}>
            <View style={styles.actionIcon}>
              <Ionicons name="call" size={28} color={colors.accent} />
            </View>
            <Text style={styles.actionTitle}>Звонки</Text>
            <Text style={styles.actionDesc}>История звонков</Text>
          </AppPressable>
          {/* v4.32.30: VK-style «Контакты» — четвёртая карточка в сетке быстрого доступа. */}
          <AppPressable
            style={styles.actionCard}
            onPress={() => setContactsVisible(true)}
            testID="btn_profile_contacts"
          >
            <View style={styles.actionIcon}>
              <Ionicons name="people" size={28} color={colors.accent} />
            </View>
            <Text style={styles.actionTitle}>Контакты</Text>
            <Text style={styles.actionDesc}>
              {contactCount > 0 ? `Всего: ${contactCount}` : 'Добавьте первого'}
            </Text>
          </AppPressable>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{postCount}</Text>
            <Text style={styles.statLabel}>публикаций</Text>
          </View>
          <View style={styles.statDivider} />
          {/* v4.32.30: статистика «N контактов» тоже открывает список — удобно тапнуть
               по цифре, которую ты только что увидел. */}
          <AppPressable
            style={styles.statItem}
            onPress={() => setContactsVisible(true)}
            testID="btn_profile_contacts_stat"
          >
            <Text style={styles.statValue}>{contactCount}</Text>
            <Text style={styles.statLabel}>контактов</Text>
          </AppPressable>
          {stats ? (
            <>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{stats.messagesSent}</Text>
                <Text style={styles.statLabel}>отправлено</Text>
              </View>
            </>
          ) : null}
        </View>
        {stats && (stats.messagesReceived > 0 || stats.voicesSent.value > 0 || stats.groupCount > 0) ? (
          <View style={[styles.statsRow, { marginTop: 8 }]}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{stats.messagesReceived}</Text>
              <Text style={styles.statLabel}>получено</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{stats.groupCount}</Text>
              <Text style={styles.statLabel}>групп</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{approxCountLabel(stats.voicesSent)}</Text>
              <Text style={styles.statLabel}>голосовых</Text>
            </View>
          </View>
        ) : null}
        {/* v4.32.585: почему число голосовых может быть занижено. */}
        {stats && approxCountNotice(stats.voicesSent) ? (
          <Text style={{ color: colors.warning, fontSize: scaleFont(12), fontStyle: 'italic', textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
            {approxCountNotice(stats.voicesSent)}
          </Text>
        ) : null}

        {accountAgeLabel ? (
          <View style={{ alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: scaleFont(12) }}>В AirChat {accountAgeLabel}</Text>
          </View>
        ) : null}

        <AppPressable style={styles.exportBtn} onPress={() => setExportModal(true)} testID="btn_export_backup">
          <Ionicons name="archive-outline" size={20} color={colors.text} style={{ marginRight: 8 }} />
          <Text style={styles.exportBtnText}>Сохранить зашифрованную копию</Text>
        </AppPressable>
        {!hasSeed ? (
          <Text style={styles.warn}>
            Секретные слова на этом устройстве не найдены — при необходимости пройдите настройку заново.
          </Text>
        ) : null}

        {peer ? (
          <View style={styles.techBox}>
            <Text style={styles.techLabel}>Распределённое хранилище</Text>
            <Text style={styles.techHint}>Служебный идентификатор узла (для справки)</Text>
            <Text style={styles.techMono} numberOfLines={2}>
              {peer}
            </Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Ещё</Text>
        {onOpenSettings ? (
          <AppPressable style={styles.settingRow} onPress={onOpenSettings}>
            <Ionicons name="settings-outline" size={22} color={colors.text} />
            <Text style={styles.settingText}>Настройки приложения</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </AppPressable>
        ) : null}

        <View style={styles.infoSection}>
          <Text style={styles.version}>AirChat · версия {appVersion}</Text>
          <Text style={styles.infoText}>
            Сообщения шифруются на устройстве. Прочитать их могут только участники чата.
          </Text>
          {/* v4.32.528: в браузере эта строка была неправдой. Wi-Fi LAN держится
              на слушающем сокете и mDNS — странице не дают ни того, ни другого,
              то есть «обнаруживаются автоматически» обещало то, чего не будет
              никогда. Обещание, которое платформа не может сдержать, хуже
              молчания: пользователь ждёт собеседника и считает виноватым себя.
              См. platformCapabilities. */}
          {LOCAL_RADIO_TRANSPORTS_AVAILABLE ? (
            <Text style={styles.infoText}>Собеседники в локальной сети обнаруживаются автоматически по Wi-Fi LAN.</Text>
          ) : null}
        </View>

        <Modal visible={seedPwdModal} transparent animationType="fade" testID="seed_password_modal" onRequestClose={() => setSeedPwdModal(false)}>
          {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
          <KeyboardAvoidingView
            style={styles.exportKav}
            behavior="padding"
            keyboardVerticalOffset={0}
          >
            <View style={styles.modalBg}>
              <View style={styles.modalBox}>
                <Text style={styles.modalTitle}>Пароль приложения</Text>
                <Text style={styles.modalHint}>Чтобы показать секретные слова, введите пароль</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={seedPwd}
                  onChangeText={setSeedPwd}
                  placeholder="Пароль"
                  placeholderTextColor={colors.textMuted}
                  editable={!seedPwdBusy}
                  testID="seed_view_password_input"
                />
                <AppPressable
                  style={styles.btn}
                  onPress={submitSeedPwdBtn.onPress}
                  disabled={seedPwdBusy}
                  testID="seed_view_password_ok"
                >
                  <Text style={styles.btnText}>{seedPwdBusy ? '…' : 'Показать'}</Text>
                </AppPressable>
                <AppPressable
                  style={styles.linkBtn}
                  onPress={() => {
                    setSeedPwdModal(false);
                    setSeedPwd('');
                  }}
                >
                  <Text style={styles.linkText}>Отмена</Text>
                </AppPressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* Social links edit modal */}
        <Modal visible={socialLinksVisible} transparent animationType="fade" onRequestClose={() => setSocialLinksVisible(false)}>
          {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
          <KeyboardAvoidingView style={styles.exportKav} behavior="padding" keyboardVerticalOffset={0}>
            <View style={styles.modalBg}>
              <View style={styles.modalBox}>
                <Text style={styles.modalTitle}>Ссылки профиля</Text>
                <Text style={styles.modalHint}>Сайт</Text>
                <TextInput
                  style={styles.input}
                  value={websiteDraft}
                  onChangeText={setWebsiteDraft}
                  placeholder="https://example.com"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  maxLength={256}
                />
                <Text style={styles.modalHint}>Twitter / X</Text>
                <TextInput
                  style={styles.input}
                  value={twitterDraft}
                  onChangeText={setTwitterDraft}
                  placeholder="@username"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={256}
                />
                <Text style={styles.modalHint}>GitHub</Text>
                <TextInput
                  style={styles.input}
                  value={githubDraft}
                  onChangeText={setGithubDraft}
                  placeholder="@username"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={256}
                />
                <AppPressable style={styles.btn} onPress={() => void saveSocialLinks()}>
                  <Text style={styles.btnText}>Сохранить</Text>
                </AppPressable>
                <AppPressable style={styles.linkBtn} onPress={() => setSocialLinksVisible(false)}>
                  <Text style={styles.linkText}>Отмена</Text>
                </AppPressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={showQrModal} transparent animationType="fade" onRequestClose={() => setShowQrModal(false)}>
          <View style={styles.modalBg}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>Ваш QR-код</Text>
              <View style={styles.qrWrap}>
                <QRCode value={did} size={200} color={QR_CODE.ink} backgroundColor={QR_CODE.fill} />
              </View>
              <Text style={styles.modalHint}>Друг может отсканировать код — или вставить ваш ID у себя: «Профиль» → «Контакты» → «Новый контакт»</Text>
              {/* v4.32.31: прямая кнопка «копировать DID» — чтобы пользователь мог скинуть его в мессенджер/чат, а получатель вставил в Контакты → + */}
              <AppPressable
                style={styles.btn}
                onPress={() => {
                  void Clipboard.setStringAsync(did).then(() => showSuccess(COPIED_ID));
                }}
              >
                <Text style={styles.btnText}>{COPY_ID_ACTION}</Text>
              </AppPressable>
              <AppPressable
                style={styles.linkBtn}
                onPress={() => {
                  void Share.share({ message: `Добавь меня в AirChat:\n${did}` });
                }}
              >
                <Text style={styles.linkText}>Поделиться…</Text>
              </AppPressable>
              <AppPressable style={styles.linkBtn} onPress={() => setShowQrModal(false)}>
                <Text style={styles.linkText}>Закрыть</Text>
              </AppPressable>
            </View>
          </View>
        </Modal>

        {/* v4.32.30: VK-style список контактов в fullscreen-модалке. Вместо ContactsScreen
             в скрытом табе — теперь прямо из Профиля. */}
        <Modal
          visible={contactsVisible}
          animationType="slide"
          onRequestClose={() => setContactsVisible(false)}
          presentationStyle="overFullScreen"
        >
          <SafeScreen edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }}>
              <AppPressable onPress={() => setContactsVisible(false)} hitSlop={12} style={{ paddingRight: 10 }}>
                <Ionicons name="chevron-back" size={26} color={colors.text} />
              </AppPressable>
              <Text style={{ fontSize: scaleFont(18), fontWeight: '700', color: colors.text, flex: 1 }}>
                Контакты
              </Text>
            </View>
            <ContactsScreen
              pair={pair}
              myDid={did}
              onOpenChatWithPeer={(peer) => {
                // Сначала закрываем модалку, потом через rAF переключаем таб,
                // чтобы анимация закрытия не ломалась сменой tab state.
                setContactsVisible(false);
                requestAnimationFrame(() => {
                  onOpenChatWithPeer?.(peer);
                });
              }}
            />
          </SafeScreen>
        </Modal>

        {/* Starred messages modal */}
        <Modal visible={starredVisible} transparent animationType="slide" onRequestClose={() => setStarredVisible(false)}>
          <View style={{ flex: 1, backgroundColor: scrim.modal }}>
            <AppPressable style={{ flex: 1 }} onPress={() => setStarredVisible(false)} />
            <View style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface, maxHeight: '80%' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                <Ionicons name="star" size={18} color={colors.star} style={{ marginRight: 10 }} />
                <Text style={{ fontSize: scaleFont(17), fontWeight: '700', color: colors.text, flex: 1 }}>Избранные сообщения</Text>
                <AppPressable onPress={() => setStarredVisible(false)} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
                {starredEntries.length === 0 ? (
                  <Text style={{ textAlign: 'center', marginTop: 40, color: colors.textMuted, fontSize: scaleFont(15) }}>Нет избранных сообщений</Text>
                ) : starredEntries.map((entry) => (
                  <View key={entry.message.id} style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                      <Ionicons name="star" size={12} color={colors.star} style={{ marginRight: 6 }} />
                      <Text style={{ color: colors.accent, fontSize: scaleFont(12), fontWeight: '600', flex: 1 }} numberOfLines={1}>
                        {entry.kind === 'group' ? '👥 ' : ''}{entry.contextName}
                      </Text>
                      <Text style={{ color: colors.textMuted, fontSize: scaleFont(font.xs) }}>
                        {dayMonthShort(entry.message.createdAt)}
                      </Text>
                    </View>
                    <Text
                      style={
                        isUnreadableMessage(entry.message)
                          ? { color: colors.textMuted, fontSize: scaleFont(14), fontStyle: 'italic' }
                          : { color: colors.text, fontSize: scaleFont(14) }
                      }
                      numberOfLines={4}
                    >{isUnreadableMessage(entry.message) ? UNREADABLE_MESSAGE_TEXT : entry.message.text}</Text>
                    <AppPressable
                      onPress={() => {
                        const id = entry.message.id;
                        const unstar = entry.kind === 'chat' ? setMessageStarred(id, false) : setGroupMessageStarred(id, false);
                        void unstar.then(() => setStarredEntries((prev) => prev.filter((e) => e.message.id !== id)));
                      }}
                      style={{ marginTop: 6 }}
                    >
                      <Text style={{ color: colors.textMuted, fontSize: scaleFont(12) }}>Убрать из избранного</Text>
                    </AppPressable>
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* Call history modal */}
        <Modal visible={callLogVisible} transparent animationType="slide" onRequestClose={() => setCallLogVisible(false)}>
          <View style={{ flex: 1, backgroundColor: scrim.modal }}>
            <AppPressable style={{ flex: 1 }} onPress={() => setCallLogVisible(false)} />
            <View style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface, maxHeight: '75%' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                <Ionicons name="call" size={18} color={colors.accent} style={{ marginRight: 10 }} />
                <Text style={{ fontSize: scaleFont(17), fontWeight: '700', color: colors.text, flex: 1 }}>История звонков</Text>
                {callLogEntries.length > 0 ? (
                  <AppPressable hitSlop={8} onPress={() => {
                    void clearCallLog().then(() => setCallLogEntries([]));
                  }} style={{ marginRight: 12 }}>
                    <Text style={{ color: colors.error, fontSize: scaleFont(13) }}>Очистить</Text>
                  </AppPressable>
                ) : null}
                <AppPressable onPress={() => setCallLogVisible(false)} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </AppPressable>
              </View>
              <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
                {callLogEntries.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <Ionicons name="call-outline" size={44} color={colors.textMuted} />
                    <Text style={{ color: colors.textMuted, fontSize: scaleFont(15), marginTop: 12 }}>Нет звонков</Text>
                  </View>
                ) : callLogEntries.map((entry) => {
                  const isOut = entry.direction === 'outgoing';
                  const isMissed = entry.outcome === 'missed';
                  // v4.32.393: пропущенный и входящий звонок — те же «ошибка» и
                  // «успех», что и везде, а не второй красный с зелёным.
                  const iconColor = isMissed ? colors.error : isOut ? colors.accent : colors.success;
                  const iconName = isOut ? 'arrow-up' : 'arrow-down';
                  /**
                   * v4.32.441: подпись по исходу, а не по длительности. Разговор
                   * короче секунды давал durationMs === 0 — и состоявшийся звонок
                   * подписывался «Отклонён». А несостоявшийся исходящий назывался
                   * «Пропущен», хотя пропустить собственный звонок нельзя.
                   */
                  const durationStr = entry.outcome === 'answered'
                    ? formatSpokenDuration(entry.durationMs ?? 0)
                    : isMissed
                      ? (isOut ? 'Нет ответа' : 'Пропущен')
                      : 'Отклонён';
                  const dateStr = dayMonthShortTime(entry.startedAt);
                  return (
                    <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                      <View style={{ ...avatarShape(40), backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                        <Ionicons name={entry.isVideo ? 'videocam' : 'call'} size={20} color={colors.text} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: isMissed ? colors.error : colors.text, fontWeight: '600', fontSize: scaleFont(15) }} numberOfLines={1}>{entry.peerName}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                          <Ionicons name={iconName as 'arrow-up' | 'arrow-down'} size={12} color={iconColor} />
                          <Text style={{ color: iconColor, fontSize: scaleFont(12) }}>{durationStr}</Text>
                        </View>
                      </View>
                      <Text style={{ color: colors.textMuted, fontSize: scaleFont(12) }}>{dateStr}</Text>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>

        <Modal visible={seedModal} transparent animationType="fade" onRequestClose={() => { setSeedModal(false); setSeedWords([]); }}>
          <View style={styles.modalBg} testID="seed_modal">
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>Секретные слова для восстановления</Text>
              <Text style={styles.modalWarning}>
                <Text style={[styles.modalWarning, appleColorEmojiTextStyle()]}>⚠️</Text>
                {' '}
                Это ваш ключ к аккаунту. Запишите на бумаге и храните в надёжном месте!
              </Text>
              <ScrollView style={styles.seedScroll} testID="seed_words">
                {seedWords.map((w, i) => (
                  <View key={`${i}-${w}`} style={styles.seedRow}>
                    <Text style={styles.seedNum}>{i + 1}</Text>
                    <Text style={styles.seedWord}>{w}</Text>
                  </View>
                ))}
              </ScrollView>
              <AppPressable style={styles.btn} onPress={() => { setSeedModal(false); setSeedWords([]); }} testID="btn_close_modal">
                <Text style={styles.btnText}>Я сохранил(а), закрыть</Text>
              </AppPressable>
            </View>
          </View>
        </Modal>

        <Modal visible={exportModal} transparent animationType="fade" onRequestClose={() => setExportModal(false)}>
          {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
          <KeyboardAvoidingView
            style={styles.exportKav}
            behavior="padding"
            keyboardVerticalOffset={0}
          >
            <ScrollView
              style={styles.exportScroll}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.exportModalScroll}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.modalBox} testID="export_backup_modal">
                <Text style={styles.modalTitle}>Пароль для файла копии</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={exportPwd}
                  onChangeText={setExportPwd}
                  placeholder="минимум 8 символов"
                  placeholderTextColor={colors.textMuted}
                  testID="export_password_input"
                />
                {/* v4.32.376: копия молчала о том, как ею пользоваться, — а
                    загрузить её до этой версии было и правда некуда. */}
                <Text style={{ color: colors.textMuted, fontSize: scaleFont(12), marginBottom: 12 }}>
                  Копию вставляют в поле восстановления при первом запуске приложения. Пароль не
                  хранится нигде: забудете — копия не откроется.
                </Text>
                <AppPressable style={styles.btn} onPress={runExportBtn.onPress} testID="btn_confirm_export">
                  <Text style={styles.btnText}>Экспортировать</Text>
                </AppPressable>
                <AppPressable style={styles.linkBtn} onPress={() => setExportModal(false)} testID="btn_cancel_export">
                  <Text style={styles.linkText}>Отмена</Text>
                </AppPressable>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </Modal>

        {/* Custom status edit modal */}
        <Modal visible={editStatusVisible} transparent animationType="fade" onRequestClose={() => setEditStatusVisible(false)}>
          <AppPressable style={styles.modalBg} onPress={() => setEditStatusVisible(false)}>
            <AppPressable style={styles.modalBox} onPress={() => {}}>
              <Text style={styles.modalTitle}>Мой статус</Text>
              <TextInput
                style={styles.input}
                value={editStatusDraft}
                onChangeText={setEditStatusDraft}
                placeholder="💬 Что у вас нового?"
                placeholderTextColor={colors.textMuted}
                maxLength={MAX_CUSTOM_STATUS_LEN}
                autoFocus
              />
              <Text style={{ color: colors.textMuted, fontSize: scaleFont(12), marginBottom: 8 }}>
                {editStatusDraft.length}/{MAX_CUSTOM_STATUS_LEN} · Статус виден контактам под вашим именем
              </Text>
              <AppPressable
                style={styles.btn}
                onPress={() => {
                  // v4.32.375: тем же правилом, что и на приёме у собеседника, —
                  // иначе в базе лежит одно, а до контактов доезжает другое.
                  const s = normalizeOwnStatus(editStatusDraft);
                  setCustomStatus(s);
                  void ownFieldSet('user_custom_status', s);
                  setEditStatusVisible(false);
                  showSuccess(s ? 'Статус обновлён' : 'Статус удалён');
                }}
              >
                <Text style={styles.btnText}>Сохранить</Text>
              </AppPressable>
              {customStatus ? (
                <AppPressable style={styles.linkBtn} onPress={() => {
                  setCustomStatus('');
                  void ownFieldSet('user_custom_status', '');
                  setEditStatusVisible(false);
                }}>
                  <Text style={[styles.linkText, { color: colors.error }]}>Удалить статус</Text>
                </AppPressable>
              ) : null}
              <AppPressable style={styles.linkBtn} onPress={() => setEditStatusVisible(false)}>
                <Text style={styles.linkText}>Отмена</Text>
              </AppPressable>
            </AppPressable>
          </AppPressable>
        </Modal>
      </ScrollView>
    </SafeScreen>
  );
}

function makeStyles(c: AppColors, sf: (base: number) => number) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingBottom: 40 },
  profileSwitchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: 'transparent',
    paddingHorizontal: 14,
  },
  // v4.32.530: последняя из четырёх стеклянных поверхностей. Карточка
  // активного профиля — строка настройки, а не всплывающий слой; §9 оставляет
  // стекло одному таббару.
  profileSwitchGlass: {
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    backgroundColor: c.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  profileSwitchBody: { flex: 1, marginLeft: 10 },
  profileSwitchLabel: { color: c.textMuted, fontSize: sf(font.xs), fontWeight: '600' },
  profileSwitchName: { color: c.text, fontSize: sf(font.lg), fontWeight: '700', marginTop: 2 },
  profileSwitchHint: { color: c.textSecondary, fontSize: sf(font.xs), marginTop: 4 },
  avatarSection: { alignItems: 'center', marginBottom: 20 },
  avatarCircle: {
    ...avatarShape(88),
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  avatarImage: avatarShape(88),
  avatarEditBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    maxWidth: '100%',
    paddingHorizontal: 8,
  },
  username: { fontSize: sf(22), fontWeight: '700', color: c.text, flexShrink: 1 },
  nameEditBlock: { alignItems: 'center', marginTop: 12, width: '100%', paddingHorizontal: 8 },
  nameInput: {
    fontSize: sf(20),
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: c.primary,
    paddingVertical: 6,
    minWidth: 200,
    maxWidth: '100%',
  },
  nameEditActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 28,
    marginTop: 12,
  },
  nameEditCancel: { color: c.textMuted, fontSize: sf(15) },
  nameEditSave: { color: c.accent, fontSize: sf(15), fontWeight: '600' },
  handleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  handleText: { color: c.accent, fontSize: sf(15) },
  handlePlaceholder: { color: c.textMuted, fontSize: sf(14) },
  handleEditBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primary,
  },
  handleAt: { color: c.accent, fontSize: sf(16), fontWeight: '600' },
  handleInput: {
    flex: 1,
    color: c.text,
    fontSize: sf(15),
    padding: 0,
  },
  userIdLabel: { color: c.textSecondary, fontSize: sf(13), marginTop: 16 },
  userIdBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    maxWidth: '100%',
  },
  userIdText: { color: c.text, fontSize: sf(13), flex: 1, marginRight: 8 },
  userIdHint: { color: c.textMuted, fontSize: sf(font.xs), marginTop: 8, textAlign: 'center', paddingHorizontal: 8 },
  bioSection: {
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  bioRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: c.surface,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  bioText: { flex: 1, color: c.text, fontSize: sf(14), lineHeight: sf(20) },
  bioPlaceholder: { flex: 1, color: c.textMuted, fontSize: sf(14) },
  bioInput: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.primary,
    padding: 12,
    color: c.text,
    fontSize: sf(14),
    lineHeight: sf(20),
    minHeight: 72,
    textAlignVertical: 'top',
  },
  bioEditActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 24,
    marginTop: 8,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  actionCard: {
    width: '48%',
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: c.border,
    minWidth: 140,
  },
  actionIcon: { marginBottom: 8 },
  actionTitle: { color: c.text, fontWeight: '700', fontSize: sf(15) },
  actionDesc: { color: c.textMuted, fontSize: sf(12), marginTop: 4 },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primaryMuted,
    padding: 14,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  // v4.32.407: надпись лежит на приглушённой заливке — от неё и считается.
  exportBtnText: { color: inkOn(c, c.primaryMuted).text, fontWeight: '600' },
  warn: { color: c.warning, marginTop: 8, fontSize: sf(12) },
  techBox: { marginTop: 12, padding: 10, backgroundColor: c.surface, borderRadius: radius.md },
  techLabel: { color: c.textMuted, fontSize: sf(font.xs), marginBottom: 4 },
  techHint: { color: c.textMuted, fontSize: sf(font.xs), marginBottom: 4 },
  techMono: { color: c.textSecondary, fontSize: sf(font.xs) },
  sectionTitle: { color: c.text, fontWeight: '700', fontSize: sf(16), marginTop: 20, marginBottom: 8 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  settingText: { color: c.text, fontSize: sf(16), marginLeft: 12, flex: 1 },
  infoSection: { marginTop: 24 },
  version: { color: c.textSecondary, fontSize: sf(13), marginBottom: 8 },
  infoText: { color: c.textMuted, fontSize: sf(13), lineHeight: sf(18), marginBottom: 8 },
  exportKav: { flex: 1 },
  exportScroll: {
    flex: 1,
    backgroundColor: scrim.modal,
  },
  exportModalScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalBg: {
    flex: 1,
    backgroundColor: scrim.modal,
    justifyContent: 'center',
    padding: 20,
  },
  modalBox: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    padding: 16,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: c.border,
  },
  modalTitle: { color: c.text, fontWeight: '700', fontSize: sf(17), marginBottom: 8 },
  modalWarning: { color: c.warning, fontSize: sf(13), marginBottom: 12 },
  modalHint: { color: c.textSecondary, fontSize: sf(13), marginBottom: 12, textAlign: 'center' },
  // v4.32.418: код лежал прямо на поверхности модалки — в тёмной теме без
  // светлого поля тишины, которого требует декодер. Белая плашка здесь не
  // оформление, а часть кода.
  qrWrap: {
    alignItems: 'center',
    alignSelf: 'center',
    padding: QR_CODE.quietZone,
    borderRadius: radius.lg,
    backgroundColor: QR_CODE.fill,
    marginVertical: 12,
  },
  seedScroll: { maxHeight: 280, marginBottom: 12 },
  seedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  seedNum: { width: 28, color: c.textMuted, fontSize: sf(13) },
  seedWord: { color: c.text, fontSize: sf(15) },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: 10,
    color: c.text,
    marginBottom: 12,
  },
  btn: {
    backgroundColor: c.primary,
    padding: 12,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  // v4.32.418: белым было вписано в StyleSheet, то есть от заливки кнопки
  // не зависело вовсе. Заливка — `primary`, а его выбирает пользователь.
  btnText: { color: primaryInk(c).text, fontWeight: '600' },
  linkBtn: { alignItems: 'center', padding: 8 },
  linkText: { color: c.accent },
  statsRow: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 12,
    overflow: 'hidden',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
  },
  statValue: {
    color: c.text,
    fontSize: sf(22),
    fontWeight: '700',
  },
  statLabel: {
    color: c.textMuted,
    fontSize: sf(12),
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: c.border,
    marginVertical: 10,
  },
}); }

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — предотвращает re-render при каждом setTab в App.tsx (v4.32.5).
export const ProfileScreen = React.memo(ProfileScreenImpl);
