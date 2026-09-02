import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  TextInput,
  Alert,
  Share,
  KeyboardAvoidingView,
  Platform,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { AppPressable } from '../components/AppPressable';
import { AppModal as Modal } from '../components/AppModal';
import { Ionicons } from '@expo/vector-icons';
import {
  addContact,
  deleteContact,
  listContacts,
  parseContactId,
  renameContact,
  subscribeContactsChanged,
  type Contact,
} from '../../core/social/contacts';
import { publicKeyToDidKey, didFromPubB64 } from '../../core/identity/did';
import { getMessagingService } from '../../core/social/messaging';
import { rateLimiter } from '../../core/security/rateLimiter';
import { SafeScreen } from '../components/SafeScreen';
import { showError, showSuccess } from '../components/userFeedback';
import { useThemedStyles, useColors } from '../ThemeContext';
import { badgeTint, contrastingInk, font, mediaScrim, mono, radius, scrim } from '../theme';
import { log } from '../../core/logger';
import { shortIdentity } from '../identity/shortId';
import { rawErrorText, userErrorText } from '../components/userErrorText';
import { COPY_ID_ACTION, COPIED_ID } from '../clipboardText';

type Props = {
  onOpenChatWithPeer: (peerPublicKey: string) => void;
  pair?: import('../../core/crypto/keyManager').KeyPairBytes;
  /** DID текущего пользователя — для кнопки «поделиться моим ID». */
  myDid?: string;
};

const shortenDid = (did: string): string => shortIdentity(did);

type ContactRowProps = {
  item: Contact;
  isBlocked: boolean;
  styles: Record<string, StyleProp<ViewStyle & TextStyle & ImageStyle>>;
  colors: ReturnType<typeof useColors>;
  onPress: (peerPublicKey: string) => void;
  onLongPress: (item: Contact) => void;
};

function ContactRowImpl({ item, isBlocked, styles, colors, onPress, onLongPress }: ContactRowProps): React.ReactElement {
  const handlePress = useCallback(() => onPress(item.peerPublicKey), [onPress, item.peerPublicKey]);
  const handleLongPress = useCallback(() => onLongPress(item), [onLongPress, item]);
  return (
    <AppPressable
      style={styles.row}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={400}
      testID={`contact_${item.peerPublicKey.slice(0, 8)}`}
    >
      <Ionicons
        name={isBlocked ? 'ban' : 'person-circle'}
        size={44}
        color={isBlocked ? colors.error : colors.accent}
      />
      <View style={styles.rowBody}>
        <Text
          style={[styles.name, isBlocked ? { color: colors.textMuted, textDecorationLine: 'line-through' as const } : null]}
          numberOfLines={1}
        >
          {item.displayName || 'Контакт'}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {isBlocked
            ? '🚫 Заблокирован'
            : shortenDid(didFromPubB64(item.peerPublicKey) ?? '')}
        </Text>
      </View>
      <Ionicons
        name={isBlocked ? 'chatbubble-ellipses-outline' : 'chatbubble-outline'}
        size={22}
        color={isBlocked ? colors.textMuted : colors.accent}
      />
    </AppPressable>
  );
}
const ContactRow = memo(ContactRowImpl);

