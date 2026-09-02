import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { runWithConcurrency } from '../../core/utils/runWithConcurrency';
import { useTabRef } from '../TabRefContext';
import { useBackHandler } from '../../core/hooks/useBackHandler';
import Constants from 'expo-constants';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  
  Alert,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Share,
} from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { AppSwitch } from '../components/AppSwitch';
import { AppModal as Modal } from '../components/AppModal';
import * as FileSystem from 'expo-file-system/legacy';
import { authGuard } from '../../core/security/authGuard';
import { copySecretToClipboard } from '../../core/security/clipboardSecret';
import { isInternalDiagnosticsEnabled, toggleInternalDiagnostics } from '../../core/internalDiagnostics';
import { Ionicons } from '@expo/vector-icons';
import { BlockedContactsList } from '../components/BlockedContactsList';
import { VpnSettingsSection } from '../components/VpnSettingsSection';
import { EMBEDDED_VPN_AVAILABLE, LOCAL_RADIO_TRANSPORTS_AVAILABLE } from '../platformCapabilities';
import { RelaySettingsSection } from '../components/RelaySettingsSection';
import { SafeScreen } from '../components/SafeScreen';
import { HelpScreen } from './HelpScreen';
import { PrivacyPolicyScreen } from './PrivacyPolicyScreen';
import { DiagnosticScreen } from './DiagnosticScreen';
import { ProfileSelector } from '../components/ProfileSelector';
import { profileManager } from '../../core/identity/profileManager';
import { scopedKvGet, scopedKvSet } from '../../core/storage/profileScopedKv';
import { TRANSLATION_TARGET_LANG_KEY } from '../../core/storage/kvKeys';
import { ownFieldGet, ownFieldSet } from '../../core/identity/ownProfile';
import { showError, showPasswordRejected, showSuccess } from '../components/userFeedback';
import { ACCENT_SWATCHES, avatarShape, badgeTint, colorsForScheme, contrastingInk, font, mono, radius, scrim, tintedIcon, TOUCH_TARGET_MIN, type AppColors, type BadgeTone, type MenuIconHue } from '../theme';
import { useTheme, FONT_SIZE_OPTIONS, type FontSizeValue } from '../ThemeContext';
import {
  kvGet, kvSet, clearAllMessageHistory,
  listQuickReplies, addQuickReply, updateQuickReply, deleteQuickReply,
  type QuickReply,
} from '../../core/storage/local';
import { templateReadable } from '../../core/social/templateSearch';
import { UNREADABLE_TEMPLATE_TEXT } from '../../core/storage/unreadableText';
import {
  getDefaultDisappearMs,
  setDefaultDisappearMs,
} from '../../core/storage/defaultDisappear';
import { exportDialogBackupToFile, importDialogBackupJson } from '../../core/storage/dialogBackup';
import { clearCacheFiles } from '../../core/media/cacheFiles';
// v4.32.311: переключатели приватности — свои у каждого аккаунта, см. privacyPrefs.
import { privacyPrefGet, privacyPrefSet } from '../../core/settings/privacyPrefs';
// v4.32.486: облачный перевод — решение о приватности, и до этой версии
// переключателя к нему не было вовсе (см. social/translateConsent).
import { cloudTranslateAllowed, setCloudTranslateAllowed } from '../../core/social/translateConsent';
import { deriveKeyPairFromMnemonic, getStoredMnemonic } from '../../core/backup/seedPhrase';
import { isCloudVaultConfigured, uploadCloudVault, validateCloudPassword } from '../../core/backup/cloudVault';
// v4.32.540: фотография профиля — отдельное решение от «когда я в сети»:
// лицо прячут не по тем же причинам, по которым прячут активность.
import {
  parseAvatarVisibility,
  setAvatarVisibility,
  type AvatarVisibility,
} from '../../core/settings/avatarVisibility';
import { setMyLastSeenVisibility } from '../../core/social/presenceService';
import { broadcastLastSeenPref } from '../../core/social/presencePrefSync';
import { broadcastMyProfile } from '../../core/social/profileSync';
import { LINK_PREVIEW_INCOMING_KEY, parseIncomingLinkPreviewPref } from '../../core/social/linkPreviewPolicy';
import { MAX_CUSTOM_STATUS_LEN, normalizeOwnStatus } from '../../core/social/peerStatus';
import { getLanTransportSingleton } from '../../core/transport/lan/lanTransport';
import { listMuted, unmute, type MuteEntry } from '../../core/notifications/muteStore';
import { formatByteSize } from '../../core/media/byteSize';
import { shortIdentity } from '../identity/shortId';
import { fullDateTime } from '../../core/time/ruDateTime';
import { userErrorText } from '../components/userErrorText';
import { COPIED_TEXT, COPY_ACTION } from '../clipboardText';
import { listSyncDevices, revokeSyncDevice, syncDeviceId, type SyncDevice } from '../../core/sync/syncApi';


// ── Types ──────────────────────────────────────────────────────────────────────

type SubScreen =
  | null
  | 'privacy'
  | 'notifications'
  | 'appearance'
  | 'data'
  | 'security'
  | 'blocked'
  | 'muted'
  | 'backup'
  | 'quick_replies'
  | 'language'
  | 'about'
  | 'privacy-policy'
  | 'diagnostics'
  | 'vpn'
  | 'relay'
  | 'profiles';

type Props = {
  profilesEnabled?: boolean;
  /** Вызывается после переключения профиля из встроенного subScreen «Профили» —
   * родитель обновляет pair и activeProfileLabel. */
  onProfileIdentityUpdated?: () => void;
  onLogout?: () => Promise<void>;
};

const appVersion = Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '1.0.0';

const COUNTRY_NAMES: Record<string, string> = {
  RU: 'Россия', UA: 'Украина', KZ: 'Казахстан', BY: 'Беларусь', DE: 'Германия',
  US: 'США', TR: 'Турция', AM: 'Армения', GE: 'Грузия',
};

function sessionLocation(device: SyncDevice): string {
  const country = device.countryCode ? (COUNTRY_NAMES[device.countryCode] ?? device.countryCode) : '';
  return [device.city, country].filter(Boolean).join(', ') || 'Регион не определён';
}

function sessionDeviceName(device: SyncDevice): string {
  return device.deviceModel || device.label || 'Неизвестное устройство';
}

// ── Component ──────────────────────────────────────────────────────────────────

