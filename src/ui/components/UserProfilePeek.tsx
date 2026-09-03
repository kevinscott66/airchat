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
//
// v4.32.567: пропы не тронуты и здесь. Карточка перестала быть заглушкой:
// фотография вместо буквы (общий реестр лиц, PersonAvatar), юзернейм с
// официальной галочкой и «О себе». Свой профиль до этой версии открывался
// как «Без имени (Вы)» с кружком «?»: себя карточка искала в адресной книге,
// а там человека нет — своё имя, снимок и «О себе» лежат в карточке профиля
// (identity/ownProfile), и теперь она их оттуда и читает.
//
// v4.32.568: карточка стала полным профилем. К имени и «Написать сообщение»
// добавились быстрые действия (звонок, видео, звук, поиск по переписке),
// разделы содержимого (публикации и сторис, медиа, избранное, файлы, музыка,
// голосовые, ссылки, у себя — архив публикаций) и настройки переписки (обои,
// поделиться контактом, автоудаление, запрет на копирование, удалить
// переписку, заблокировать, пожаловаться). Единственное изменение пропов —
// третий НЕОБЯЗАТЕЛЬНЫЙ аргумент у onOpenChat: чем открывать переписку,
// разговором или поиском по ней. Старые вызывающие места его не передают и
// работают как раньше.
//
// Про два пункта сказано честно и здесь, и на экране: «Пожаловаться» никуда
// не отправляется — модерации в сети без сервера нет, жалоба остаётся местной
// записью и блокировкой (core/social/contactReport); «Запрет копирования и
// пересылки» закрывает копирование и пересылку внутри приложения, а не снимок
// экрана (core/social/copyGuard).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { AppModal } from './AppModal';
import { KeyboardHost } from './KeyboardHost';
import { AppPressable } from './AppPressable';
import { useColors } from '../ThemeContext';
import { font, mono, radius, scrim, spacing } from '../theme';
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
import { peekIdentity, resolvePeer, shortDid, type PeekOwn } from './profilePeekModel';
import {
  hubQuickActions,
  hubSections,
  hubSettings,
  type HubFacts,
  type QuickActionId,
  type SectionId,
  type SettingId,
} from './profileHubModel';
import type { KeyPairBytes } from '../../core/crypto/keyManager';
import { contactLabel } from '../../core/social/contactLabel';
import { rawErrorText, userErrorText } from './userErrorText';
import { COPY_ACTION, COPY_ID_ACTION, COPIED_ID } from '../clipboardText';
// v4.32.540: чужой профиль — обложка из набора обоев и постоянный
// идентификатор аккаунта; см. wallpapers.coverWallpaperFor и identity/publicId.
import { WallpaperBackground } from './WallpaperBackground';
import { coverWallpaperFor } from '../wallpapers';
import { publicIdFor } from '../../core/identity/publicId';
import { PersonAvatar } from './PersonAvatar';
import { VerifiedMark } from './VerifiedMark';
import { getOwnDisplayName, getOwnUsername, ownFieldGet } from '../../core/identity/ownProfile';
import { ownBadgeClaim } from '../../core/identity/ownBadge';
import { normalizeOwnBio } from '../../core/social/profileEnvelope';
// v4.32.568: всё, чем карточка теперь управляет, уже есть в ядре — она их
// вызывает, а не заводит второй набор правил рядом с экраном диалога.
import { profileManager } from '../../core/identity/profileManager';
import {
  clearChatHistory,
  listConversations,
  setConversationMuted,
  setConversationMutedUntil,
} from '../../core/storage/local';
import { setMuted as muteSet, unmute as muteUnset } from '../../core/notifications/muteStore';
import { setDisappearAndSync } from '../../core/social/disappearSync';
import { rateLimiter } from '../../core/security/rateLimiter';
import { getCurrentCall, initiateCall } from '../../core/social/callService';
import { isCopyGuarded, setCopyGuard } from '../../core/social/copyGuard';
import { hasReported, recordContactReport, REPORT_REASONS } from '../../core/social/contactReport';
import { SharedMediaModal, type SharedMediaTab } from './modals/chat/ChatSharedMediaModal';
import { WallpaperPickerModal } from './modals/chat/ChatWallpaperPickerModal';
import { ProfilePostsModal } from './modals/profile/ProfilePostsModal';
import { defaultWallpaper, type Wallpaper } from '../wallpapers';
import { useTheme } from '../ThemeContext';
import { loadConfig } from '../../core/config';
import { log } from '../../core/logger';