function ContactsScreenImpl({ onOpenChatWithPeer, pair, myDid }: Props): React.ReactElement {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // v4.32.31: Add-contact modal state
  const [addVisible, setAddVisible] = useState(false);
  const [addIdInput, setAddIdInput] = useState('');
  const [addNameInput, setAddNameInput] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  // v4.32.43: QR-scanner state — отдельный Modal поверх AddContactModal
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const scanHandledRef = React.useRef(false);
  const [camPermission, requestCamPermission] = useCameraPermissions();

  // Rename modal state
  const [renameTarget, setRenameTarget] = useState<Contact | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    container: { flex: 1, backgroundColor: c.background, paddingHorizontal: 16 },
    headerRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingVertical: 12,
    },
    title: { color: c.text, fontSize: 22, fontWeight: '700' as const },
    headerActions: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
    iconBtn: {
      width: 38,
      height: 38,
      borderRadius: radius.md,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    iconBtnPrimary: {
      width: 38,
      height: 38,
      borderRadius: radius.md,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      backgroundColor: c.primary,
    },
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    rowBody: { flex: 1, marginLeft: 10 },
    name: { color: c.text, fontSize: 16, fontWeight: '600' as const },
    sub: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    empty: { alignItems: 'center' as const, paddingVertical: 40, paddingHorizontal: 16 },
    emptyTitle: { color: c.text, fontSize: 18, fontWeight: '600' as const, marginTop: 12 },
    emptyText: { color: c.textSecondary, textAlign: 'center' as const, marginTop: 8, lineHeight: 20 },
    emptyBtn: {
      marginTop: 18,
      paddingHorizontal: 22,
      paddingVertical: 12,
      borderRadius: radius.xl,
      backgroundColor: c.primary,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
    },
    emptyBtnText: { color: contrastingInk(c.primary), fontSize: 15, fontWeight: '600' as const },

    // Add-contact modal
    modalRoot: { flex: 1, backgroundColor: c.background },
    modalHeader: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    modalCancel: { minWidth: 70 },
    modalDone: { minWidth: 70, alignItems: 'flex-end' as const },
    modalTitle: { color: c.text, fontSize: 17, fontWeight: '600' as const },
    modalBody: { padding: 20 },
    label: { color: c.textSecondary, fontSize: 13, marginTop: 14, marginBottom: 6 },
    input: {
      color: c.text,
      backgroundColor: c.surfaceHigh,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
    },
    helperRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      flexWrap: 'wrap' as const,
      gap: 8,
      marginTop: 8,
    },
    pasteBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: radius.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
    },
    pasteBtnText: { color: c.accent, fontSize: 13, fontWeight: '600' as const },
    hint: { color: c.textMuted, fontSize: 12, marginTop: 8, lineHeight: 17 },
    preview: {
      marginTop: 16,
      padding: 12,
      borderRadius: radius.md,
      backgroundColor: c.surfaceHigh,
      borderWidth: 1,
      borderColor: c.accent,
    },
    previewLabel: { color: c.textSecondary, fontSize: font.xs, fontWeight: '600' as const, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
    previewVal: { color: c.text, fontSize: 13, marginTop: 4, fontFamily: mono },
    // v4.32.409: подложка ошибки подмешивалась на месте, а надпись бралась
    // из палитры — красное по красному, и посчитать это было нельзя.
    errorBox: {
      marginTop: 16,
      padding: 10,
      borderRadius: radius.md,
      backgroundColor: badgeTint(c, 'error', c.background).fill,
      borderWidth: 1,
      borderColor: c.error,
    },
    errorText: { color: badgeTint(c, 'error', c.background).ink, fontSize: 13 },
    // v4.32.43: QR-scanner modal styles
    scannerHeader: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: mediaScrim.fill,
    },
    scannerClose: {
      width: 40,
      height: 40,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    scannerTitle: { color: mediaScrim.ink, fontSize: 17, fontWeight: '600' as const },
    scannerBody: { flex: 1, backgroundColor: mediaScrim.fill, position: 'relative' as const },
    scannerPermMsg: {
      flex: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      padding: 24,
    },
    scannerPermText: { color: mediaScrim.ink, fontSize: 15, marginTop: 12, textAlign: 'center' as const },
    scannerOverlay: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    scannerFrame: {
      width: 240,
      height: 240,
      borderWidth: 2,
      borderColor: mediaScrim.ink,
      borderRadius: radius.xl,
    },
    scannerHint: {
      color: mediaScrim.inkMuted,
      fontSize: 13,
      marginTop: 24,
      textAlign: 'center' as const,
      paddingHorizontal: 32,
    },
    scannerError: {
      color: mediaScrim.error,
      fontSize: 13,
      marginTop: 12,
      textAlign: 'center' as const,
      paddingHorizontal: 32,
    },
  }));

  const myPubB64 = useMemo(
    () => (pair ? Buffer.from(pair.publicKey).toString('base64') : null),
    [pair]
  );

  // v4.32.44: блок-лист — для быстрого lookup в рендере и long-press menu.
  const [blockedSet, setBlockedSet] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const list = await listContacts();
    // v4.32.31: «Сохранённые сообщения» (self-contact) не должны появляться в списке контактов —
    // только как закреп в списке чатов. Отфильтровываем запись с peerPublicKey === myPubB64.
    const filtered = myPubB64 ? list.filter((c) => c.peerPublicKey !== myPubB64) : list;
    setContacts(filtered);
    // v4.32.44: подгружаем блок-лист, чтобы отображать «заблокирован» в строке
    // и менять пункт контекст-меню между «Заблокировать» / «Разблокировать».
    try {
      const blocked = await rateLimiter.getBlockedPubKeys();
      setBlockedSet(new Set(blocked));
    } catch {
      /* ignore */
    }
  }, [myPubB64]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // v4.32.461: экран живёт только пока открыт (модалка из Профиля не держит
    // детей закрытой), поэтому спрашивать «а видно ли меня» больше не у кого.
    const off = subscribeContactsChanged(() => { void load(); });
    return off;
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const refreshBtn = useAsyncButton(onRefresh, { throttleMs: 500 });

  // ─── Парсинг ID и validation превью ────────────────────────────────────
  const parsedKey = useMemo(() => parseContactId(addIdInput), [addIdInput]);
  const parsedDid = useMemo(() => (parsedKey ? publicKeyToDidKey(parsedKey) : null), [parsedKey]);
  const parsedB64 = useMemo(
    () => (parsedKey ? Buffer.from(parsedKey).toString('base64') : null),
    [parsedKey]
  );
  const isSelf = useMemo(() => {
    if (!parsedB64 || !pair) return false;
    const mine = Buffer.from(pair.publicKey).toString('base64');
    return parsedB64 === mine;
  }, [parsedB64, pair]);
  const isDuplicate = useMemo(() => {
    if (!parsedB64) return null;
    return contacts.find((c) => c.peerPublicKey === parsedB64) ?? null;
  }, [parsedB64, contacts]);

  const validationError: string | null = useMemo(() => {
    if (!addIdInput.trim()) return null;
    if (!parsedKey) return 'Не удалось распознать ID. Ожидается did:key:… или base64.';
    if (isSelf) return 'Это ваш собственный ID — нельзя добавить самого себя как контакт.';
    return null;
  }, [addIdInput, parsedKey, isSelf]);

  const canSubmit = !!parsedKey && !isSelf && !addBusy;

  const resetAddForm = useCallback(() => {
    setAddIdInput('');
    setAddNameInput('');
  }, []);

  const openAddModal = useCallback(() => {
    resetAddForm();
    setAddVisible(true);
  }, [resetAddForm]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const s = await Clipboard.getStringAsync();
      if (s && s.trim()) {
        // v4.32.193 (Round-23 #10): cap pasted string — a megabyte-long
        // clipboard entry rerun parseContactId via useMemo on every render
        // and freezes the JS thread. Real contact IDs are <512 chars.
        if (s.length > 1024) {
          showError('Слишком длинный текст в буфере обмена');
          return;
        }
        setAddIdInput(s.trim());
      } else {
        showError('Буфер обмена пуст');
      }
    } catch (e) {
      showError(userErrorText(e, 'Не удалось прочитать буфер обмена'));
    }
  }, []);

  const onScanResult = useCallback(
    (value: string) => {
      if (scanHandledRef.current) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      const parsed = parseContactId(trimmed);
      if (!parsed) {
        // Не закрываем сканер — пользователь может навести на другой QR,
        // просто показываем подсказку о неверном формате.
        setScannerError('QR не содержит ID AirChat (did:key или base64 pubkey)');
        return;
      }
      scanHandledRef.current = true;
      setAddIdInput(trimmed);
      setScannerVisible(false);
      setScannerError(null);
      showSuccess('ID распознан');
    },
    []
  );

  // v4.32.46: QR-scanner — primary path через Google's system scanner (GMS),
  // fallback — inline CameraView Modal. Причина: inline-CameraView 16 на realme
  // RMX3760 открывает превью, но `onBarcodeScanned` не срабатывает. Google's
  // `launchScanner` — полностью нативный overlay (Activity поверх приложения) с
  // ML Kit внутри, никаких RN-bridge / Modal-prop-timing зависимостей. Работает
  // без разрешения CAMERA (GMS сам спрашивает).
  const openScanner = useCallback(async () => {
    scanHandledRef.current = false;
    setScannerError(null);
    try {
      if (CameraView.isModernBarcodeScannerAvailable) {
        log.info('ui_contacts_scanner_gms_launch', {});
        const sub = CameraView.onModernBarcodeScanned((result: { data?: string }) => {
          try {
            const data = result?.data;
            log.info('ui_contacts_scanner_gms_result', { len: data ? String(data).length : 0 });
            if (!data) return;
            onScanResult(String(data));
          } finally {
            try { sub.remove(); } catch { /* noop */ }
          }
        });
        try {
          await CameraView.launchScanner({ barcodeTypes: ['qr'] });
          log.info('ui_contacts_scanner_gms_done', {});
          return;
        } catch (e) {
          try { sub.remove(); } catch { /* noop */ }
          const msg = rawErrorText(e);
          log.warn('ui_contacts_scanner_gms_failed', { err: msg });
          // Если GMS недоступен — fallthrough к inline; если cancelled — exit.
          if (!/unavailable|not available|play services/i.test(msg)) {
            return;
          }
        }
      }

      // Fallback: inline CameraView в Modal.
      log.info('ui_contacts_scanner_inline_start', {});
      if (!camPermission || !camPermission.granted) {
        const res = await requestCamPermission();
        if (!res.granted) {
          showError('Нужен доступ к камере для сканирования QR');
          return;
        }
      }
      setScannerVisible(true);
    } catch (e) {
      showError(userErrorText(e, 'Не удалось открыть камеру'));
    }
  }, [camPermission, requestCamPermission, onScanResult]);

  const submitAdd = useCallback(async () => {
    if (!parsedKey) return;
    if (!pair) {
      showError('Пара ключей ещё не готова — попробуйте позже');
      return;
    }
    if (isSelf) {
      showError('Нельзя добавить самого себя');
      return;
    }
    const name = addNameInput.trim() || `Контакт ${Buffer.from(parsedKey).toString('base64').slice(0, 6)}`;

    // v4.32.44: дубликат — один и тот же адрес не может быть добавлен дважды.
    // Предлагаем либо обновить имя, либо удалить старую запись, либо заблокировать пира.
    if (isDuplicate) {
      const dup = isDuplicate;
      const alreadyBlocked = blockedSet.has(dup.peerPublicKey);
      Alert.alert(
        'Контакт уже добавлен',
        `«${dup.displayName}» уже в списке. Один и тот же адрес нельзя добавить дважды.`,
        [
          { text: 'Отмена', style: 'cancel' },
          {
            text: 'Обновить имя',
            onPress: () => {
              void (async () => {
                try {
                  await renameContact(dup.peerPublicKey, name);
                  showSuccess('Имя обновлено');
                  setAddVisible(false);
                  resetAddForm();
                } catch (e) {
                  showError(userErrorText(e, 'Не удалось переименовать контакт'));
                }
              })();
            },
          },
          {
            text: alreadyBlocked ? 'Разблокировать' : 'Заблокировать',
            onPress: () => {
              void (async () => {
                try {
                  if (alreadyBlocked) {
                    await rateLimiter.unblockContact(dup.peerPublicKey);
                    showSuccess('Разблокировано');
                  } else {
                    await rateLimiter.blockContact(dup.peerPublicKey);
                    showSuccess('Заблокировано');
                  }
                  await load();
                  setAddVisible(false);
                  resetAddForm();
                } catch (e) {
                  showError(userErrorText(e, 'Не удалось изменить блокировку'));
                }
              })();
            },
          },
          {
            text: 'Удалить',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await deleteContact(dup.peerPublicKey);
                  showSuccess('Контакт удалён');
                  setAddVisible(false);
                  resetAddForm();
                } catch (e) {
                  showError(userErrorText(e, 'Не удалось удалить контакт'));
                }
              })();
            },
          },
        ]
      );
      return;
    }

    setAddBusy(true);
    try {
      await addContact(pair, parsedKey, name);
      // ChatListScreen паттерн v4.32.x: сразу же синхронизируем транспорты / историю.
      const svc = getMessagingService();
      if (svc) {
        await svc.refreshSubscriptions().catch(() => undefined);
        const peerB64 = Buffer.from(parsedKey).toString('base64');
        await svc.syncHistoryFromPeer(peerB64, 100).catch(() => undefined);
      }
      showSuccess(`Контакт «${name}» добавлен`);
      setAddVisible(false);
      resetAddForm();
    } catch (e) {
      showError(userErrorText(e, 'Не удалось добавить контакт'));
    } finally {
      setAddBusy(false);
    }
  }, [parsedKey, pair, isSelf, addNameInput, isDuplicate, resetAddForm, blockedSet, load]);

  // ─── Share my ID ───────────────────────────────────────────────────────
  const shareMyId = useCallback(async () => {
    if (!myDid) {
      showError('Ваш ID ещё не готов');
      return;
    }
    try {
      await Share.share({
        message: `Добавь меня в AirChat:\n${myDid}`,
      });
    } catch {
      // отмена share — игнор
    }
  }, [myDid]);

  // ─── Long-press actions: rename / delete / block ───────────────────────
  const openContextMenu = useCallback((c: Contact) => {
    const isBlocked = blockedSet.has(c.peerPublicKey);
    Alert.alert(
      c.displayName || 'Контакт',
      shortenDid(didFromPubB64(c.peerPublicKey) ?? '') +
        (isBlocked ? '\n\n🚫 Заблокирован' : ''),
      [
        {
          text: 'Открыть чат',
          onPress: () => onOpenChatWithPeer(c.peerPublicKey),
        },
        {
          text: 'Переименовать',
          onPress: () => {
            setRenameTarget(c);
            setRenameDraft(c.displayName || '');
          },
        },
        {
          text: COPY_ID_ACTION,
          onPress: () => {
            // v4.32.427: копировать нечего, если ключ контакта испорчен —
            // раньше в буфер уезжал did:key, который не примет обратно ни один
            // разборщик, и человек отправлял его собеседнику как свой адрес.
            const did = didFromPubB64(c.peerPublicKey);
            if (!did) { showError('У контакта испорчен ключ'); return; }
            void Clipboard.setStringAsync(did).then(() => showSuccess(COPIED_ID));
          },
        },
        {
          // v4.32.44: быстрый блок/разблок прямо из списка контактов — не надо идти в ChatScreen.
          text: isBlocked ? 'Разблокировать' : 'Заблокировать',
          onPress: () => {
            void (async () => {
              try {
                if (isBlocked) {
                  await rateLimiter.unblockContact(c.peerPublicKey);
                  showSuccess('Разблокировано');
                } else {
                  await rateLimiter.blockContact(c.peerPublicKey);
                  showSuccess('Заблокировано');
                }
                await load();
              } catch (e) {
                showError(userErrorText(e, 'Не удалось изменить блокировку'));
              }
            })();
          },
        },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Удалить контакт?',
              `«${c.displayName}» будет удалён. История сообщений останется, но новые сообщения от него не будут расшифрованы.`,
              [
                { text: 'Отмена', style: 'cancel' },
                {
                  text: 'Удалить',
                  style: 'destructive',
                  onPress: () => {
                    void (async () => {
                      try {
                        await deleteContact(c.peerPublicKey);
                        showSuccess('Контакт удалён');
                      } catch (e) {
                        showError(userErrorText(e, 'Не удалось удалить контакт'));
                      }
                    })();
                  },
                },
              ]
            );
          },
        },
        { text: 'Отмена', style: 'cancel' },
      ]
    );
  }, [onOpenChatWithPeer, blockedSet, load]);

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameDraft.trim();
    if (!name) {
      showError('Имя не может быть пустым');
      return;
    }
    try {
      await renameContact(renameTarget.peerPublicKey, name);
      showSuccess('Имя обновлено');
      setRenameTarget(null);
      setRenameDraft('');
    } catch (e) {
      showError(userErrorText(e, 'Не удалось переименовать контакт'));
    }
  }, [renameTarget, renameDraft]);

  // Stage C.3.5: stable callbacks for memoized ContactRow
  const contactKeyExtractor = useCallback((c: Contact) => c.peerPublicKey, []);
  const handleContactPress = useCallback((peerPublicKey: string) => onOpenChatWithPeer(peerPublicKey), [onOpenChatWithPeer]);
  const renderContact = useCallback(
    ({ item }: { item: Contact }) => (
      <ContactRow
        item={item}
        isBlocked={blockedSet.has(item.peerPublicKey)}
        styles={styles}
        colors={colors}
        onPress={handleContactPress}
        onLongPress={openContextMenu}
      />
    ),
    [blockedSet, styles, colors, handleContactPress, openContextMenu],
  );

  return (
    <SafeScreen edges={['left', 'right']} style={{ flex: 1 }}>
      <View style={styles.container} testID="contacts_screen">
        <View style={styles.headerRow}>
          <Text style={styles.title}>Контакты</Text>
          <View style={styles.headerActions}>
            <AppPressable style={styles.iconBtn} onPress={refreshBtn.onPress} testID="contacts_refresh">
              <Ionicons name="refresh" size={20} color={colors.text} />
            </AppPressable>
            {myDid ? (
              <AppPressable style={styles.iconBtn} onPress={() => void shareMyId()} testID="contacts_share_my_id">
                <Ionicons name="share-outline" size={20} color={colors.text} />
              </AppPressable>
            ) : null}
            <AppPressable
              style={styles.iconBtnPrimary}
              onPress={openAddModal}
              testID="contacts_add"
              accessibilityLabel="Новый контакт"
            >
              <Ionicons name="person-add" size={20} color={contrastingInk(colors.primary)} />
            </AppPressable>
          </View>
        </View>

        <FlatList
          data={contacts}
          keyExtractor={contactKeyExtractor}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          renderItem={renderContact}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={10}
          removeClippedSubviews={Platform.OS === 'android'}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={56} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>Пока никого в списке</Text>
              <Text style={styles.emptyText}>
                Добавьте первый контакт — попросите друга открыть «Профиль» → «Мой QR-код», отсканируйте код или вставьте его ID.
              </Text>
              <AppPressable style={styles.emptyBtn} onPress={openAddModal} testID="contacts_empty_add">
                <Ionicons name="person-add" size={18} color={contrastingInk(colors.primary)} />
                <Text style={styles.emptyBtnText}>Добавить контакт</Text>
              </AppPressable>
            </View>
          }
        />
      </View>

      {/* ─── Add contact modal ──────────────────────────────────────────── */}
      <Modal
        visible={addVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAddVisible(false)}
      >
        {/* v4.32.42: SafeScreen top inset — чтобы header «Отмена / Новый контакт /
            Готово» не лежал под статус-баром (время, батарея). */}
        <SafeScreen edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={styles.modalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalHeader}>
            <AppPressable onPress={() => { setAddVisible(false); resetAddForm(); }} style={styles.modalCancel}>
              <Text style={{ color: colors.accent, fontSize: 16 }}>Отмена</Text>
            </AppPressable>
            <Text style={styles.modalTitle}>Новый контакт</Text>
            <AppPressable
              style={styles.modalDone}
              onPress={() => void submitAdd()}
              disabled={!canSubmit}
            >
              <Text style={{
                color: canSubmit ? colors.accent : colors.textMuted,
                fontSize: 16,
                fontWeight: '600',
              }}>
                {addBusy ? '…' : 'Готово'}
              </Text>
            </AppPressable>
          </View>
          <View style={styles.modalBody}>
            <Text style={styles.label}>ID контакта (did:key:… или base64)</Text>
            <TextInput
              style={styles.input}
              value={addIdInput}
              onChangeText={setAddIdInput}
              placeholder="did:key:z6Mk…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              testID="contacts_add_id_input"
            />
            {/* v4.32.43: две кнопки в ряд — вставить из буфера и сканировать QR. */}
            <View style={styles.helperRow}>
              <AppPressable style={styles.pasteBtn} onPress={() => void pasteFromClipboard()} testID="contacts_add_paste">
                <Ionicons name="clipboard-outline" size={14} color={colors.accent} />
                <Text style={styles.pasteBtnText}>Вставить из буфера</Text>
              </AppPressable>
              <AppPressable style={styles.pasteBtn} onPress={() => void openScanner()} testID="contacts_add_scan">
                <Ionicons name="qr-code-outline" size={14} color={colors.accent} />
                <Text style={styles.pasteBtnText}>Сканировать QR</Text>
              </AppPressable>
            </View>

            <Text style={styles.label}>Имя (необязательно)</Text>
            <TextInput
              style={styles.input}
              value={addNameInput}
              onChangeText={setAddNameInput}
              placeholder="Как отображать"
              placeholderTextColor={colors.textMuted}
              testID="contacts_add_name_input"
            />

            {validationError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{validationError}</Text>
              </View>
            ) : parsedDid ? (
              <View style={styles.preview}>
                <Text style={styles.previewLabel}>Будет добавлен</Text>
                <Text style={styles.previewVal} numberOfLines={2}>{parsedDid}</Text>
                {isDuplicate ? (
                  <Text style={[styles.hint, { color: colors.accent, marginTop: 6 }]}>
                    Уже в списке как «{isDuplicate.displayName}». При сохранении будет предложено обновить имя.
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.hint}>
                Попросите друга: «Профиль» → «Мой QR-код» → «{COPY_ID_ACTION}». Вставьте его сюда — общий секретный ключ вычислится автоматически.
              </Text>
            )}
          </View>
        </KeyboardAvoidingView>
        </SafeScreen>
      </Modal>

      {/* v4.32.43: ─── QR-scanner modal ─────────────────────────────────── */}
      <Modal
        visible={scannerVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScannerVisible(false)}
      >
        <SafeScreen edges={['top', 'left', 'right', 'bottom']} backgroundColor={mediaScrim.fill} style={{ flex: 1 }}>
          <View style={styles.scannerHeader}>
            <AppPressable
              onPress={() => setScannerVisible(false)}
              style={styles.scannerClose}
              testID="contacts_scanner_close"
            >
              <Ionicons name="close" size={24} color={mediaScrim.ink} />
            </AppPressable>
            <Text style={styles.scannerTitle}>Наведите на QR</Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={styles.scannerBody}>
            {camPermission?.granted ? (
              // v4.32.44: autofocus='on' — без этого в expo-camera 16 фокус фиксированный,
              // QR расплывается и onBarcodeScanned никогда не срабатывает. По умолчанию
              // ensureNativeProps ставит autoFocus='off' (см. expo-camera/build/utils/props.js).
              <CameraView
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                facing="back"
                autofocus="on"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onCameraReady={() => {
                  log.info('ui_contacts_scanner_ready', {});
                }}
                onMountError={(e) => {
                  const msg = e?.message ?? 'camera mount error';
                  setScannerError(msg);
                  log.warn('ui_contacts_scanner_mount_error', { err: msg });
                }}
                onBarcodeScanned={(ev) => {
                  const data = (ev as { data?: string; nativeEvent?: { data?: string } })?.data
                    ?? (ev as { nativeEvent?: { data?: string } })?.nativeEvent?.data;
                  log.info('ui_contacts_scanner_inline_barcode', { len: data ? String(data).length : 0 });
                  if (!data) return;
                  onScanResult(String(data));
                }}
              />
            ) : (
              <View style={styles.scannerPermMsg}>
                <Ionicons name="camera-outline" size={48} color={mediaScrim.ink} />
                <Text style={styles.scannerPermText}>
                  Разрешение на камеру не выдано.
                </Text>
                <AppPressable
                  onPress={() => { void requestCamPermission(); }}
                  style={[styles.pasteBtn, { marginTop: 12 }]}
                >
                  <Text style={styles.pasteBtnText}>Запросить доступ</Text>
                </AppPressable>
              </View>
            )}
            {/* рамка-оверлей для визуальной подсказки */}
            <View pointerEvents="none" style={styles.scannerOverlay}>
              <View style={styles.scannerFrame} />
              <Text style={styles.scannerHint}>
                QR-код виден на «Профиль → QR-код»
              </Text>
              {scannerError ? (
                <Text style={styles.scannerError}>{scannerError}</Text>
              ) : null}
            </View>
          </View>
        </SafeScreen>
      </Modal>

      {/* ─── Rename modal ───────────────────────────────────────────────── */}
      <Modal
        visible={!!renameTarget}
        animationType="fade"
        transparent
        onRequestClose={() => { setRenameTarget(null); setRenameDraft(''); }}
      >
        <View style={{ flex: 1, backgroundColor: scrim.modal, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderRadius: radius.lg, padding: 20 }}>
            <Text style={[styles.modalTitle, { marginBottom: 12 }]}>Переименовать контакт</Text>
            <TextInput
              style={styles.input}
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder="Новое имя"
              placeholderTextColor={colors.textMuted}
              autoFocus
              testID="contacts_rename_input"
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
              <AppPressable onPress={() => { setRenameTarget(null); setRenameDraft(''); }}>
                <Text style={{ color: colors.textSecondary, fontSize: 15, padding: 8 }}>Отмена</Text>
              </AppPressable>
              <AppPressable onPress={() => void submitRename()}>
                <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600', padding: 8 }}>Сохранить</Text>
              </AppPressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeScreen>
  );
}

// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: React.memo — экран mounted через lazy keep-alive; без memo при каждом
// setTab в App.tsx ContactsScreen перерисовывается целиком (v4.32.5).
export const ContactsScreen = React.memo(ContactsScreenImpl);