function SettingsScreenImpl({
  profilesEnabled,
  onProfileIdentityUpdated,
  onLogout,
}: Props): React.ReactElement {
  // v4.32.16: gate через tabRef из Context; prop isActive удалён — React.memo bail-out.
  const tabRef = useTabRef();
  // ── Sub-navigation ─────────────────────────────────────────────────────────
  const [subScreen, setSubScreen] = useState<SubScreen>(null);

  // v4.32.61: системная кнопка «Назад» (Android) закрывает открытый subScreen
  // и возвращает в корневое меню «Настройки». Активен только когда вкладка
  // Settings видна (tabRef.current === 'settings') и subScreen открыт —
  // иначе top-level handler в App.tsx получит событие и уведёт на feed.
  useBackHandler(subScreen !== null, () => {
    if (tabRef.current !== 'settings') return false;
    setSubScreen(null);
    return true;
  });

  // ── Theme ──────────────────────────────────────────────────────────────────
  const {
    colors,
    mode: themeMode, setMode: setThemeMode,
    fontSize, setFontSize,
    autoNightEnabled, autoNightStart, autoNightEnd, setAutoNight,
    accentColor, setAccentColor,
    scheme,
  } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // v4.32.400: всё, что лежит НА кнопке акцентного цвета, считается из неё.
  // Акцент выбирает пользователь, и `normalizeAccent` гарантирует только то,
  // что белое поверх него читается; вписанное руками '#fff' этой гарантии не
  // видит и на светлой палитре ей не подчиняется.
  const primaryOn = contrastingInk(colors.primary);
  /**
   * Цвет образца «По умол.» — primary текущей темы БЕЗ пользовательского
   * акцента. v4.32.345: было вписано '#3d5afe', то есть тёмная тема; в светлой
   * образец показывал не тот цвет, который получишь, нажав на него.
   * Брать `colors.primary` нельзя — он уже переопределён выбранным акцентом,
   * и образец «по умолчанию» повторял бы текущий выбор.
   */
  const defaultAccent = useMemo(() => colorsForScheme(scheme).primary, [scheme]);

  // ── Security state ─────────────────────────────────────────────────────────
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [hasAppPassword, setHasAppPassword] = useState(false);
  const [setPwdModal, setSetPwdModal] = useState(false);
  const [changePwdModal, setChangePwdModal] = useState(false);
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [oldPwd, setOldPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [autoLockEnabled, setAutoLockEnabled] = useState(false);
  const [autoLockDelayMs, setAutoLockDelayMs] = useState(0);
  const [activeSessionsVisible, setActiveSessionsVisible] = useState(false);
  const [syncDevices, setSyncDevices] = useState<SyncDevice[]>([]);
  const [syncDevicesBusy, setSyncDevicesBusy] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [syncDevicesError, setSyncDevicesError] = useState<string | null>(null);
  const [currentSyncDeviceId, setCurrentSyncDeviceId] = useState<string | null>(null);
  const [profileRefreshToken, setProfileRefreshToken] = useState(0);
  const versionTapRef = useRef({ n: 0, t: 0 });
  const [diagUnlocked, setDiagUnlocked] = useState(false);

  // ── Appearance state ───────────────────────────────────────────────────────
  const [nightTimeModal, setNightTimeModal] = useState(false);
  const [nightStartTmp, setNightStartTmp] = useState(21);
  const [nightEndTmp, setNightEndTmp] = useState(7);

  // ── Backup state ───────────────────────────────────────────────────────────
  const [backupBusy, setBackupBusy] = useState(false);
  const [seedModal, setSeedModal] = useState(false);
  const [seedPwdInput, setSeedPwdInput] = useState('');
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [cloudPasswordModal, setCloudPasswordModal] = useState(false);
  const [cloudPasswordInput, setCloudPasswordInput] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);

  // ── Privacy state ──────────────────────────────────────────────────────────
  const [lastSeenVisibility, setLastSeenVisibility] = useState<'everybody' | 'contacts' | 'nobody'>('everybody');
  const [avatarVisibility, setAvatarVisibilityState] = useState<AvatarVisibility>('everybody');
  const [onlyContactsCanMsg, setOnlyContactsCanMsg] = useState(false);
  const [onlyContactsCanAddToGroup, setOnlyContactsCanAddToGroup] = useState(false);
  const [disableReadReceipts, setDisableReadReceipts] = useState(false);
  // Предпросмотр чужих ссылок выключен по умолчанию: см. core/social/linkPreviewPolicy.
  const [incomingLinkPreview, setIncomingLinkPreview] = useState(false);
  const [defaultAutoDeleteMs, setDefaultAutoDeleteMs] = useState<number | null>(null);

  // ── Status state ───────────────────────────────────────────────────────────
  const [customStatus, setCustomStatus] = useState('');
  const [statusModal, setStatusModal] = useState(false);
  const [statusInput, setStatusInput] = useState('');

  // ── Notifications state ────────────────────────────────────────────────────
  const [notifyDm, setNotifyDm] = useState(true);
  const [notifyFeed, setNotifyFeed] = useState(true);
  const [notifyGroups, setNotifyGroups] = useState(true);
  const [notifyPreview, setNotifyPreview] = useState(true);
  const [notifyMentions, setNotifyMentions] = useState(true);
  const [notifyVibrate, setNotifyVibrate] = useState(true);
  const [notifySound, setNotifySound] = useState(true);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [dndStart, setDndStart] = useState(22);
  const [dndEnd, setDndEnd] = useState(8);
  const [dndTimeModal, setDndTimeModal] = useState<'start' | 'end' | null>(null);
  const [dndTimeTmp, setDndTimeTmp] = useState(22);

  // ── Data state ─────────────────────────────────────────────────────────────
  // v4.32.248: пока выбор не сделан, здесь горел «Wi-Fi», а чаты скачивали
  // медиа всегда — значение по умолчанию у читателя настройки другое
  // (см. useAutoDownloadGate). Показываем то, что происходит на самом деле.
  const [autoDownload, setAutoDownload] = useState<'always' | 'wifi' | 'never'>('always');
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [lanPeerCount, setLanPeerCount] = useState(0);
  const [ipfsOnline, setIpfsOnline] = useState<boolean | null>(null);

  // ── Quick replies state ────────────────────────────────────────────────────
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickReplyInput, setQuickReplyInput] = useState('');
  const [editingQR, setEditingQR] = useState<QuickReply | null>(null);
  const [editingQRText, setEditingQRText] = useState('');

  // ── Language state ─────────────────────────────────────────────────────────
  const [translateLang, setTranslateLang] = useState('ru');
  const [allowCloudTranslate, setAllowCloudTranslate] = useState(false);

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => { void authGuard.hasPassword().then(setHasAppPassword); }, []);
  useEffect(() => { void isInternalDiagnosticsEnabled().then(setDiagUnlocked); }, []);

  useEffect(() => {
    void Promise.all([
      privacyPrefGet('privacy_last_seen_visibility'),
      privacyPrefGet('privacy_avatar_visibility'),
      privacyPrefGet('privacy_only_contacts_msg'),
      kvGet('notify_dm'),
      kvGet('notify_feed'),
      kvGet('notify_groups'),
      kvGet('notify_preview'),
      kvGet('auto_lock_on_exit'),
      kvGet('auto_lock_delay_ms'),
      kvGet('dnd_enabled'),
      kvGet('dnd_start'),
      kvGet('dnd_end'),
      privacyPrefGet('privacy_only_contacts_group'),
      kvGet('notify_mentions'),
      ownFieldGet('user_custom_status'),
      kvGet('auto_download_media'),
      privacyPrefGet('privacy_disable_read_receipts'),
      cloudTranslateAllowed(),
      scopedKvGet(TRANSLATION_TARGET_LANG_KEY),
      kvGet('notify_vibrate'),
      kvGet('notify_sound'),
      // v4.32.483: через общий геттер — запись живёт в namespace профиля, и
      // разбор значения (границы, мусор) один на всё приложение.
      getDefaultDisappearMs(),
      kvGet(LINK_PREVIEW_INCOMING_KEY),
    ]).then(([lsVis, avVis, onlyContacts, nDm, nFeed, nGroups, nPreview, lockEnabled, lockDelay, dndEn, dndS, dndE, onlyCtGrp, notMentions, custStatus, autoDl, disableRr, cloudTr, tgtLang, nVibrate, nSound, defAutoDelete, linkPrev]) => {
      if (lsVis === 'everybody' || lsVis === 'contacts' || lsVis === 'nobody') setLastSeenVisibility(lsVis);
      setAvatarVisibilityState(parseAvatarVisibility(avVis));
      setOnlyContactsCanMsg(onlyContacts === 'true');
      setNotifyDm(nDm !== 'false');
      setNotifyFeed(nFeed !== 'false');
      setNotifyGroups(nGroups !== 'false');
      setNotifyPreview(nPreview !== 'false');
      setAutoLockEnabled(lockEnabled === 'true');
      // v4.32.196 (Round-26 #8): clamp/validate numeric kv values. Corrupt or
      // stale entries could produce NaN/negative autolock delays or out-of-
      // range DnD hours (UI breaks, DnD silently disabled).
      const parseClamped = (s: string | undefined | null, def: number, min: number, max: number): number => {
        if (!s) return def;
        const n = parseInt(s, 10);
        return Number.isFinite(n) && n >= min && n <= max ? n : def;
      };
      setAutoLockDelayMs(parseClamped(lockDelay, 0, 0, 24 * 60 * 60 * 1000));
      setDndEnabled(dndEn === 'true');
      setDndStart(parseClamped(dndS, 22, 0, 23));
      setDndEnd(parseClamped(dndE, 8, 0, 23));
      setOnlyContactsCanAddToGroup(onlyCtGrp === 'true');
      setNotifyMentions(notMentions !== 'false');
      setNotifyVibrate(nVibrate !== 'false');
      // v4.32.375: см. peerStatus — в базе лежат строки, набранные прежним
      // здешним редактором: многострочные и до ста символов.
      setCustomStatus(normalizeOwnStatus(custStatus));
      if (autoDl === 'always' || autoDl === 'wifi' || autoDl === 'never') setAutoDownload(autoDl);
      setDisableReadReceipts(disableRr === 'true');
      setAllowCloudTranslate(cloudTr === true);
      setIncomingLinkPreview(parseIncomingLinkPreviewPref(linkPrev));
      if (tgtLang) setTranslateLang(tgtLang);
      setNotifySound(nSound !== 'false');
      // Границы (минута…год) проверены в parseAutoDeleteMs — здесь уже число
      // либо null, второй копии проверки быть не должно.
      if (defAutoDelete != null) setDefaultAutoDeleteMs(defAutoDelete);
    });
  }, [profileRefreshToken]);

  /**
   * v4.32.253: шаблоны быстрых ответов читались и создавались с зашитым
   * профилем 1, а показывает их в переписке AttachSheet по АКТИВНОМУ профилю.
   * На втором профиле это значило: список в настройках — чужой, а всё
   * добавленное там в чате не появлялось вовсе.
   */
  const loadQuickReplies = useCallback(() => {
    void listQuickReplies(profileManager.getActiveProfile()?.id ?? 1).then(setQuickReplies);
  }, []);
  useEffect(() => { loadQuickReplies(); }, [loadQuickReplies, profileRefreshToken]);

  useEffect(() => {
    const check = () => {
      if (tabRef.current !== 'settings') return;
      try {
        const lan = getLanTransportSingleton();
        setLanPeerCount(lan.getPeers().length);
      } catch { setLanPeerCount(0); }
      void import('../../core/transport/ipfs/node').then(({ ipfsId }) =>
        ipfsId().then((id) => setIpfsOnline(!!id)).catch(() => setIpfsOnline(false))
      );
    };
    check();
    const t = setInterval(check, 10_000);
    return () => clearInterval(t);
  }, [tabRef]);

  // ── Memos ──────────────────────────────────────────────────────────────────

  const loadSyncDevices = useCallback(async () => {
    setSyncDevicesBusy(true);
    setSyncDevicesError(null);
    try {
      const mnemonic = await getStoredMnemonic();
      if (!mnemonic) throw new Error('На устройстве нет секретных слов.');
      const pair = deriveKeyPairFromMnemonic(mnemonic);
      const [devices, currentId] = await Promise.all([
        listSyncDevices(mnemonic, pair),
        syncDeviceId(),
      ]);
      setSyncDevices(devices
        .filter((device) => !device.revokedAt)
        .sort((a, b) => {
          const aCurrent = a.deviceId === currentId ? 1 : 0;
          const bCurrent = b.deviceId === currentId ? 1 : 0;
          return bCurrent - aCurrent || b.lastSeenAt - a.lastSeenAt;
        }));
      setCurrentSyncDeviceId(currentId);
    } catch (error) {
      setSyncDevicesError(userErrorText(error, 'Не удалось загрузить список сессий.'));
      setSyncDevices([]);
    } finally {
      setSyncDevicesBusy(false);
    }
  }, []);

  const requestRevokeSyncDevice = useCallback((device: SyncDevice) => {
    if (device.deviceId === currentSyncDeviceId || revokingDeviceId !== null) return;
    Alert.alert(
      'Завершить сессию?',
      `${sessionDeviceName(device)}\n${sessionLocation(device)}`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Завершить',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRevokingDeviceId(device.deviceId);
              try {
                const mnemonic = await getStoredMnemonic();
                if (!mnemonic) throw new Error('На устройстве нет секретных слов.');
                const result = await revokeSyncDevice(mnemonic, deriveKeyPairFromMnemonic(mnemonic), device.deviceId);
                if (!result.ok) throw new Error('Сессия уже завершена или не найдена.');
                await loadSyncDevices();
                showSuccess('Сессия завершена');
              } catch (error) {
                setSyncDevicesError(userErrorText(error, 'Не удалось завершить сессию.'));
              } finally {
                setRevokingDeviceId(null);
              }
            })();
          },
        },
      ],
    );
  }, [currentSyncDeviceId, loadSyncDevices, revokingDeviceId]);

  const handleProfileIdentityUpdated = useCallback(() => {
    setProfileRefreshToken((value) => value + 1);
    onProfileIdentityUpdated?.();
  }, [onProfileIdentityUpdated]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const refreshPasswordFlag = useCallback(() => {
    void authGuard.hasPassword().then(setHasAppPassword);
  }, []);

  const submitSetPassword = async (): Promise<void> => {
    if (newPwd.length < authGuard.minPasswordLength) {
      showError(`Пароль не короче ${authGuard.minPasswordLength} символов`);
      return;
    }
    if (newPwd !== newPwd2) { showError('Пароли не совпадают'); return; }
    setPwdBusy(true);
    try {
      const ok = await authGuard.setPassword(newPwd);
      if (!ok) { showError('Не удалось сохранить пароль'); return; }
      showSuccess('Пароль сохранён');
      setSetPwdModal(false);
      setNewPwd('');
      setNewPwd2('');
      refreshPasswordFlag();
    } finally { setPwdBusy(false); }
  };

  const submitChangePassword = async (): Promise<void> => {
    if (newPwd.length < authGuard.minPasswordLength) {
      showError(`Новый пароль не короче ${authGuard.minPasswordLength} символов`);
      return;
    }
    if (newPwd !== newPwd2) { showError('Пароли не совпадают'); return; }
    setPwdBusy(true);
    try {
      const ok = await authGuard.changePassword(oldPwd, newPwd);
      // v4.32.315: смена пароля теперь под теми же пятью попытками, что и экран
      // блокировки, — значит и объяснять отказ надо так же, см. userFeedback.
      if (!ok) { await showPasswordRejected(); return; }
      showSuccess('Пароль обновлён');
      setChangePwdModal(false);
      setOldPwd('');
      setNewPwd('');
      setNewPwd2('');
      refreshPasswordFlag();
    } finally { setPwdBusy(false); }
  };

  const confirmLogout = useCallback(() => {
    if (!onLogout || logoutBusy) return;
    Alert.alert(
      'Выйти из аккаунта',
      'Удалить секретные слова и все локальные данные на этом устройстве? Восстановление будет возможно только из сохранённой копии слов.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить и выйти',
          style: 'destructive',
          onPress: () => {
            setLogoutBusy(true);
            void onLogout().finally(() => setLogoutBusy(false));
          },
        },
      ]
    );
  }, [onLogout, logoutBusy]);

  const handleExportBackup = useCallback(async () => {
    setBackupBusy(true);
    try {
      // v4.32.307: адрес берём у того, кто файл и записал. Имя собиралось здесь
      // вручную и по-старому — без `_p<id>`, — поэтому кнопка либо не находила
      // только что записанный файл, либо отдавала копию первого профиля из
      // любого профиля. Литерал имени остался ровно один, в dialogBackup.
      const uri = await exportDialogBackupToFile();
      if (!uri) { showError('Копию нечего экспортировать: сид-фраза недоступна'); return; }
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) { showError('Файл резервной копии не найден'); return; }
      // v4.32.310: на Android копия уходила как ТЕКСТ сообщения — весь JSON
      // целиком читался в строку и передавался в Share.share({ message }).
      //
      // Это ломалось ровно там, где копия и нужна. Intent идёт через Binder, у
      // транзакции предел около мегабайта на процесс, и переписка за пару
      // месяцев с вложениями его перекрывает: система отвечает
      // TransactionTooLargeException — то есть чем больше человеку есть что
      // терять, тем вернее кнопка «Поделиться» отказывала.
      //
      // А когда влезало — получалось не лучше: принимающее приложение видело
      // мегабайты текста, и «поделиться копией» в мессенджер отправляло стену
      // символов вместо файла, который потом нечем восстановить.
      //
      // expo-sharing отдаёт сам файл через FileProvider — тем же путём, каким
      // здесь уже уходят документы и медиа.
      const Sharing = await import('expo-sharing');
      if (Platform.OS !== 'ios' && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/json',
          dialogTitle: 'Резервная копия AirChat',
        });
      } else {
        await Share.share({ url: uri, title: 'Резервная копия AirChat' });
      }
    } catch (e) {
      showError(userErrorText(e, 'Ошибка экспорта'));
    } finally { setBackupBusy(false); }
  }, []);

  const handleShowSeed = useCallback(async () => {
    setSeedBusy(true);
    try {
      if (hasAppPassword) {
        const ok = await authGuard.verifyPassword(seedPwdInput);
        if (!ok) { await showPasswordRejected(); return; }
      }
      const mnemonic = await getStoredMnemonic();
      if (!mnemonic) { showError('Seed-фраза не найдена'); return; }
      setSeedPhrase(mnemonic);
    } finally { setSeedBusy(false); }
  }, [hasAppPassword, seedPwdInput]);

  const handleCloudUpload = useCallback(async () => {
    const validationError = validateCloudPassword(cloudPasswordInput);
    if (validationError) { showError(validationError); return; }
    setCloudBusy(true);
    try {
      const mnemonic = await getStoredMnemonic();
      if (!mnemonic) { showError('Seed-фраза не найдена'); return; }
      await uploadCloudVault(mnemonic, cloudPasswordInput);
      setCloudPasswordModal(false);
      setCloudPasswordInput('');
      showSuccess('Зашифрованная копия отправлена в облако');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось отправить облачную копию'));
    } finally {
      setCloudBusy(false);
    }
  }, [cloudPasswordInput]);

  const handleDialogBackupImport = useCallback(async () => {
    setBackupBusy(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const uri = result.assets[0]?.uri;
      if (!uri) { showError('Файл резервной копии не выбран'); return; }
      const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
      const restored = await importDialogBackupJson(raw);
      if (restored > 0) {
        showSuccess(`Восстановлено сообщений: ${restored}. Перезапустите приложение.`);
      } else {
        showError('Копия не импортирована: проверьте seed-фразу и убедитесь, что история на этом устройстве пуста.');
      }
    } catch (e) {
      showError(userErrorText(e, 'Не удалось импортировать историю'));
    } finally {
      setBackupBusy(false);
    }
  }, []);

  const loadCacheSize = useCallback(async () => {
    try {
      const dir = FileSystem.cacheDirectory;
      if (!dir) return;
      const entries = await FileSystem.readDirectoryAsync(dir);
      const sizes = await runWithConcurrency(entries, 8, async (name) => {
        try {
          const info = await FileSystem.getInfoAsync(`${dir}${name}`);
          return info.exists && 'size' in info ? (info as { size?: number }).size ?? 0 : 0;
        } catch { return 0; }
      });
      setCacheSize(sizes.reduce((total, size) => total + size, 0));
    } catch { setCacheSize(null); }
  }, []);

  const clearCache = useCallback(async () => {
    setCacheBusy(true);
    try {
      // v4.32.185 (Round-15 #7): удаляем только известные имена. Снести всё в
      // cacheDirectory значит испортить куски IPFS, недокачанные вложения и
      // буферы отправки.
      // v4.32.227: сюда же кэши зашифрованных вложений (расшифрованные снимки,
      // голосовые и файлы + шифртекст LAN) — они не убирались и росли без предела.
      // v4.32.310: список переехал в cacheFiles — там же, где эти имена и
      // создаются. Пока он жил здесь, экспорт переписки писал .txt под тремя
      // разными именами, и ни одно из них в список не входило: расшифрованная
      // беседа оставалась в кэше, сколько бы раз кэш ни чистили.
      await clearCacheFiles();
      await loadCacheSize();
      showSuccess('Кэш очищен');
    } catch { showError('Не удалось очистить кэш'); }
    finally { setCacheBusy(false); }
  }, [loadCacheSize]);

  useEffect(() => { void loadCacheSize(); }, [loadCacheSize]);

  const onVersionPress = useCallback(() => {
    const now = Date.now();
    if (now - versionTapRef.current.t > 4000) versionTapRef.current.n = 0;
    versionTapRef.current.t = now;
    versionTapRef.current.n += 1;
    if (versionTapRef.current.n >= 7) {
      versionTapRef.current.n = 0;
      void (async () => {
        await toggleInternalDiagnostics();
        setDiagUnlocked(await isInternalDiagnosticsEnabled());
      })();
    }
  }, []);

  // ── Async button wrappers (only for heavy async operations) ────────────────
  const exportBackupBtn = useAsyncButton(handleExportBackup, { throttleMs: 300 });
  const showSeedBtn = useAsyncButton(handleShowSeed, { throttleMs: 300 });
  const versionPressBtn = useAsyncButton(
    useCallback(async () => { onVersionPress(); }, [onVersionPress]),
    { throttleMs: 200 },
  );

  // ── Helpers ────────────────────────────────────────────────────────────────

  const autoDeleteLabel = (ms: number | null) => {
    if (!ms) return 'Выкл';
    if (ms >= 86_400_000 * 7) return '7 дней';
    if (ms >= 86_400_000) return '1 день';
    if (ms >= 3_600_000) return '1 час';
    return '1 мин';
  };

  const cacheSizeLabel = cacheSize !== null ? formatByteSize(cacheSize) : 'Вычисляется…';

  // ── Sub-screen header (instant back navigation) ────────────────────────────

  const SubHeader = ({ title }: { title: string }) => (
    <View style={styles.subHeader}>
      <AppPressable
        onPress={() => setSubScreen(null)}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 20 }}
        android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      >
        <Ionicons name="chevron-back" size={24} color={colors.accent} />
        <Text style={styles.backBtnText}>Назад</Text>
      </AppPressable>
      <Text style={styles.subTitle} numberOfLines={1}>{title}</Text>
      <View style={{ width: 36 }} />
    </View>
  );

  /**
   * Плашка состояния справа в строке: «Вкл» / «Выкл» / счётчик.
   *
   * v4.32.396: подложка была одна на все состояния и вписана в StyleSheet
   * ('#1a3d2e'), а рядом с ней жили ещё два правила — тон с прозрачностью на
   * месте вызова и пара литералов '#2196f3' / '#2196f322'. Теперь строка
   * называет ТОН, а подложка с надписью считаются из него парой.
   */
  const StatusBadge = ({ tone, text }: { tone: BadgeTone; text: string }) => {
    const tint = badgeTint(colors, tone);
    return (
      <View style={[styles.badge, { backgroundColor: tint.fill }]}>
        <Text style={[styles.badgeText, { color: tint.ink }]}>{text}</Text>
      </View>
    );
  };

  // ── Menu row helper ────────────────────────────────────────────────────────

  const MenuRow = ({
    iconName,
    hue,
    label,
    badge,
    onPress,
    testID,
  }: {
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    /** v4.32.392: ИМЯ тона, а не пара «цвет + тот же цвет с суффиксом 22». */
    hue: MenuIconHue;
    label: string;
    badge?: string;
    onPress: () => void;
    testID?: string;
  }) => {
    const tint = tintedIcon(hue, colors);
    return (
    <AppPressable
      style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
      onPress={onPress}
      testID={testID}
      android_ripple={{ color: colors.ripple }}
    >
      <View style={[styles.menuIcon, { backgroundColor: tint.fill }]}>
        <Ionicons name={iconName} size={20} color={tint.ink} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.label}>{label}</Text>
        {badge ? <Text style={styles.desc}>{badge}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </AppPressable>
    );
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAIN MENU ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderMainMenu = () => (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      testID="settings_screen"
    >
      <Text style={styles.h1}>Ещё</Text>

      {profilesEnabled ? (
        <>
          <Text style={styles.sectionTitle}>ПРОФИЛЬ</Text>
          <AppPressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={() => setSubScreen('profiles')}
            android_ripple={{ color: colors.ripple }}
          >
            <Ionicons name="people-outline" size={22} color={colors.text} />
            <View style={styles.rowBody}>
              <Text style={styles.label}>Профили</Text>
              <Text style={styles.desc}>Несколько профилей на одни секретные слова</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </AppPressable>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>ОСНОВНЫЕ</Text>
      <View style={styles.menuCard}>
        <MenuRow
          iconName="lock-closed-outline"
          hue="accent"
          label="Конфиденциальность"
          onPress={() => setSubScreen('privacy')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="notifications-outline"
          hue="pink"
          label="Уведомления и звуки"
          onPress={() => setSubScreen('notifications')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="color-palette-outline"
          hue="amber"
          label="Оформление"
          onPress={() => setSubScreen('appearance')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="server-outline"
          hue="green"
          label="Данные и хранилище"
          onPress={() => setSubScreen('data')}
        />
      </View>

      <Text style={styles.sectionTitle}>БЕЗОПАСНОСТЬ</Text>
      <View style={styles.menuCard}>
        <MenuRow
          iconName="shield-checkmark-outline"
          hue="purple"
          label="Безопасность"
          onPress={() => setSubScreen('security')}
        />
        {EMBEDDED_VPN_AVAILABLE && (
          <>
            <View style={styles.menuDivider} />
            <MenuRow
              iconName="lock-closed-outline"
              hue="teal"
              label="VPN (обход блокировок)"
              onPress={() => setSubScreen('vpn')}
              testID="settings_vpn_row"
            />
          </>
        )}
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="cloud-outline"
          hue="sky"
          label="Сервер доставки"
          onPress={() => setSubScreen('relay')}
          testID="settings_relay_row"
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="ban-outline"
          hue="red"
          label="Заблокированные"
          onPress={() => setSubScreen('blocked')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="notifications-off-outline"
          hue="grey"
          label="Заглушённые"
          onPress={() => setSubScreen('muted')}
        />
      </View>

      <Text style={styles.sectionTitle}>ЕЩЁ</Text>
      <View style={styles.menuCard}>
        <MenuRow
          iconName="flash-outline"
          hue="cyan"
          label="Быстрые ответы"
          badge={quickReplies.length > 0 ? `${quickReplies.length} шаблон${quickReplies.length === 1 ? '' : quickReplies.length < 5 ? 'а' : 'ов'}` : undefined}
          onPress={() => setSubScreen('quick_replies')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="language-outline"
          hue="blue"
          label="Язык перевода"
          badge={translateLang === 'ru' ? 'Русский' : translateLang.toUpperCase()}
          onPress={() => setSubScreen('language')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="archive-outline"
          hue="ice"
          label="Резервная копия"
          onPress={() => setSubScreen('backup')}
        />
      </View>

      <Text style={styles.sectionTitle}>МОЙ СТАТУС</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        onPress={() => { setStatusInput(customStatus); setStatusModal(true); }}
        android_ripple={{ color: colors.ripple }}
      >
        <Ionicons name="happy-outline" size={22} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={styles.label}>Статус</Text>
          <Text style={styles.desc} numberOfLines={1}>{customStatus || 'Не задан'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>ПОМОЩЬ</Text>
      <View style={styles.menuCard}>
        <MenuRow
          iconName="information-circle-outline"
          hue="slate"
          label="О приложении"
          onPress={() => setSubScreen('about')}
        />
        <View style={styles.menuDivider} />
        <MenuRow
          iconName="shield-outline"
          hue="slate"
          label="Политика конфиденциальности"
          onPress={() => setSubScreen('privacy-policy')}
        />
        {diagUnlocked ? (
          <>
            <View style={styles.menuDivider} />
            <MenuRow
              iconName="pulse-outline"
              hue="slate"
              label="Диагностика связи"
              onPress={() => setSubScreen('diagnostics')}
              testID="settings_diagnostics"
            />
          </>
        ) : null}
      </View>

      {onLogout ? (
        <>
          <Text style={styles.sectionTitle}>АККАУНТ</Text>
          <AppPressable
            style={styles.logoutRow}
            onPress={confirmLogout}
            disabled={logoutBusy}
            testID="btn_logout_wipe"
            accessibilityRole="button"
            accessibilityLabel="Выйти и удалить данные на устройстве"
          >
            {logoutBusy ? <ActivityIndicator color={colors.error} /> : <Ionicons name="log-out-outline" size={22} color={colors.error} />}
            <View style={styles.rowBody}>
              <Text style={styles.logoutLabel}>Выйти и удалить данные на устройстве</Text>
              <Text style={styles.desc}>Секретные слова и ключи будут стёрты с этого телефона</Text>
            </View>
          </AppPressable>
        </>
      ) : null}

      <AppPressable onPress={versionPressBtn.onPress} style={styles.versionTap} accessibilityRole="text">
        <Text style={styles.versionText}>Версия {appVersion}</Text>
      </AppPressable>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── PRIVACY ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderPrivacy = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Конфиденциальность" />

      <Text style={styles.sectionTitle}>Последний визит и статус «онлайн»</Text>
      {/* v4.32.238: подпись описывает то, что происходит на самом деле.
          Сервера нет: время входа считает приложение собеседника, и выбор
          доставляется ему как просьба. Своя половина — взаимность — работает
          всегда, поэтому названа отдельно. */}
      <Text style={styles.hint}>
        Кто видит, когда вы были в сети. Выбор отправляется собеседникам, и их
        приложение перестаёт отмечать ваше время. Выбрав «Никто», вы также
        перестанете видеть, когда в сети были другие.
      </Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingVertical: 12 }}>
          {([['everybody', 'Все'], ['contacts', 'Контакты'], ['nobody', 'Никто']] as ['everybody' | 'contacts' | 'nobody', string][]).map(([val, label]) => (
            <AppPressable
              key={val}
              onPress={() => {
                setLastSeenVisibility(val);
                setMyLastSeenVisibility(val);
                void privacyPrefSet('privacy_last_seen_visibility', val).then(() => broadcastLastSeenPref());
              }}
              style={{
                paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.xl,
                backgroundColor: lastSeenVisibility === val ? colors.primary : colors.background,
                borderWidth: 1, borderColor: lastSeenVisibility === val ? colors.primary : colors.border,
              }}
            >
              <Text style={{ color: lastSeenVisibility === val ? primaryOn : colors.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
            </AppPressable>
          ))}
        </View>
      </View>

      {/*
        v4.32.540: фотография профиля была единственным полем карточки без
        собственного решения — поставил один раз, и она уезжала всем, с кем
        идёт переписка. Отозвать её было нечем, кроме как удалить у себя.
        Подпись говорит ровно то, что делает код: настройка управляет
        РАССЫЛКОЙ карточки, а уже полученную кем-то фотографию она забрать не
        может — как и любая настройка в переписке без сервера.
      */}
      <Text style={styles.sectionTitle}>Фотография профиля</Text>
      <Text style={styles.hint}>
        Кому уходит ваше фото вместе с карточкой профиля. Тот, кто получил его
        раньше, сохранит свою копию: отозвать уже отправленное нельзя.
      </Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingVertical: 12 }}>
          {([['everybody', 'Все'], ['contacts', 'Контакты'], ['nobody', 'Никто']] as [AvatarVisibility, string][]).map(([val, label]) => (
            <AppPressable
              key={val}
              accessibilityRole="radio"
              accessibilityState={{ selected: avatarVisibility === val }}
              onPress={() => {
                setAvatarVisibilityState(val);
                // Новую карточку разошлём сразу: иначе выбор «Никто» вступал бы
                // в силу только при следующей правке профиля.
                void setAvatarVisibility(val).then(() => broadcastMyProfile());
              }}
              style={{
                paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.xl,
                backgroundColor: avatarVisibility === val ? colors.primary : colors.background,
                borderWidth: 1, borderColor: avatarVisibility === val ? colors.primary : colors.border,
              }}
            >
              <Text style={{ color: avatarVisibility === val ? primaryOn : colors.text, fontSize: font.sm, fontWeight: '600' }}>{label}</Text>
            </AppPressable>
          ))}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Сообщения</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Сообщения только от контактов</Text>
            <Text style={styles.desc}>Незнакомцы не смогут написать вам</Text>
          </View>
          <AppSwitch value={onlyContactsCanMsg} onValueChange={(v) => { setOnlyContactsCanMsg(v); void privacyPrefSet('privacy_only_contacts_msg', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Добавление в группы — только контакты</Text>
            <Text style={styles.desc}>Незнакомцы не смогут добавить вас в группу</Text>
          </View>
          <AppSwitch value={onlyContactsCanAddToGroup} onValueChange={(v) => { setOnlyContactsCanAddToGroup(v); void privacyPrefSet('privacy_only_contacts_group', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Не отправлять уведомления о прочтении</Text>
            <Text style={styles.desc}>Отправители не будут видеть, что вы прочли их сообщения</Text>
          </View>
          <AppSwitch value={disableReadReceipts} onValueChange={(v) => { setDisableReadReceipts(v); void privacyPrefSet('privacy_disable_read_receipts', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Предпросмотр ссылок из входящих</Text>
            <Text style={styles.desc}>Выключено: чужая ссылка не загрузится сама и не выдаст ваш IP-адрес. Свои ссылки в поле ввода показываются всегда</Text>
          </View>
          <AppSwitch value={incomingLinkPreview} onValueChange={(v) => { setIncomingLinkPreview(v); void kvSet(LINK_PREVIEW_INCOMING_KEY, String(v)); }} />
        </View>
        <View style={[styles.switchRow, styles.switchRowLast]}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Облачный перевод</Text>
            <Text style={styles.desc}>Выключено: перевод не работает, зато текст не покидает устройство. Включённый отправляет переводимое сообщение на сторонний сервис api.mymemory.translated.net в открытом виде — шифрование до него не доходит. Решение своё у каждого аккаунта</Text>
          </View>
          <AppSwitch value={allowCloudTranslate} onValueChange={(v) => { setAllowCloudTranslate(v); void setCloudTranslateAllowed(v); }} />
        </View>
      </View>

      <Text style={styles.sectionTitle}>Автоудаление новых чатов</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => {
          Alert.alert('Автоудаление по умолчанию', `Текущее: ${autoDeleteLabel(defaultAutoDeleteMs)}`, [
            { text: 'Выкл', onPress: () => { setDefaultAutoDeleteMs(null); void setDefaultDisappearMs(null); } },
            { text: '1 мин', onPress: () => { setDefaultAutoDeleteMs(60_000); void setDefaultDisappearMs(60_000); } },
            { text: '1 час', onPress: () => { setDefaultAutoDeleteMs(3_600_000); void setDefaultDisappearMs(3_600_000); } },
            { text: '1 день', onPress: () => { setDefaultAutoDeleteMs(86_400_000); void setDefaultDisappearMs(86_400_000); } },
            { text: '7 дней', onPress: () => { setDefaultAutoDeleteMs(7 * 86_400_000); void setDefaultDisappearMs(7 * 86_400_000); } },
            { text: 'Отмена', style: 'cancel' },
          ]);
        }}
      >
        <Ionicons name="timer-outline" size={22} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={styles.label}>Автоудаление новых чатов</Text>
          <Text style={styles.desc}>По умолчанию для новых разговоров</Text>
        </View>
        <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 13 }}>{autoDeleteLabel(defaultAutoDeleteMs)}</Text>
      </AppPressable>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── NOTIFICATIONS ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderNotifications = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Уведомления и звуки" />

      <Text style={styles.sectionTitle}>Типы уведомлений</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Личные сообщения</Text>
            <Text style={styles.desc}>Уведомлять о новых сообщениях</Text>
          </View>
          <AppSwitch value={notifyDm} onValueChange={(v) => { setNotifyDm(v); void kvSet('notify_dm', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Группы и каналы</Text>
            <Text style={styles.desc}>Уведомлять о новых сообщениях в группах</Text>
          </View>
          <AppSwitch value={notifyGroups} onValueChange={(v) => { setNotifyGroups(v); void kvSet('notify_groups', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Лента</Text>
            <Text style={styles.desc}>Уведомлять о новых публикациях контактов</Text>
          </View>
          <AppSwitch value={notifyFeed} onValueChange={(v) => { setNotifyFeed(v); void kvSet('notify_feed', String(v)); }} />
        </View>
        <View style={[styles.switchRow, styles.switchRowLast]}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Упоминания (@имя)</Text>
            <Text style={styles.desc}>Отдельное уведомление при упоминании в группе</Text>
          </View>
          <AppSwitch value={notifyMentions} onValueChange={(v) => { setNotifyMentions(v); void kvSet('notify_mentions', String(v)); }} />
        </View>
      </View>

      <Text style={styles.sectionTitle}>Параметры</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Показывать содержимое</Text>
            <Text style={styles.desc}>Текст сообщений в уведомлениях</Text>
          </View>
          <AppSwitch value={notifyPreview} onValueChange={(v) => { setNotifyPreview(v); void kvSet('notify_preview', String(v)); }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Вибрация</Text>
            <Text style={styles.desc}>Вибросигнал при получении уведомления</Text>
          </View>
          <AppSwitch value={notifyVibrate} onValueChange={(v) => { setNotifyVibrate(v); void kvSet('notify_vibrate', String(v)); }} />
        </View>
        <View style={[styles.switchRow, styles.switchRowLast]}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Звук уведомления</Text>
            <Text style={styles.desc}>Воспроизводить звук при новом сообщении</Text>
          </View>
          <AppSwitch value={notifySound} onValueChange={(v) => { setNotifySound(v); void kvSet('notify_sound', String(v)); }} />
        </View>
      </View>

      <Text style={styles.sectionTitle}>Режим «Не беспокоить»</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Тихие часы</Text>
            <Text style={styles.desc}>Уведомления отключены в заданные часы</Text>
          </View>
          <AppSwitch
            value={dndEnabled}
            onValueChange={(v) => { setDndEnabled(v); void kvSet('dnd_enabled', String(v)); }}
          />
        </View>
        {dndEnabled ? (
          <View style={[styles.switchRow, styles.switchRowLast, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
            <Text style={[styles.label, { flex: 1 }]}>Часы</Text>
            <AppPressable onPress={() => { setDndTimeTmp(dndStart); setDndTimeModal('start'); }} style={{ backgroundColor: colors.surfaceHigh, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ color: colors.accent, fontWeight: '600' }}>{String(dndStart).padStart(2, '0')}:00</Text>
            </AppPressable>
            <Text style={{ color: colors.textMuted }}>–</Text>
            <AppPressable onPress={() => { setDndTimeTmp(dndEnd); setDndTimeModal('end'); }} style={{ backgroundColor: colors.surfaceHigh, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ color: colors.accent, fontWeight: '600' }}>{String(dndEnd).padStart(2, '0')}:00</Text>
            </AppPressable>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── APPEARANCE ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderAppearance = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Оформление" />

      <Text style={styles.sectionTitle}>Тема оформления</Text>
      <View style={styles.card}>
        <View style={styles.themeRow}>
          {(['dark', 'light', 'system'] as const).map((m) => {
            const labels = { dark: 'Тёмная', light: 'Светлая', system: 'Системная' };
            const icons = { dark: 'moon', light: 'sunny', system: 'contrast' } as const;
            const active = themeMode === m;
            return (
              <AppPressable key={m} style={[styles.themeBtn, active && styles.themeBtnActive]} onPress={() => void setThemeMode(m)} accessibilityRole="radio" accessibilityState={{ selected: active }}>
                <Ionicons name={icons[m]} size={18} color={active ? primaryOn : colors.textSecondary} />
                <Text style={[styles.themeBtnText, active && styles.themeBtnTextActive]}>{labels[m]}</Text>
              </AppPressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Размер текста</Text>
      <View style={styles.card}>
        <View style={styles.themeRow}>
          {FONT_SIZE_OPTIONS.map((opt) => {
            const active = fontSize === opt.value;
            return (
              <AppPressable key={opt.value} style={[styles.themeBtn, active && styles.themeBtnActive, { flex: 1, minWidth: 0 }]} onPress={() => void setFontSize(opt.value as FontSizeValue)} accessibilityRole="radio" accessibilityState={{ selected: active }}>
                <Text style={{ fontSize: opt.value - 3, fontWeight: '700', color: active ? primaryOn : colors.textSecondary }}>А</Text>
                <Text style={[styles.themeBtnText, active && styles.themeBtnTextActive, { fontSize: font.xs }]}>{opt.label}</Text>
              </AppPressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Ночной режим по расписанию</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Автоматически</Text>
            <Text style={styles.desc}>
              {autoNightEnabled
                ? `Тёмная: ${String(autoNightStart).padStart(2, '0')}:00 – ${String(autoNightEnd).padStart(2, '0')}:00`
                : 'Включать тёмную тему по расписанию'}
            </Text>
          </View>
          <AppSwitch
            value={autoNightEnabled}
            onValueChange={(v) => {
              if (v) { setNightStartTmp(autoNightStart); setNightEndTmp(autoNightEnd); setNightTimeModal(true); }
              else { void setAutoNight(false, autoNightStart, autoNightEnd); }
            }}
          />
        </View>
        {autoNightEnabled ? (
          <AppPressable onPress={() => { setNightStartTmp(autoNightStart); setNightEndTmp(autoNightEnd); setNightTimeModal(true); }} style={{ paddingBottom: 10, paddingHorizontal: 4 }}>
            <Text style={{ color: colors.accent, fontSize: 13 }}>
              Изменить время ({String(autoNightStart).padStart(2, '0')}:00 – {String(autoNightEnd).padStart(2, '0')}:00)
            </Text>
          </AppPressable>
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>Цвет акцента</Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 10 }}>
          {[null, ...ACCENT_SWATCHES].map((entry) => {
            const c = entry?.hex ?? null;
            const swatch = c ?? defaultAccent;
            const selected = accentColor === c || (!accentColor && !c);
            // Галочка и подпись — чёрные или белые по яркости самого образца.
            // v4.32.347: на нынешнем наборе это всегда белый, и так и задумано —
            // образцы подобраны под белую надпись. Проверка оставлена, чтобы
            // правильность галочки не зависела от того, что список не изменится.
            const ink = contrastingInk(swatch);
            return (
            <AppPressable
              key={c ?? 'default'}
              onPress={() => void setAccentColor(c)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              // Скринридер читал вслух шестнадцатеричный код — «решётка, эф,
              // четыре, четыре…». Теперь название цвета.
              accessibilityLabel={entry ? `Цвет акцента: ${entry.name}` : 'Цвет акцента по умолчанию'}
              // v4.32.528: было 34×34 — меньше минимальной цели касания (44).
              // Образцы стоят вплотную сеткой, то есть промах попадал не в
              // пустоту, а в соседний цвет: «нажал не туда» здесь означало
              // «перекрасил приложение».
              style={{
                width: TOUCH_TARGET_MIN, height: TOUCH_TARGET_MIN, borderRadius: radius.full,
                backgroundColor: swatch,
                borderWidth: selected ? 3 : 1,
                // Обводка выбранного образца лежит на фоне карточки, а не на
                // самом образце: белая обводка на белой карточке пропадала.
                borderColor: selected ? colors.text : 'transparent',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              {/* Или галочка, или значок сброса. Раньше у выбранного образца
                  «по умолчанию» рисовались обе — галочка ложилась поверх текста
                  внутри кружка 34px, и не читалось ни то, ни другое.

                  v4.32.528: сам текст «По\nумол.» тоже убран. Он был набран
                  восьмым кеглем в две строки — вдвое ниже порога читаемости, и
                  иначе в кружок не влезал. Значок сброса говорит то же самое
                  («вернуть исходный цвет») и читается; полное название по-
                  прежнему произносит accessibilityLabel выше. */}
              {selected ? (
                <Ionicons name="checkmark" size={18} color={ink} />
              ) : c === null ? (
                <Ionicons name="refresh" size={18} color={ink} />
              ) : null}
            </AppPressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── DATA & STORAGE ─────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderData = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Данные и хранилище" />

      <Text style={styles.sectionTitle}>Авто-скачивание медиа</Text>
      <View style={styles.card}>
        <View style={styles.themeRow}>
          {([['always', 'Всегда'], ['wifi', 'Wi-Fi'], ['never', 'Никогда']] as const).map(([val, label]) => {
            const active = autoDownload === val;
            return (
              <AppPressable key={val} style={[styles.themeBtn, active && styles.themeBtnActive, { flex: 1 }]} onPress={() => { setAutoDownload(val); void kvSet('auto_download_media', val); }}>
                <Text style={[styles.themeBtnText, active && styles.themeBtnTextActive]}>{label}</Text>
              </AppPressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionTitle}>Кэш</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Ionicons name="server-outline" size={22} color={colors.accent} style={{ marginRight: 10 }} />
          <View style={styles.rowBody}>
            <Text style={styles.label}>Размер кэша</Text>
            <Text style={styles.desc}>{cacheSizeLabel}</Text>
          </View>
        </View>
      </View>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        onPress={() => void clearCache()}
        disabled={cacheBusy}
        android_ripple={{ color: colors.ripple }}
      >
        {cacheBusy ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="trash-outline" size={22} color={colors.text} />}
        <View style={styles.rowBody}>
          <Text style={styles.label}>Очистить кэш</Text>
          <Text style={styles.desc}>Удалить временные файлы и освободить место</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>Распределённое облако</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Распределённое облако</Text>
            <Text style={styles.desc}>Сообщения синхронизируются через защищённое хранилище</Text>
          </View>
          <StatusBadge tone="success" text="Вкл" />
        </View>
      </View>

      <Text style={styles.sectionTitle}>История сообщений</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => {
          Alert.alert(
            'Очистить историю сообщений',
            'Все личные сообщения и сообщения из групп будут удалены с этого устройства. Контакты и группы сохранятся.',
            [
              { text: 'Отмена', style: 'cancel' },
              {
                text: 'Очистить',
                style: 'destructive',
                // v4.32.253: профиль был зашит единицей — на втором профиле
                // кнопка чистила чужую переписку, а свою оставляла на месте.
                onPress: () => {
                  const pid = profileManager.getActiveProfile()?.id ?? 1;
                  void clearAllMessageHistory(pid).then((ok) => {
                    if (ok) showSuccess('История очищена');
                    else showError('Не удалось очистить историю');
                  });
                },
              },
            ]
          );
        }}
      >
        <Ionicons name="trash-bin-outline" size={22} color={colors.error} />
        <View style={styles.rowBody}>
          <Text style={[styles.label, { color: colors.error }]}>Очистить историю сообщений</Text>
          <Text style={styles.desc}>Удалить все сообщения с устройства</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>Статус связи</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Ionicons name="globe-outline" size={22} color={ipfsOnline ? colors.success : colors.textMuted} style={{ marginRight: 10 }} />
          <View style={styles.rowBody}>
            <Text style={styles.label}>Интернет (IPFS)</Text>
            <Text style={styles.desc}>{ipfsOnline === null ? 'Проверка…' : ipfsOnline ? 'Подключён' : 'Нет соединения'}</Text>
          </View>
          <StatusBadge tone={ipfsOnline ? 'success' : 'muted'} text={ipfsOnline ? 'Вкл' : 'Выкл'} />
        </View>
        {/* В браузере строки нет вовсе: «0 устройств» там значило бы «искали и
            не нашли», а на деле поиск невозможен — см. platformCapabilities. */}
        {LOCAL_RADIO_TRANSPORTS_AVAILABLE && (
          <View style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
            <Ionicons name="wifi-outline" size={22} color={lanPeerCount > 0 ? colors.accent : colors.textMuted} style={{ marginRight: 10 }} />
            <View style={styles.rowBody}>
              <Text style={styles.label}>Wi-Fi LAN</Text>
              <Text style={styles.desc}>{lanPeerCount > 0 ? `${lanPeerCount} устройств в сети` : 'Нет устройств рядом'}</Text>
            </View>
            <StatusBadge tone={lanPeerCount > 0 ? 'accent' : 'muted'} text={lanPeerCount > 0 ? String(lanPeerCount) : '0'} />
          </View>
        )}
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SECURITY ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderSecurity = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Безопасность" />

      <Text style={styles.sectionTitle}>Пароль приложения</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => hasAppPassword ? setChangePwdModal(true) : setSetPwdModal(true)}
        testID="settings_change_password"
      >
        <Ionicons name="key-outline" size={22} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={styles.label}>{hasAppPassword ? 'Сменить пароль' : 'Установить пароль'}</Text>
          <Text style={styles.desc}>{hasAppPassword ? 'Изменить текущий пароль приложения' : 'Защитить приложение паролем'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>Автоблокировка</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.rowBody}>
            <Text style={styles.label}>Блокировать при выходе</Text>
            <Text style={styles.desc}>Требовать пароль при следующем открытии</Text>
          </View>
          <AppSwitch value={autoLockEnabled} onValueChange={(v) => { setAutoLockEnabled(v); void kvSet('auto_lock_on_exit', String(v)); }} />
        </View>
        {autoLockEnabled ? (
          <View style={[styles.switchRow, styles.switchRowLast]}>
            <View style={styles.rowBody}>
              <Text style={styles.label}>Задержка блокировки</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {([0, 60_000, 300_000, 1_800_000] as const).map((ms) => {
                const label = ms === 0 ? 'Сразу' : ms === 60_000 ? '1 мин' : ms === 300_000 ? '5 мин' : '30 мин';
                const active = autoLockDelayMs === ms;
                return (
                  <AppPressable key={ms}
                    onPress={() => { setAutoLockDelayMs(ms); void kvSet('auto_lock_delay_ms', String(ms)); }}
                    style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.lg, backgroundColor: active ? colors.primary : colors.background, borderWidth: 1, borderColor: active ? colors.primary : colors.border }}
                  >
                    <Text style={{ color: active ? primaryOn : colors.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
                  </AppPressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>Активные сессии</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => { setActiveSessionsVisible(true); void loadSyncDevices(); }}
      >
        <Ionicons name="shield-checkmark-outline" size={22} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={styles.label}>Активные сессии</Text>
          <Text style={styles.desc}>
            {syncDevices.length > 0
              ? `${syncDevices.length} ${syncDevices.length === 1 ? 'устройство' : syncDevices.length < 5 ? 'устройства' : 'устройств'}`
              : 'Авторизованные устройства аккаунта'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── VPN ────────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderVpn = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="VPN" />
      <VpnSettingsSection />
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── RELAY ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderRelay = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Сервер доставки" />
      <RelaySettingsSection />
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── BLOCKED ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderBlocked = () => (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={styles.content}>
        <SubHeader title="Заблокированные" />
        <Text style={styles.hint}>С этими контактами сообщения не принимаются и не отправляются.</Text>
      </View>
      <View style={styles.listWrap}>
        <BlockedContactsList />
      </View>
    </View>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MUTED ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // v4.32.181 (Round-10 deferred → shipped): subscreen listing per-entity mutes
  // (chat / group / channel / post). User can unmute directly — previously the
  // only entry point was per-chat overflow menu, so expired-but-not-swept or
  // forgotten mutes accumulated invisibly.

  const [mutedList, setMutedList] = useState<MuteEntry[]>([]);
  useEffect(() => {
    if (subScreen !== 'muted') return;
    let cancelled = false;
    void (async () => {
      const list = await listMuted();
      if (!cancelled) setMutedList(list);
    })();
    return () => { cancelled = true; };
  }, [subScreen]);

  const handleUnmute = useCallback(async (entry: MuteEntry) => {
    await unmute(entry.kind, entry.id);
    setMutedList((prev) => prev.filter((m) => !(m.kind === entry.kind && m.id === entry.id)));
    showSuccess('Включены уведомления');
  }, []);

  const renderMuted = () => {
    const kindLabel = (k: MuteEntry['kind']) =>
      k === 'chat' ? 'Чат' : k === 'group' ? 'Группа' : k === 'channel' ? 'Канал' : 'Пост';
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={styles.content}>
          <SubHeader title="Заглушённые" />
          <Text style={styles.hint}>
            Чаты, группы и каналы, для которых отключены уведомления. Данные и сообщения продолжают приходить.
          </Text>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
          {mutedList.length === 0 ? (
            <Text style={[styles.hint, { textAlign: 'center', marginTop: 40 }]}>
              Список пуст — уведомления включены везде.
            </Text>
          ) : (
            mutedList.map((m) => {
              const idShort = shortIdentity(m.id, 10);
              const untilText = m.untilMs
                ? `До ${fullDateTime(m.untilMs)}`
                : 'Бессрочно';
              return (
                <View key={`${m.kind}:${m.id}`} style={[styles.linkRow, { alignItems: 'center' }]}>
                  <Ionicons name="notifications-off-outline" size={20} color={colors.textMuted} />
                  <View style={[styles.rowBody, { flex: 1 }]}>
                    <Text style={styles.label} numberOfLines={1}>{kindLabel(m.kind)}</Text>
                    <Text style={styles.desc} numberOfLines={1}>{idShort}</Text>
                    <Text style={[styles.desc, { fontSize: font.xs }]} numberOfLines={1}>{untilText}</Text>
                  </View>
                  <AppPressable
                    onPress={() => void handleUnmute(m)}
                    android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
                    accessibilityRole="button"
                    accessibilityLabel="Снять заглушение"
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ padding: 6 }}
                  >
                    <Ionicons name="notifications-outline" size={22} color={colors.accent} />
                  </AppPressable>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    );
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ── BACKUP ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderBackup = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Резервная копия" />

      <Text style={styles.sectionTitle}>Резервная копия переписок</Text>
      <View style={styles.card}>
        <Text style={[styles.desc, { paddingVertical: 10 }]}>
          Резервная копия содержит историю переписок (в зашифрованном виде). Сохраните файл на устройстве или в облаке.
        </Text>
      </View>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={exportBackupBtn.onPress}
        disabled={backupBusy}
      >
        {backupBusy ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="archive-outline" size={22} color={colors.text} />}
        <View style={styles.rowBody}>
          <Text style={styles.label}>Создать и поделиться копией</Text>
          <Text style={styles.desc}>Экспортировать зашифрованный .json файл</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>Облачная копия</Text>
      <View style={styles.card}>
        <Text style={[styles.desc, { paddingVertical: 10 }]}>Сид-фраза и облачный пароль нужны вместе. На сервер отправляется только зашифрованная копия профиля, баз и аватаров.</Text>
      </View>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => { setCloudPasswordInput(''); setCloudPasswordModal(true); }}
        disabled={!isCloudVaultConfigured() || cloudBusy}
      >
        {cloudBusy ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="cloud-upload-outline" size={22} color={isCloudVaultConfigured() ? colors.text : colors.textMuted} />}
        <View style={styles.rowBody}>
          <Text style={[styles.label, !isCloudVaultConfigured() && { color: colors.textMuted }]}>Сохранить в облако</Text>
          <Text style={styles.desc}>{isCloudVaultConfigured() ? 'Защитить копию дополнительным паролем' : 'Сервер облачных копий не настроен'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => { void handleDialogBackupImport(); }}
        disabled={backupBusy}
      >
        {backupBusy ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="download-outline" size={22} color={colors.text} />}
        <View style={styles.rowBody}>
          <Text style={styles.label}>Импортировать историю из файла</Text>
          <Text style={styles.desc}>Выберите JSON-копию чатов из приложения</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>

      <Text style={styles.sectionTitle}>Seed-фраза</Text>
      <AppPressable
        style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        android_ripple={{ color: colors.ripple }}
        onPress={() => { setSeedPhrase(null); setSeedPwdInput(''); setSeedModal(true); }}
      >
        <Ionicons name="key-outline" size={22} color={colors.text} />
        <View style={styles.rowBody}>
          <Text style={styles.label}>Показать seed-фразу</Text>
          <Text style={styles.desc}>24 слова — единственный способ восстановить аккаунт</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
      </AppPressable>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── QUICK REPLIES ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderQuickReplies = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Быстрые ответы" />
      <Text style={styles.hint}>Сохранённые шаблоны для быстрой отправки в чатах.</Text>

      {quickReplies.map((qr) => (
        <View key={qr.id} style={[styles.linkRow, { alignItems: 'flex-start' }]}>
          {/* v4.32.582: шаблон, не открывшийся ключом, раньше рисовался пустой
              строкой между карандашом и корзиной — как будто был сохранён
              пустым. Правка остаётся доступной: это и есть способ его заменить. */}
          <Ionicons
            name={templateReadable(qr) ? 'flash-outline' : 'alert-circle-outline'}
            size={20}
            color={templateReadable(qr) ? colors.accent : colors.warning}
            style={{ marginTop: 2 }}
          />
          <View style={[styles.rowBody, { flex: 1 }]}>
            <Text
              style={[styles.label, { fontSize: 14 }, templateReadable(qr) ? null : { color: colors.textMuted, fontStyle: 'italic' }]}
              numberOfLines={2}
            >{templateReadable(qr) ? qr.text : UNREADABLE_TEMPLATE_TEXT}</Text>
          </View>
          <AppPressable onPress={() => { setEditingQR(qr); setEditingQRText(qr.text); }} style={{ padding: 6 }}>
            <Ionicons name="pencil-outline" size={18} color={colors.textMuted} />
          </AppPressable>
          <AppPressable onPress={() => { void deleteQuickReply(qr.id).then(loadQuickReplies); }} style={{ padding: 6 }}>
            <Ionicons name="trash-outline" size={18} color={colors.error} />
          </AppPressable>
        </View>
      ))}

      <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: quickReplies.length > 0 ? 8 : 0 }]}>
        <TextInput
          style={[styles.pwdInput, { flex: 1, marginBottom: 0 }]}
          placeholder="Новый шаблон…"
          placeholderTextColor={colors.textMuted}
          value={quickReplyInput}
          onChangeText={setQuickReplyInput}
          multiline
          maxLength={200}
        />
        <AppPressable
          onPress={() => {
            if (!quickReplyInput.trim()) return;
            void addQuickReply(profileManager.getActiveProfile()?.id ?? 1, quickReplyInput).then(() => { setQuickReplyInput(''); loadQuickReplies(); });
          }}
          style={{ backgroundColor: colors.primary, borderRadius: radius.md, padding: 10 }}
        >
          <Ionicons name="add" size={20} color={primaryOn} />
        </AppPressable>
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── LANGUAGE ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderLanguage = () => (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <SubHeader title="Язык перевода" />
      <Text style={styles.sectionTitle}>Язык перевода сообщений</Text>
      <Text style={styles.hint}>Целевой язык авто-перевода входящих сообщений</Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 6 }}>
          {([
            { code: 'ru', label: 'Русский' },
            { code: 'en', label: 'English' },
            { code: 'de', label: 'Deutsch' },
            { code: 'fr', label: 'Français' },
            { code: 'es', label: 'Español' },
            { code: 'it', label: 'Italiano' },
            { code: 'uk', label: 'Українська' },
            { code: 'zh', label: '中文' },
            { code: 'ja', label: '日本語' },
            { code: 'ar', label: 'العربية' },
            { code: 'pt', label: 'Português' },
            { code: 'tr', label: 'Türkçe' },
          ] as const).map(({ code, label }) => {
            const active = translateLang === code;
            return (
              <AppPressable key={code} style={[styles.themeBtn, active && styles.themeBtnActive, { paddingHorizontal: 10 }]} onPress={() => { setTranslateLang(code); void scopedKvSet(TRANSLATION_TARGET_LANG_KEY, code); }}>
                <Text style={[styles.themeBtnText, active && styles.themeBtnTextActive]}>{label}</Text>
              </AppPressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ALL MODALS (always in tree) ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const renderModals = () => (
    <>
      {/* Active Sessions */}
      <Modal visible={activeSessionsVisible} transparent animationType="fade" onRequestClose={() => setActiveSessionsVisible(false)}>
        <AppPressable style={styles.pwdModalBg} onPress={() => setActiveSessionsVisible(false)}>
          <AppPressable style={[styles.pwdModalBox, { maxHeight: '78%' }]} onPress={() => {}}>
            <Text style={styles.modalTitle}>Активные сессии</Text>
            <Text style={[styles.desc, { marginBottom: 8 }]}>Устройства, где открыт доступ к аккаунту</Text>
            {syncDevicesBusy && syncDevices.length === 0 ? (
              <ActivityIndicator color={colors.accent} style={{ padding: 24 }} />
            ) : syncDevicesError && syncDevices.length === 0 ? (
              <Text style={[styles.desc, { textAlign: 'center', padding: 20, color: colors.error }]}>{syncDevicesError}</Text>
            ) : syncDevices.length === 0 ? (
              <Text style={[styles.desc, { textAlign: 'center', padding: 20 }]}>Авторизованных устройств нет</Text>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {syncDevices.map((device) => {
                  const isCurrent = device.deviceId === currentSyncDeviceId;
                  const lastSeen = device.lastSeenAt ? fullDateTime(device.lastSeenAt) : 'Нет данных';
                  const platformLabel = device.platform === 'ios' ? 'iOS' : device.platform === 'android' ? 'Android' : device.platform === 'web' ? 'Web' : device.platform || 'AirChat';
                  return (
                    <View key={device.deviceId} style={{ paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <View style={{ ...avatarShape(38), backgroundColor: isCurrent ? colors.primary : colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name={device.platform === 'web' ? 'laptop-outline' : 'phone-portrait-outline'} size={20} color={isCurrent ? primaryOn : colors.textMuted} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={styles.label} numberOfLines={1}>{sessionDeviceName(device)}</Text>
                          {isCurrent ? <StatusBadge tone="success" text="Это устройство" /> : null}
                        </View>
                        <Text style={styles.desc}>{platformLabel}{device.osVersion ? ` ${device.osVersion}` : ''}{device.appVersion ? ` · AirChat ${device.appVersion}` : ''}</Text>
                        <Text style={[styles.desc, { marginTop: 2 }]}>
                          <Ionicons name="location-outline" size={12} color={colors.textMuted} /> {sessionLocation(device)}
                        </Text>
                        <Text style={[styles.desc, { marginTop: 2 }]}>Последняя активность: {lastSeen || 'нет данных'}</Text>
                      </View>
                      {!isCurrent ? (
                        <AppPressable
                          onPress={() => requestRevokeSyncDevice(device)}
                          hitSlop={8}
                          disabled={revokingDeviceId !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Завершить сессию: ${sessionDeviceName(device)}`}
                        >
                          <Ionicons name="close-circle-outline" size={22} color={colors.error} />
                        </AppPressable>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
            )}
            <AppPressable onPress={() => setActiveSessionsVisible(false)} style={{ marginTop: 12 }}>
              <Text style={styles.pwdCancel}>Закрыть</Text>
            </AppPressable>
          </AppPressable>
        </AppPressable>
      </Modal>

      {/* Status editor */}
      <Modal visible={statusModal} transparent animationType="fade" onRequestClose={() => setStatusModal(false)}>
        {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
        <KeyboardAvoidingView style={styles.pwdModalKav} behavior="padding" keyboardVerticalOffset={0}>
          <AppPressable style={styles.pwdModalBg} onPress={() => setStatusModal(false)}>
            <AppPressable style={[styles.pwdModalBox, { gap: 12 }]} onPress={() => {}}>
              <Text style={styles.modalTitle}>Мой статус</Text>
              {/* v4.32.375: статус — одна строка под именем, а не абзац. Здесь
                  поле было многострочным и на 100 символов, в профиле — на 60 и
                  без переводов строки; статус при этом один и тот же. */}
              <TextInput
                style={styles.pwdInput}
                value={statusInput}
                onChangeText={setStatusInput}
                placeholder="Что у вас нового?"
                placeholderTextColor={colors.textMuted}
                maxLength={MAX_CUSTOM_STATUS_LEN}
                autoFocus
              />
              <AppPressable style={styles.pwdPrimaryBtn} onPress={() => { const s = normalizeOwnStatus(statusInput); setCustomStatus(s); void ownFieldSet('user_custom_status', s); setStatusModal(false); }}>
                <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>
              </AppPressable>
              <AppPressable onPress={() => setStatusModal(false)}>
                <Text style={styles.pwdCancel}>Отмена</Text>
              </AppPressable>
            </AppPressable>
          </AppPressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Quick Reply editor */}
      {editingQR ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setEditingQR(null)}>
          <AppPressable style={styles.pwdModalBg} onPress={() => setEditingQR(null)}>
            <AppPressable style={[styles.pwdModalBox, { gap: 12 }]} onPress={() => {}}>
              <Text style={styles.modalTitle}>Изменить шаблон</Text>
              <TextInput style={[styles.pwdInput, { height: 80, textAlignVertical: 'top' }]} value={editingQRText} onChangeText={setEditingQRText} multiline maxLength={200} autoFocus />
              <AppPressable style={styles.pwdPrimaryBtn} onPress={() => {
                if (editingQR && editingQRText.trim()) {
                  void updateQuickReply(editingQR.id, editingQRText).then(() => { setEditingQR(null); loadQuickReplies(); });
                }
              }}>
                <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>
              </AppPressable>
              <AppPressable onPress={() => setEditingQR(null)}>
                <Text style={styles.pwdCancel}>Отмена</Text>
              </AppPressable>
            </AppPressable>
          </AppPressable>
        </Modal>
      ) : null}

      {/* Set Password */}
      <Modal visible={setPwdModal} transparent animationType="fade" onRequestClose={() => setSetPwdModal(false)}>
        {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
        <KeyboardAvoidingView style={styles.pwdModalKav} behavior="padding" keyboardVerticalOffset={0}>
          <View style={styles.pwdModalBg}>
            <View style={styles.pwdModalBox}>
              <Text style={styles.modalTitle}>Новый пароль</Text>
              <Text style={styles.desc}>Минимум {authGuard.minPasswordLength} символа</Text>
              <TextInput style={styles.pwdInput} secureTextEntry value={newPwd} onChangeText={setNewPwd} placeholder="Пароль" placeholderTextColor={colors.textMuted} autoCapitalize="none" />
              <TextInput style={styles.pwdInput} secureTextEntry value={newPwd2} onChangeText={setNewPwd2} placeholder="Повтор" placeholderTextColor={colors.textMuted} autoCapitalize="none" />
              <AppPressable style={styles.pwdPrimaryBtn} onPress={() => { void submitSetPassword(); }} disabled={pwdBusy}>
                {pwdBusy ? <ActivityIndicator color={primaryOn} /> : <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>}
              </AppPressable>
              <AppPressable onPress={() => { setSetPwdModal(false); setNewPwd(''); setNewPwd2(''); }}>
                <Text style={styles.pwdCancel}>Отмена</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Change Password */}
      <Modal visible={changePwdModal} transparent animationType="fade" onRequestClose={() => setChangePwdModal(false)}>
        {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
        <KeyboardAvoidingView style={styles.pwdModalKav} behavior="padding" keyboardVerticalOffset={0}>
          <View style={styles.pwdModalBg}>
            <View style={styles.pwdModalBox}>
              <Text style={styles.modalTitle}>Сменить пароль</Text>
              <TextInput style={styles.pwdInput} secureTextEntry value={oldPwd} onChangeText={setOldPwd} placeholder="Текущий пароль" placeholderTextColor={colors.textMuted} autoCapitalize="none" />
              <TextInput style={styles.pwdInput} secureTextEntry value={newPwd} onChangeText={setNewPwd} placeholder="Новый пароль" placeholderTextColor={colors.textMuted} autoCapitalize="none" />
              <TextInput style={styles.pwdInput} secureTextEntry value={newPwd2} onChangeText={setNewPwd2} placeholder="Повтор нового" placeholderTextColor={colors.textMuted} autoCapitalize="none" />
              <AppPressable style={styles.pwdPrimaryBtn} onPress={() => { void submitChangePassword(); }} disabled={pwdBusy}>
                {pwdBusy ? <ActivityIndicator color={primaryOn} /> : <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>}
              </AppPressable>
              <AppPressable onPress={() => { setChangePwdModal(false); setOldPwd(''); setNewPwd(''); setNewPwd2(''); }}>
                <Text style={styles.pwdCancel}>Отмена</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Night schedule */}
      <Modal visible={nightTimeModal} transparent animationType="fade" onRequestClose={() => setNightTimeModal(false)}>
        <AppPressable style={styles.pwdModalBg} onPress={() => setNightTimeModal(false)}>
          <AppPressable style={[styles.pwdModalBox, { gap: 12 }]} onPress={() => {}}>
            <Text style={styles.modalTitle}>Расписание ночного режима</Text>
            <Text style={[styles.desc, { textAlign: 'center', marginBottom: 4 }]}>Тёмная тема будет активна в выбранный период</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
              <View style={{ alignItems: 'center' }}>
                <Text style={[styles.desc, { marginBottom: 4 }]}>Начало</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppPressable onPress={() => setNightStartTmp((h) => (h - 1 + 24) % 24)} style={styles.hourBtn}><Ionicons name="chevron-down" size={18} color={colors.text} /></AppPressable>
                  <Text style={[styles.label, { minWidth: 44, textAlign: 'center' }]}>{String(nightStartTmp).padStart(2, '0')}:00</Text>
                  <AppPressable onPress={() => setNightStartTmp((h) => (h + 1) % 24)} style={styles.hourBtn}><Ionicons name="chevron-up" size={18} color={colors.text} /></AppPressable>
                </View>
              </View>
              <Text style={[styles.label, { paddingHorizontal: 4 }]}>—</Text>
              <View style={{ alignItems: 'center' }}>
                <Text style={[styles.desc, { marginBottom: 4 }]}>Конец</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppPressable onPress={() => setNightEndTmp((h) => (h - 1 + 24) % 24)} style={styles.hourBtn}><Ionicons name="chevron-down" size={18} color={colors.text} /></AppPressable>
                  <Text style={[styles.label, { minWidth: 44, textAlign: 'center' }]}>{String(nightEndTmp).padStart(2, '0')}:00</Text>
                  <AppPressable onPress={() => setNightEndTmp((h) => (h + 1) % 24)} style={styles.hourBtn}><Ionicons name="chevron-up" size={18} color={colors.text} /></AppPressable>
                </View>
              </View>
            </View>
            <AppPressable style={[styles.pwdPrimaryBtn, { marginTop: 8 }]} onPress={() => { void setAutoNight(true, nightStartTmp, nightEndTmp); setNightTimeModal(false); }}>
              <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>
            </AppPressable>
            <AppPressable onPress={() => setNightTimeModal(false)}><Text style={styles.pwdCancel}>Отмена</Text></AppPressable>
          </AppPressable>
        </AppPressable>
      </Modal>

      {/* DND time picker */}
      <Modal visible={dndTimeModal !== null} transparent animationType="fade" onRequestClose={() => setDndTimeModal(null)}>
        <AppPressable style={styles.pwdModalBg} onPress={() => setDndTimeModal(null)}>
          <AppPressable style={[styles.pwdModalBox, { gap: 12 }]} onPress={() => {}}>
            <Text style={styles.modalTitle}>{dndTimeModal === 'start' ? 'Начало тихих часов' : 'Конец тихих часов'}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <AppPressable onPress={() => setDndTimeTmp((h) => (h - 1 + 24) % 24)} style={styles.hourBtn}><Ionicons name="chevron-down" size={18} color={colors.text} /></AppPressable>
              <Text style={[styles.label, { minWidth: 60, textAlign: 'center', fontSize: 28 }]}>{String(dndTimeTmp).padStart(2, '0')}:00</Text>
              <AppPressable onPress={() => setDndTimeTmp((h) => (h + 1) % 24)} style={styles.hourBtn}><Ionicons name="chevron-up" size={18} color={colors.text} /></AppPressable>
            </View>
            <AppPressable style={styles.pwdPrimaryBtn} onPress={() => {
              if (dndTimeModal === 'start') { setDndStart(dndTimeTmp); void kvSet('dnd_start', String(dndTimeTmp)); }
              else { setDndEnd(dndTimeTmp); void kvSet('dnd_end', String(dndTimeTmp)); }
              setDndTimeModal(null);
            }}>
              <Text style={styles.pwdPrimaryBtnText}>Сохранить</Text>
            </AppPressable>
            <AppPressable onPress={() => setDndTimeModal(null)}><Text style={styles.pwdCancel}>Отмена</Text></AppPressable>
          </AppPressable>
        </AppPressable>
      </Modal>

      {/* Seed Phrase */}
      <Modal visible={seedModal} transparent animationType="fade" onRequestClose={() => setSeedModal(false)}>
        {/* v4.32.102 K.8: внутри Modal на Android нужно behavior="padding" (height не работает с flex:1 sheet) */}
        <KeyboardAvoidingView style={styles.pwdModalKav} behavior="padding" keyboardVerticalOffset={0}>
          <View style={styles.pwdModalBg}>
            <View style={styles.pwdModalBox}>
              <Text style={styles.modalTitle}>Seed-фраза</Text>
              {seedPhrase ? (
                <>
                  <Text style={[styles.desc, { marginBottom: 12, color: colors.error }]}>Запишите эти слова. Не показывайте никому.</Text>
                  <View style={styles.seedBox}><Text style={styles.seedText}>{seedPhrase}</Text></View>
                  {/* v4.32.314: копия с истечением — буфер обмена читают клавиатура,
                      системный менеджер буфера и связка с компьютером, а из этих слов
                      восстанавливается личность целиком. Подробности в clipboardSecret. */}
                  <AppPressable style={[styles.pwdPrimaryBtn, { marginTop: 12 }]} onPress={() => { void copySecretToClipboard(seedPhrase).then(() => showSuccess(`${COPIED_TEXT} — буфер очистится через минуту`)); }}>
                    <Text style={styles.pwdPrimaryBtnText}>{COPY_ACTION}</Text>
                  </AppPressable>
                </>
              ) : (
                <>
                  <Text style={[styles.desc, { marginBottom: 12 }]}>{hasAppPassword ? 'Введите пароль приложения для просмотра seed-фразы:' : 'Нажмите «Показать» для отображения seed-фразы.'}</Text>
                  {hasAppPassword ? <TextInput style={styles.pwdInput} secureTextEntry value={seedPwdInput} onChangeText={setSeedPwdInput} placeholder="Пароль приложения" placeholderTextColor={colors.textMuted} autoCapitalize="none" /> : null}
                  <AppPressable style={styles.pwdPrimaryBtn} onPress={showSeedBtn.onPress} disabled={seedBusy}>
                    {seedBusy ? <ActivityIndicator color={primaryOn} /> : <Text style={styles.pwdPrimaryBtnText}>Показать</Text>}
                  </AppPressable>
                </>
              )}
              <AppPressable onPress={() => { setSeedModal(false); setSeedPhrase(null); setSeedPwdInput(''); }}>
                <Text style={styles.pwdCancel}>Закрыть</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Cloud vault password */}
      <Modal visible={cloudPasswordModal} transparent animationType="fade" onRequestClose={() => setCloudPasswordModal(false)}>
        <KeyboardAvoidingView style={styles.pwdModalKav} behavior="padding" keyboardVerticalOffset={0}>
          <View style={styles.pwdModalBg}>
            <View style={styles.pwdModalBox}>
              <Text style={styles.modalTitle}>Облачный пароль</Text>
              <Text style={styles.desc}>Минимум 12 символов. Пароль не сохраняется и не отправляется на сервер. Потеря пароля означает потерю доступа к облачной копии.</Text>
              <TextInput
                style={styles.pwdInput}
                secureTextEntry
                value={cloudPasswordInput}
                onChangeText={setCloudPasswordInput}
                placeholder="Дополнительный пароль"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
              />
              <AppPressable style={styles.pwdPrimaryBtn} onPress={() => { void handleCloudUpload(); }} disabled={cloudBusy}>
                {cloudBusy ? <ActivityIndicator color={primaryOn} /> : <Text style={styles.pwdPrimaryBtnText}>Зашифровать и отправить</Text>}
              </AppPressable>
              <AppPressable onPress={() => { setCloudPasswordModal(false); setCloudPasswordInput(''); }}>
                <Text style={styles.pwdCancel}>Отмена</Text>
              </AppPressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAIN RENDER ────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // v4.32.540: 'top' вернулся сюда из оболочки — теперь полосу под часы
  // отбивает каждый экран сам, а фон под ней идёт на всю высоту.
  return (
    <SafeScreen edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      {subScreen === null && renderMainMenu()}
      {subScreen === 'privacy' && renderPrivacy()}
      {subScreen === 'notifications' && renderNotifications()}
      {subScreen === 'appearance' && renderAppearance()}
      {subScreen === 'data' && renderData()}
      {subScreen === 'security' && renderSecurity()}
      {subScreen === 'vpn' && renderVpn()}
      {subScreen === 'relay' && renderRelay()}
      {subScreen === 'blocked' && renderBlocked()}
      {subScreen === 'muted' && renderMuted()}
      {subScreen === 'backup' && renderBackup()}
      {subScreen === 'quick_replies' && renderQuickReplies()}
      {subScreen === 'language' && renderLanguage()}
      {subScreen === 'about' && <HelpScreen onClose={() => setSubScreen(null)} />}
      {subScreen === 'privacy-policy' && <PrivacyPolicyScreen onBack={() => setSubScreen(null)} />}
      {subScreen === 'diagnostics' && <DiagnosticScreen onClose={() => setSubScreen(null)} />}
      {subScreen === 'profiles' && (
        <ProfileSelector
          embedded
          visible
          onClose={() => setSubScreen(null)}
          onIdentityUpdated={handleProfileIdentityUpdated}
          activeProfile={profileManager.getActiveProfile()}
        />
      )}
      {renderModals()}
    </SafeScreen>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

function makeStyles(c: AppColors) {
  return StyleSheet.create({
    // Layout
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 40 },
    h1: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 16 },
    sectionTitle: { color: c.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8, letterSpacing: 0.5 },
    hint: { color: c.textMuted, fontSize: 12, marginBottom: 8, lineHeight: 16 },

    // Cards
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      marginBottom: 8,
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    rowBody: { flex: 1, paddingRight: 8 },
    label: { color: c.text, fontSize: 16, fontWeight: '600' },
    desc: { color: c.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
    // Подложки и цвета надписи здесь нет: они зависят от состояния и
    // считаются парой на месте вызова (v4.32.396).
    badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.md },
    badgeText: { fontSize: 12, fontWeight: '600' },

    // Switch rows
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    switchRowLast: { borderBottomWidth: 0 },

    // Link rows
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      gap: 10,
      marginBottom: 8,
    },

    // Press feedback
    pressed: { opacity: 0.7 },

    // Menu card (grouped rows)
    menuCard: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      marginBottom: 8,
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 14,
      gap: 12,
    },
    menuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginLeft: 54,
    },
    menuIcon: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Sub-screen header
    subHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 16,
      paddingTop: 4,
    },
    backBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingVertical: 6,
      paddingRight: 8,
      minWidth: 80,
    },
    backBtnText: { color: c.accent, fontSize: 16, fontWeight: '500' },
    subTitle: {
      flex: 1,
      textAlign: 'center',
      color: c.text,
      fontSize: 16,
      fontWeight: '700',
      paddingHorizontal: 4,
    },

    // Misc
    listWrap: { flex: 1, minHeight: 100, marginHorizontal: 16, marginBottom: 8 },
    logoutRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      // v4.32.400: было '#4a2a2a' — тёмно-бурый, подобранный под тёмную тему;
      // на белой карточке светлой темы это просто грязная рамка мимо палитры.
      borderColor: c.error,
      gap: 10,
    },
    logoutLabel: { color: c.error, fontSize: 16, fontWeight: '600' },
    versionTap: { alignSelf: 'center', marginTop: 20, paddingVertical: 6, paddingHorizontal: 10 },
    versionText: { color: c.textMuted, fontSize: font.xs, textAlign: 'center' },

    // Theme / appearance
    themeRow: { flexDirection: 'row', gap: 8, paddingTop: 10, paddingBottom: 12 },
    themeBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
      paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceHigh,
    },
    themeBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
    themeBtnText: { color: c.textSecondary, fontSize: 12, fontWeight: '500' },
    themeBtnTextActive: { color: contrastingInk(c.primary), fontWeight: '700' },
    hourBtn: { padding: 8, borderRadius: radius.md, backgroundColor: c.surfaceHigh },

    // Modals
    pwdModalKav: { flex: 1, justifyContent: 'center' },
    pwdModalBg: { flex: 1, backgroundColor: scrim.modal, justifyContent: 'center', padding: 20 },
    pwdModalBox: { backgroundColor: c.surface, borderRadius: radius.lg, padding: 16, borderWidth: 1, borderColor: c.border },
    pwdInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 12, fontSize: 16, color: c.text, marginBottom: 10 },
    pwdPrimaryBtn: { backgroundColor: c.primary, padding: 14, borderRadius: radius.md, alignItems: 'center', marginTop: 8 },
    pwdPrimaryBtnText: { color: contrastingInk(c.primary), fontSize: 16, fontWeight: '600' },
    pwdCancel: { color: c.accent, textAlign: 'center', marginTop: 14, fontSize: 16 },
    modalTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 8 },

    // Seed
    seedBox: { backgroundColor: c.surfaceHigh, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: c.border },
    seedText: { color: c.text, fontSize: 15, lineHeight: 24, fontFamily: mono },
  });
}

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — предотвращает re-render при каждом setTab в App.tsx (v4.32.5).
export const SettingsScreen = React.memo(SettingsScreenImpl);