/** Значки разделов и настроек живут во вьюхе: модель отвечает за состав и слова. */
const QUICK_ICON: Record<QuickActionId, React.ComponentProps<typeof Ionicons>['name']> = {
  message: 'chatbubble-ellipses-outline',
  call: 'call-outline',
  video: 'videocam-outline',
  mute: 'notifications-off-outline',
  search: 'search-outline',
};

const SECTION_ICON: Record<SectionId, React.ComponentProps<typeof Ionicons>['name']> = {
  posts: 'albums-outline',
  media: 'images-outline',
  starred: 'star-outline',
  files: 'document-outline',
  music: 'musical-notes-outline',
  voice: 'mic-outline',
  links: 'link-outline',
  archive: 'archive-outline',
};

const SETTING_ICON: Record<SettingId, React.ComponentProps<typeof Ionicons>['name']> = {
  wallpaper: 'color-palette-outline',
  share_contact: 'person-add-outline',
  disappear: 'timer-outline',
  copy_guard: 'copy-outline',
  clear_history: 'trash-outline',
  block: 'ban-outline',
  report: 'flag-outline',
};

/** Разделы, которые открываются общей галереей переписки, — и её вкладка. */
const SECTION_TAB: Partial<Record<SectionId, SharedMediaTab>> = {
  media: 'media',
  files: 'docs',
  music: 'music',
  voice: 'voice',
  links: 'links',
};

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
   *
   * v4.32.568: третий аргумент — чем открывать. 'search' просит экран диалога
   * сразу поднять поиск по переписке, 'starred' — список избранного в ней;
   * необязателен, старые вызывающие места его не читают.
   */
  onOpenChat?: (
    peerPubB64: string,
    displayName: string,
    intent?: 'chat' | 'search' | 'starred'
  ) => void;
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
  const { scheme } = useTheme();
  const activeProfileId = profileManager.getActiveProfile()?.id ?? 1;

  const resolved = useMemo(
    () => resolvePeer(peerPubB64, peerDid),
    [peerPubB64, peerDid]
  );

  // Пытаемся найти контакт в адресной книге (даёт displayName + знание, что он в контактах).
  const [contact, setContact] = useState<Contact | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isSelf, setIsSelf] = useState(false);
  // Своя карточка. null и у чужого профиля, и пока своя не прочитана.
  const [own, setOwn] = useState<PeekOwn | null>(null);

  // Состояние переписки. Всё читается один раз при открытии карточки: она
  // живёт поверх других экранов и обязана показывать то, что есть сейчас, а не
  // то, что было при прошлом открытии.
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [copyGuard, setCopyGuardState] = useState(false);
  const [disappearMs, setDisappearMs] = useState<number | null>(null);
  const [reported, setReported] = useState(false);
  const [gateway, setGateway] = useState('');
  const [wallpaper, setWallpaper] = useState<Wallpaper | null>(null);

  // Дочерние окна. Открываются поверх карточки и её не закрывают: человек
  // возвращается туда же, откуда ушёл.
  const [mediaTab, setMediaTab] = useState<SharedMediaTab | null>(null);
  const [postsMode, setPostsMode] = useState<'posts' | 'archive' | null>(null);
  const [wallpaperOpen, setWallpaperOpen] = useState(false);

  useEffect(() => {
    // Сброс делаем на любую смену пира, а не только на закрытие: иначе, пока
    // грузится адресная книга нового, на карточке висит имя предыдущего.
    setContact(null);
    setRenaming(false);
    setRenameDraft('');
    setIsSelf(false);
    setOwn(null);
    setMuted(false);
    setBlocked(false);
    setCopyGuardState(false);
    setDisappearMs(null);
    setReported(false);
    setWallpaper(null);
    if (!visible || !resolved) return;
    let cancelled = false;
    void (async () => {
      try {
        // Self-detection: сравниваем DID (публичный идентификатор, безопасно логировать).
        // Присваиваем результат сравнения, а не только `true`: иначе смена пира
        // при открытой карточке оставила бы «(Вы)» на чужом профиле.
        const mine = !!pair && publicKeyToDidKey(pair.publicKey) === resolved.did;
        if (pair && !cancelled) setIsSelf(mine);
        if (mine) {
          // Своё читается по одному полю, как и на экране профиля: общей
          // «карточки одним куском» в хранилище нет.
          const [name, username, bio, claim] = await Promise.all([
            getOwnDisplayName(),
            getOwnUsername(),
            ownFieldGet('user_bio'),
            ownBadgeClaim(),
          ]);
          if (cancelled) return;
          // Галочка — только при совпадении имени с бумагой: переименовавшийся
          // аккаунт контакты видят без неё, и себя он должен видеть так же.
          setOwn({
            name,
            username,
            bio: normalizeOwnBio(bio) || null,
            verified: !!claim && !!username && claim.username === username,
          });
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

  // Состояние переписки читается отдельным эффектом: оно не зависит от
  // адресной книги и не должно теряться из-за сбоя её чтения.
  useEffect(() => {
    if (!visible || !resolved) return;
    let cancelled = false;
    const pub = resolved.pubB64;
    void (async () => {
      try {
        const convs = await listConversations(activeProfileId);
        if (cancelled) return;
        const conv = convs.find((c) => c.contactPubB64 === pub);
        if (conv) {
          setMuted(conv.muted);
          setDisappearMs(conv.disappearAfterMs ?? null);
        }
      } catch (e) {
        log.warn('ui_peek_conv_read_failed', { err: rawErrorText(e) });
      }
      try {
        await rateLimiter.whenReady();
        if (!cancelled) setBlocked(rateLimiter.isBlocked(pub));
      } catch { /* блокировка неизвестна — покажем «Заблокировать» */ }
      const [guard, wasReported] = await Promise.all([
        isCopyGuarded(pub),
        hasReported(resolved.did),
      ]);
      if (cancelled) return;
      setCopyGuardState(guard);
      setReported(wasReported);
    })();
    void loadConfig()
      .then((c) => { if (!cancelled) setGateway(c.ipfs.gatewayUrl.replace(/\/$/, '')); })
      .catch(() => { /* галерея переживёт пустой шлюз: вложения ездят blob'ом */ });
    return () => { cancelled = true; };
  }, [visible, resolved, activeProfileId]);

  // `identity` считается и когда пир не разобрался: хуков нельзя вызывать
  // меньше, чем в прошлый раз, а ранний выход стоит ниже.
  const identity = useMemo(
    () => peekIdentity({
      contact: contact
        ? {
            displayName: contact.displayName,
            implicit: contact.implicit,
            peerName: contact.peerName,
            username: contact.peerUsername,
            bio: contact.bio,
            verified: contact.verified === 'official',
          }
        : null,
      fallbackName,
      did: resolved?.did ?? '',
      isSelf,
      own,
    }),
    [contact, fallbackName, resolved, isSelf, own]
  );
  // Имя для действий: у безымянного это заглушка из DID, а не слово «Контакт»
  // — иначе двое добавленных незнакомцев станут в списке чатов неразличимы.
  const displayName = identity.contactName;

  const facts: HubFacts = useMemo(() => ({
    isSelf,
    inContacts: identity.inContacts,
    blocked,
    muted,
    copyGuard,
    disappearMs,
    reported,
    canOpenChat: !!onOpenChat,
  }), [isSelf, identity.inContacts, blocked, muted, copyGuard, disappearMs, reported, onOpenChat]);

  const quickActions = useMemo(() => hubQuickActions(facts), [facts]);
  const sections = useMemo(() => hubSections(facts), [facts]);
  const settings = useMemo(() => hubSettings(facts), [facts]);

  // v4.32.573: идентификатор аккаунта с карточки убран — показывать его
  // собеседнику незачем (см. core/identity/accountRef). Вычисляться он не
  // перестал: от него берётся обложка, и она должна остаться той же самой.
  const peerPublicId = useMemo(() => publicIdFor('account', resolved?.did ?? ''), [resolved]);
  // Обложка — от идентификатора, а не от имени: переименовал контакт у себя,
  // а карточка осталась той же самой.
  const cover = useMemo(() => coverWallpaperFor(peerPublicId), [peerPublicId]);

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

  // ─── Быстрые действия ───────────────────────────────────────────────────
  const startCall = useCallback((video: boolean) => {
    if (!resolved) return;
    if (getCurrentCall()) { showError('Уже активен звонок'); return; }
    const what = video ? 'видеозвонок' : 'звонок';
    void (async () => {
      try {
        const myName = (await getOwnDisplayName()) || 'AirChat';
        const ok = await initiateCall(resolved.pubB64, myName, video);
        if (!ok) showError(`Не удалось начать ${what}`);
        else onClose();
      } catch {
        showError(`Не удалось начать ${what}`);
      }
    })();
  }, [resolved, onClose]);

  const toggleMute = useCallback(() => {
    if (!resolved) return;
    const pub = resolved.pubB64;
    const apply = (untilMs: number | null): void => {
      void (async () => {
        try {
          await setConversationMutedUntil(pub, activeProfileId, untilMs);
          await muteSet('chat', pub, untilMs !== null ? { untilMs } : undefined);
          setMuted(true);
          showSuccess(untilMs === null ? 'Уведомления выключены' : 'Уведомления временно выключены');
        } catch (e) {
          showError(userErrorText(e, 'Не удалось выключить уведомления'));
        }
      })();
    };
    if (muted) {
      void (async () => {
        try {
          await setConversationMuted(pub, activeProfileId, false);
          await muteUnset('chat', pub);
          setMuted(false);
          showSuccess('Уведомления включены');
        } catch (e) {
          showError(userErrorText(e, 'Не удалось включить уведомления'));
        }
      })();
      return;
    }
    Alert.alert('Выключить уведомления', 'На сколько выключить звук по этой переписке?', [
      { text: 'На час', onPress: () => apply(Date.now() + 3_600_000) },
      { text: 'На 8 часов', onPress: () => apply(Date.now() + 8 * 3_600_000) },
      { text: 'Навсегда', onPress: () => apply(null) },
      { text: 'Отмена', style: 'cancel' },
    ]);
  }, [resolved, muted, activeProfileId]);

  const onQuickAction = useCallback((id: QuickActionId) => {
    if (!resolved) return;
    switch (id) {
      case 'message':
        onOpenChat?.(resolved.pubB64, displayName);
        onClose();
        return;
      case 'search':
        onOpenChat?.(resolved.pubB64, displayName, 'search');
        onClose();
        return;
      case 'call':
        startCall(false);
        return;
      case 'video':
        startCall(true);
        return;
      case 'mute':
        toggleMute();
        return;
    }
  }, [resolved, displayName, onOpenChat, onClose, startCall, toggleMute]);

  // ─── Разделы ────────────────────────────────────────────────────────────
  const onSection = useCallback((id: SectionId) => {
    const tab = SECTION_TAB[id];
    if (tab) { setMediaTab(tab); return; }
    if (id === 'posts') { setPostsMode('posts'); return; }
    if (id === 'archive') { setPostsMode('archive'); return; }
    if (id === 'starred') {
      // Избранное живёт внутри переписки: там его и показывает экран диалога,
      // со всеми ссылками на сами сообщения. Отдельного списка здесь не
      // заводим — он был бы вторым, расходящимся с первым.
      if (!resolved) return;
      onOpenChat?.(resolved.pubB64, displayName, 'starred');
      onClose();
    }
  }, [resolved, displayName, onOpenChat, onClose]);

  // ─── Настройки ──────────────────────────────────────────────────────────
  const shareContact = useCallback(() => {
    if (!resolved) return;
    void Share.share({
      message: `${identity.named ? identity.title : 'Контакт AirChat'}\n${resolved.did}`,
    }).catch(() => { /* отменили — это не ошибка */ });
  }, [resolved, identity]);

  const editDisappear = useCallback(() => {
    if (!resolved) return;
    const pub = resolved.pubB64;
    Alert.alert(
      'Автоудаление',
      'Выбранное время действует у обоих собеседников и применяется к сообщениям, отправленным после включения.',
      [
        // Значения и их смысл — те же, что в меню диалога: явное «Выкл»
        // пишется нулём, а не NULL (NULL означает «не выбирал» и вернул бы
        // значение по умолчанию из настроек).
        ...([
          ['Выкл', 0],
          ['1 мин', 60_000],
          ['1 час', 3_600_000],
          ['1 день', 86_400_000],
          ['1 неделя', 7 * 86_400_000],
        ] as const).map(([label, ms]) => ({
          text: label,
          onPress: () => void setDisappearAndSync({ peerPubB64: pub, ms }).then((res) => {
            setDisappearMs(ms);
            if (!res.synced) showError(res.warning);
          }).catch((e: unknown) => showError(userErrorText(e, 'Не удалось изменить автоудаление'))),
        })),
        { text: 'Отмена', style: 'cancel' as const },
      ]
    );
  }, [resolved]);

  const toggleCopyGuard = useCallback(() => {
    if (!resolved) return;
    const pub = resolved.pubB64;
    const next = !copyGuard;
    const commit = (): void => {
      void setCopyGuard(pub, next)
        .then(() => {
          setCopyGuardState(next);
          showSuccess(next ? 'Копирование и пересылка выключены' : 'Копирование и пересылка разрешены');
        })
        .catch((e: unknown) => showError(userErrorText(e, 'Не удалось изменить запрет')));
    };
    if (!next) { commit(); return; }
    // Обещание даётся ровно то, которое выполняется. Про снимок экрана —
    // прямо, а не мелким шрифтом: иначе человек решит, что переписку нельзя
    // вынести вовсе.
    Alert.alert(
      'Запрет копирования и пересылки',
      `Вынести сообщения этой переписки внутри приложения будет нельзя: пункты «${COPY_ACTION}» и «Переслать» в меню сообщения и в панели выделения пропадут.\n\nЭто не защита от снимка экрана — запретить его приложение не может. Настройка местная, собеседнику она не передаётся.`,
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Включить', onPress: commit },
      ]
    );
  }, [resolved, copyGuard]);

  const clearHistory = useCallback(() => {
    if (!resolved) return;
    const pub = resolved.pubB64;
    Alert.alert(
      'Удалить переписку?',
      'Все сообщения этой переписки будут удалены на этом устройстве. У собеседника они останутся.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => void clearChatHistory(pub, activeProfileId)
            .then(() => showSuccess('Переписка удалена'))
            .catch((e: unknown) => showError(userErrorText(e, 'Не удалось удалить переписку'))),
        },
      ]
    );
  }, [resolved, activeProfileId]);

  const toggleBlock = useCallback(() => {
    if (!resolved) return;
    const pub = resolved.pubB64;
    if (blocked) {
      void rateLimiter.unblockContact(pub)
        .then(() => { setBlocked(false); showSuccess('Разблокировано'); })
        .catch((e: unknown) => showError(userErrorText(e, 'Не удалось разблокировать')));
      return;
    }
    Alert.alert('Заблокировать?', 'Сообщения и звонки от этого человека будут отклонены.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Заблокировать',
        style: 'destructive',
        onPress: () => void rateLimiter.blockContact(pub)
          .then(() => { setBlocked(true); showSuccess('Заблокировано'); })
          .catch((e: unknown) => showError(userErrorText(e, 'Не удалось заблокировать'))),
      },
    ]);
  }, [resolved, blocked]);

  const report = useCallback(() => {
    if (!resolved) return;
    const did = resolved.did;
    const pub = resolved.pubB64;
    Alert.alert(
      'Пожаловаться',
      'В AirChat нет модерации: переписка сквозная, и передать жалобу некому. Жалоба останется записью у вас и — если согласитесь — заблокирует отправителя. Это единственное, что действительно прекращает поток от него.',
      [
        ...REPORT_REASONS.map((r) => ({
          text: r.label,
          onPress: () => {
            Alert.alert('Заблокировать отправителя?', 'Жалоба будет записана в любом случае.', [
              {
                text: 'Только записать',
                onPress: () => void recordContactReport(did, r.id, false)
                  .then(() => { setReported(true); showSuccess('Жалоба записана'); })
                  .catch((e: unknown) => showError(userErrorText(e, 'Не удалось записать жалобу'))),
              },
              {
                text: 'Записать и заблокировать',
                style: 'destructive' as const,
                onPress: () => void (async () => {
                  try {
                    await rateLimiter.blockContact(pub);
                    setBlocked(true);
                    await recordContactReport(did, r.id, true);
                    setReported(true);
                    showSuccess('Жалоба записана, контакт заблокирован');
                  } catch (e) {
                    showError(userErrorText(e, 'Не удалось записать жалобу'));
                  }
                })(),
              },
              { text: 'Отмена', style: 'cancel' as const },
            ]);
          },
        })),
        { text: 'Отмена', style: 'cancel' as const },
      ]
    );
  }, [resolved]);

  const onSetting = useCallback((id: SettingId) => {
    switch (id) {
      case 'wallpaper': setWallpaperOpen(true); return;
      case 'share_contact': shareContact(); return;
      case 'disappear': editDisappear(); return;
      case 'copy_guard': toggleCopyGuard(); return;
      case 'clear_history': clearHistory(); return;
      case 'block': toggleBlock(); return;
      case 'report': report(); return;
    }
  }, [shareContact, editDisappear, toggleCopyGuard, clearHistory, toggleBlock, report]);

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
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
              {/*
                v4.32.540: полоса обоев вместо пустого верха карточки. Клип и
                скругление стоят здесь, а не на слое: слой умеет только
                заполнять родителя, а верхние углы у него общие с карточкой.
              */}
              <View style={styles.cover} pointerEvents="none">
                <WallpaperBackground wallpaper={cover} ground={colors.surface} />
              </View>
              <View style={styles.body}>
              <View style={styles.header}>
                {/* Кольцо цветом карточки: кружок наезжает на обложку, и без
                    него лицо теряется на светлых пресетах.
                    v4.32.567: снимок вместо буквы — через общий реестр лиц,
                    тот же, что в списке чатов и в ленте. Своё фото он тоже
                    знает, поэтому свой профиль здесь больше не «?». */}
                <PersonAvatar
                  pub={resolved.pubB64}
                  did={resolved.did}
                  name={identity.named ? identity.title : null}
                  size={56}
                  style={[styles.avatarRing, { borderColor: colors.surface }]}
                />
                {renaming ? (
                  <View style={styles.headerBody}>
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
                  <View style={styles.headerBody}>
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
                    {identity.username ? (
                      <View style={styles.handleRow}>
                        <Text style={[styles.handle, { color: colors.accent }]} numberOfLines={1}>
                          @{identity.username}
                        </Text>
                        {identity.verified ? (
                          <VerifiedMark size={15} label="Официальный аккаунт" />
                        ) : null}
                      </View>
                    ) : null}
                    <Text style={[styles.hint, { color: colors.textSecondary }]}>
                      {identity.hint}
                    </Text>
                    {identity.bio ? (
                      <Text
                        style={[styles.bio, { color: colors.text }]}
                        numberOfLines={4}
                      >
                        {identity.bio}
                      </Text>
                    ) : null}
                  </View>
                )}
              </View>

              {/* Быстрые действия. Ряд, а не список: это то, ради чего карточку
                  чаще всего и открывают. */}
              <View style={styles.quickRow}>
                {quickActions.map((a) => (
                  <AppPressable
                    key={a.id}
                    style={[
                      styles.quickBtn,
                      { backgroundColor: colors.background, borderColor: colors.border },
                      a.disabled ? styles.quickDisabled : null,
                    ]}
                    disabled={a.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    onPress={() => onQuickAction(a.id)}
                  >
                    <Ionicons
                      name={a.id === 'mute' && muted ? 'notifications-outline' : QUICK_ICON[a.id]}
                      size={20}
                      color={a.disabled ? colors.textSecondary : colors.accent}
                    />
                    <Text
                      style={[
                        styles.quickLabel,
                        { color: a.disabled ? colors.textSecondary : colors.text },
                      ]}
                      numberOfLines={1}
                    >
                      {a.label}
                    </Text>
                  </AppPressable>
                ))}
              </View>

              {/* v4.32.568: сама коробка и есть кнопка «копировать» — тап по ней
                  кладёт в буфер полный DID, а не обрезанный показанный. Справа
                  «Поделиться»: два прежних пункта списка отсюда убраны, они
                  повторяли то, что и так под рукой. */}
              <View style={[styles.didBox, { borderColor: colors.border }]}>
                <AppPressable
                  style={styles.didMain}
                  onPress={() => void handleCopyId()}
                  accessibilityRole="button"
                  accessibilityLabel={COPY_ID_ACTION}
                >
                  <Text style={[styles.didLabel, { color: colors.textSecondary }]}>DID</Text>
                  <Text style={[styles.didValue, { color: colors.text }]} numberOfLines={1}>
                    {shortDid(resolved.did, 10)}
                  </Text>
                </AppPressable>
                <AppPressable
                  style={styles.didShare}
                  onPress={() => void handleShareId()}
                  accessibilityRole="button"
                  accessibilityLabel="Поделиться ID"
                >
                  <Ionicons name="share-outline" size={20} color={colors.accent} />
                </AppPressable>
              </View>

              <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Содержимое</Text>
              <View style={styles.actions}>
                {sections.map((sct) => (
                  <AppPressable
                    key={sct.id}
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={() => onSection(sct.id)}
                  >
                    <Ionicons name={SECTION_ICON[sct.id]} size={20} color={colors.text} />
                    <Text style={[styles.actionText, { color: colors.text }]}>{sct.label}</Text>
                    <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                  </AppPressable>
                ))}
              </View>

              <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Переписка</Text>
              <View style={styles.actions}>
                {settings.map((st) => (
                  <AppPressable
                    key={st.id}
                    style={[styles.actionRow, { borderTopColor: colors.border }]}
                    onPress={() => onSetting(st.id)}
                  >
                    <Ionicons
                      name={SETTING_ICON[st.id]}
                      size={20}
                      color={st.danger ? colors.error : colors.text}
                    />
                    <Text
                      style={[styles.actionText, { color: st.danger ? colors.error : colors.text }]}
                    >
                      {st.label}
                    </Text>
                    {st.value ? (
                      <Text style={[styles.actionValue, { color: colors.textSecondary }]}>
                        {st.value}
                      </Text>
                    ) : null}
                  </AppPressable>
                ))}
              </View>

              <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Профиль</Text>
              <View style={styles.actions}>
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
          </ScrollView>
        </View>
      </View>
      </KeyboardHost>

      {/* Дочерние окна карточки. Держатся внутри неё: закрыв галерею, человек
          возвращается в профиль, а не на экран под ним. */}
      <SharedMediaModal
        visible={mediaTab !== null}
        contactPubB64={resolved.pubB64}
        ownerProfileId={activeProfileId}
        gateway={gateway}
        initialTab={mediaTab ?? 'media'}
        onClose={() => setMediaTab(null)}
        onImagePress={() => { /* просмотрщик живёт в экране диалога */ }}
      />
      <ProfilePostsModal
        visible={postsMode !== null}
        mode={postsMode ?? 'posts'}
        authorDid={resolved.did}
        authorPubB64={resolved.pubB64}
        authorName={identity.named ? identity.title : 'профиль'}
        ownerProfileId={activeProfileId}
        onClose={() => setPostsMode(null)}
      />
      <WallpaperPickerModal
        visible={wallpaperOpen}
        peerB64={resolved.pubB64}
        current={wallpaper ?? defaultWallpaper(scheme)}
        onClose={() => setWallpaperOpen(false)}
        onApply={(wp) => setWallpaper(wp)}
      />
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
    // v4.32.540: отступ уехал внутрь, в `body`: обложка идёт от края до края,
    // а с общим padding она висела бы белой рамкой внутри карточки.
    maxWidth: 420,
    width: '100%',
    // v4.32.568: содержимого стало на экран — карточка перестала быть коротким
    // окном и прокручивается, упираясь в потолок высоты, а не в край экрана.
    maxHeight: '88%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  cover: {
    height: 96,
  },
  body: {
    padding: spacing.md,
  },
  header: {
    alignItems: 'center',
    // Кружок наезжает на обложку ровно наполовину: так видно и обложку, и то,
    // что аватар принадлежит карточке, а не полосе.
    marginTop: -46,
    marginBottom: spacing.md,
  },
  headerBody: {
    width: '100%',
    marginTop: spacing.sm,
    alignItems: 'center',
  },
  avatarRing: {
    borderWidth: 3,
  },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  handle: {
    fontSize: font.sm,
    fontWeight: '600',
  },
  bio: {
    fontSize: font.sm,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  name: {
    fontSize: font.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  hint: {
    fontSize: font.sm,
    marginTop: 2,
    textAlign: 'center',
  },
  quickRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  quickBtn: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  quickDisabled: {
    opacity: 0.45,
  },
  quickLabel: {
    fontSize: font.xs,
  },
  didBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  didMain: {
    flex: 1,
    padding: spacing.sm,
  },
  didShare: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  didLabel: {
    fontSize: font.xs,
    marginBottom: 2,
  },
  didValue: {
    fontSize: font.md,
    fontFamily: mono,
  },
  groupLabel: {
    fontSize: font.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
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
    flex: 1,
  },
  actionValue: {
    fontSize: font.sm,
  },
  renameInput: {
    alignSelf: 'stretch',
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
