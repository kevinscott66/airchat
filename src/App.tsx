import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Alert,
  Platform,
  Linking,
  Animated,
  Easing,
  AppState,
  InteractionManager,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useKeyboardHeight } from './ui/hooks/useKeyboardHeight';
import { Ionicons } from '@expo/vector-icons';
import * as SystemUI from 'expo-system-ui';
import { StatusBar } from 'expo-status-bar';
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { KeyPairBytes } from './core/crypto/keyManager';
import { ensureKeyPair, readKeyRecord, persistKeyPair } from './core/crypto/keyManager';
import { KEY_STORE_UNREADABLE_TEXT } from './core/crypto/keyRecordState';
import { profileManager } from './core/identity/profileManager';
import {
  deriveKeyPairFromMnemonic,
  getStoredMnemonic,
  hasBackupWarnAck,
  hasSeedShown,
  hasStoredMnemonic,
  isFirstLaunchDone,
  setFirstLaunchDone,
} from './core/backup/seedPhrase';
import { loadConfig } from './core/config';
import * as FileSystem from 'expo-file-system/legacy';
import { log } from './core/logger';
import { createTimerScope, type TimerScope } from './core/lifecycle/timerScope';
import { EducationalCommunicationRouter } from './core/transport/educational';
import { parseDidKey, publicKeyToDidKey } from './core/identity/did';
import { ownerPidForPublicKey } from './core/identity/ownerPidLookup';
import { OWN_DISPLAY_NAME_KEY, getOwnDisplayName, ownFieldGet, stripOwnDisplayName } from './core/identity/ownProfile';
import { ensureLocalStorageReadyForBoot, kvGet, subscribeChatWrites, purgeDisappearedMessages, createGroup, upsertGroupMember, groupIdState, liveAttachmentBlobIds } from './core/storage/local';
import { currentStorageEnv, diagnoseStorageFailure } from './core/storage/webStorageDiagnosis';
import { scheduleDialogBackupPersist } from './core/storage/dialogBackup';
import { parseGroupInviteLink } from './core/social/groupInviteLink';
import { AppPressable } from './ui/components/AppPressable';
import { LoginScreen } from './ui/screens/LoginScreen';
import { FeedScreen } from './ui/screens/FeedScreen';
import { ChatScreen } from './ui/screens/ChatScreen';
import { ProfileScreen } from './ui/screens/ProfileScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { GroupsScreen } from './ui/screens/GroupsScreen';
import { ProfileSelector } from './ui/components/ProfileSelector';
import { OnboardingScreen } from './ui/screens/OnboardingScreen';
import { LoadingScreen } from './ui/screens/LoadingScreen';
import { BackupWarningScreen } from './ui/screens/BackupWarningScreen';
import * as ExpoSplashScreen from 'expo-splash-screen';
import { nativeSplashPreventReady } from './splashGate';
import { getMessagingService, initMessagingService } from './core/social/messaging';
import { startLanTransportIfEnabled, stopLanTransportStack } from './core/transport/lan/lanCoordinator';
import {
  startInternetTransportIfEnabled,
  stopInternetTransportStack,
} from './core/transport/internet/internetCoordinator';
import { startNetworkReconnectWatcher, stopNetworkReconnectWatcher } from './core/transport/networkReconnectWatcher';
import { syncActiveAccount } from './core/sync/liveAccountSync';
import { initSentryFromEnv } from './core/errorHandler';
import { initPowerManager, recordUserActivity } from './core/powerManager';
import { pushNotificationService, disposePushNotificationService, notifyFeedEvent, setActiveTabName } from './notifications/pushNotifications';
import { createMeshCoordinatorIfEnabled, type MeshCoordinator } from './core/mesh/coordinator';
import {
  startFeedInboxListener,
  resumeCommentOutbox,
  stopFeedInboxListener,
  rebindFeedToProfile,
  reconcileOrphanInlineMedia,
  setFeedNotifyCallback,
} from './core/social/feedService';
import { initLongRangeTransport, shutdownLongRangeTransport } from './core/transport/longrange';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeScreen } from './ui/components/SafeScreen';
import { VpnStatusBanner } from './ui/components/VpnStatusBanner';
import { OfflineStatus } from './ui/components/OfflineStatus';
import { StoragePressureBanner } from './ui/components/StoragePressureBanner';
import {
  maybeStartEmbeddedVpn,
  retryEmbeddedVpn,
  type AirChatVpnUiStatus,
} from './core/vpn/airChatVpnController';
import { authGuard } from './core/security/authGuard';
import { PasswordScreen } from './ui/screens/PasswordScreen';
import { ForgotPasswordScreen } from './ui/screens/ForgotPasswordScreen';
import { ThemeProvider, useColors, useTheme, useThemedStyles } from './ui/ThemeContext';
import { TabRefProvider, type TabName } from './ui/TabRefContext';
import { TabBarInsetProvider } from './ui/TabBarInset';
import { getTotalUnreadCount, getTotalGroupUnreadCount } from './core/storage/local';
import { loadPersistedPresence, startPresenceBroadcast, stopPresenceBroadcast } from './core/social/presenceService';
import { listContacts } from './core/social/contacts';
import { startStoryInboxListener, stopStoryInboxListener } from './core/social/storyService';
import { startScheduler, stopScheduler } from './core/social/scheduledMessages';
import { initCallService } from './core/social/callService';
import { CallOverlay } from './ui/components/CallOverlay';
import { startJsThreadWatcher } from './core/utils/jsThreadWatcher';
import { scheduleAfterFirstFrame } from './core/utils/firstFrameGate';
import { setOpenIntentConsumer } from './notifications/openIntent';
import { useBackHandler } from './core/hooks/useBackHandler';
import { SwipeBackHost } from './ui/components/SwipeBackHost';
import { SplashOverlay, type SplashOverlayRef } from './ui/components/SplashOverlay';
import { badgeDigit, elevation, font, primaryInk, radius, spacing, toastSurface } from './ui/theme';
import type { AppColors, ColorScheme } from './ui/theme';
import { contactLabel } from './core/social/contactLabel';
import { shortIdentity } from './ui/identity/shortId';
import { GlassSurface } from './ui/components/GlassSurface';
import { AirChatWordmark } from './ui/components/AirChatWordmark';
import { TabGlyph } from './ui/components/TabGlyph';
import { ScreenSlot } from './ui/components/ScreenSlot';

log.info('boot_trace', { step: 'App.tsx_module_loaded' });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      }
    );
  });
}

/** Keystore/SecureStore идут через одну очередь — не используйте параллельные `withTimeout` на два ключа: второй ждёт в хвосте и отшибается по 30s. */
const BOOT_KEYSTORE_MS = 120000;

/** Окно подавления повторов одной и той же deep-link на холодном старте (опрос getInitialURL + событие 'url'). */
const DEEP_LINK_DEDUP_MS = 3000;

export type RootStackParamList = {
  Login: undefined;
  Main: { username: string; did: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Тема навигации из палитры приложения.
 *
 * v4.32.345: раньше это была константа модуля, намертво прибитая к тёмным
 * литералам, и прежний комментарий объяснял только половину причины. Своя тема
 * действительно нужна — дефолтная у @react-navigation светлая, и на Android она
 * давала белую вспышку на весь экран. Но лечится это совпадением с текущей
 * темой, а не фиксацией тёмной: в светлой теме ровно тот же механизм давал
 * обратную вспышку — тёмно-синий фон под экранами, тёмную шапку стека и
 * тёмно-синюю полосу при свайпе назад.
 */
function buildNavTheme(colors: AppColors, scheme: ColorScheme): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: scheme === 'dark',
    colors: {
      ...base.colors,
      background: colors.background,
      card: colors.background,
      primary: colors.primary,
      text: colors.text,
      border: colors.border,
      notification: colors.primary,
    },
  };
}

type Gate = 'boot' | 'onboarding' | 'backup_warn' | 'ready';

/**
 * Стили оболочки с табами.
 *
 * v4.32.345: были частью модульного StyleSheet, целиком написанного тёмными
 * литералами. Оболочка — единственное, что видно на каждом экране, поэтому в
 * светлой теме именно она рушила картинку сильнее всего: экраны рисовались
 * светлыми, а таббар, фон под ними и подпись с именем профиля оставались
 * тёмно-синими.
 */
/** Расчётная высота капсулы таббара до первого `onLayout` (см. `glassTabBar`). */
const TAB_BAR_ESTIMATE = 76 + spacing.sm;

function useMainTabsStyles() {
  return useThemedStyles((c) => ({
    main: { flex: 1, backgroundColor: c.background },
    tabBody: { flex: 1, backgroundColor: c.background },
    // Знак ПОД самим «островом», по центру полосы статуса, и не ловит касаний —
    // полоса принадлежит системе, кликать в ней нечего.
    islandMark: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    islandMarkGlyph: { opacity: 0.8 },
    tabBar: { backgroundColor: 'transparent' },
    // v4.32.532: плавающая капсула возвращена. Довод 530-й («таббар — край
    // окна, а не предмет») верен для плоской полосы, но неверен для стекла:
    // стекло обязано быть отдельным предметом, иначе кромке негде пройти.
    // v4.32.543: оговорка 532-й снята — капсула вынута из потока и лежит
    // оверлеем, а её высота раздаётся экранам через `TabBarInsetProvider`.
    // Теперь под стеклом едет лента, а не пустая заливка. Spacer при скрытом
    // таббаре остаётся в потоке и продолжает пользоваться `tabBar`.
    tabBarOverlay: {
      position: 'absolute' as const,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'transparent',
    },
    // Тень `overlay` обязательна: стекло само по себе плоское, высоту ему даёт
    // только тень под ним.
    glassTabBar: {
      marginHorizontal: spacing.sm,
      marginBottom: spacing.sm,
      borderRadius: radius.xl,
      minHeight: 76,
      ...elevation.overlay,
    },
    tabs: {
      flexDirection: 'row' as const,
      paddingTop: 7,
      justifyContent: 'space-around' as const,
      backgroundColor: 'transparent',
    },
    tabBtn: { paddingVertical: 6, paddingHorizontal: 4, alignItems: 'center' as const, minWidth: 52 },
    tabText: { color: c.textSecondary, fontSize: font.xs, marginTop: 4, textAlign: 'center' as const },
    tabActive: { color: c.accent, fontWeight: '700' as const, fontSize: font.xs, marginTop: 4, textAlign: 'center' as const },
    tabBadge: {
      position: 'absolute' as const,
      top: -4,
      right: -8,
      backgroundColor: c.primary,
      borderRadius: radius.sm,
      minWidth: 16,
      paddingHorizontal: 3,
      paddingVertical: 1,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    // Счётчик лежит на c.primary — не белый по договорённости, а чернила,
    // посчитанные от заливки. Сегодня это тот же белый, но теперь он выводится
    // там же, где и все остальные чернила на акценте (v4.32.414).
    tabBadgeText: { color: primaryInk(c).text, fontSize: badgeDigit, fontWeight: '700' as const, fontVariant: ['tabular-nums' as const] },
    userHint: { color: c.textMuted, fontSize: font.xs, flex: 1, textAlign: 'center' as const },
    userHintRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, paddingBottom: 6, paddingHorizontal: 12 },
    profileSwitchBtn: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 3, paddingLeft: 8 },
    profileSwitchHint: { color: c.textMuted, fontSize: font.xs },
    inAppBanner: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
    },
    // Плашка уведомления намеренно тёмная в обеих темах: это всплывающий тост
    // поверх контента, а не часть оболочки. Почему подложка и чернила берутся
    // из toastSurface, а не пишутся здесь, — в его doc-блоке (v4.32.414).
    inAppBannerInner: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: toastSurface.fill,
      marginHorizontal: 12,
      marginTop: 8,
      borderRadius: radius.lg,
      paddingHorizontal: 14,
      paddingVertical: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
    },
    inAppBannerName: { color: toastSurface.ink.text, fontWeight: '700' as const, fontSize: 14, marginBottom: 2 },
    inAppBannerPreview: { color: toastSurface.ink.secondary, fontSize: 13 },
  }));
}

function MainTabs({
  pair,
  username,
  did,
  multiProfileEnabled,
  onIdentityChange,
  onWalletLogout,
  onDisplayNameChanged,
}: {
  pair: KeyPairBytes;
  username: string;
  did: string;
  multiProfileEnabled: boolean;
  onIdentityChange: (kp: KeyPairBytes) => void;
  onWalletLogout: () => Promise<void>;
  onDisplayNameChanged: (name: string) => void;
}): React.ReactElement {
  useEffect(() => {
    log.info('main_tabs_mounted', { did });
  }, [did]);

  // v4.32.105 K.11b: при открытой клавиатуре прячем нижний таббар — иначе 5 кнопок
  // (Новости/Чаты/Группы/Профиль/Ещё) вылезают поверх клавиатуры из-за adjustResize.
  const kbHeight = useKeyboardHeight();
  const tabsHidden = kbHeight > 0;

  // v4.32.543: высота плавающей капсулы. Начальное значение — расчётное
  // (`minHeight` капсулы плюс её нижний отступ), чтобы на первом кадре списки
  // не рисовались без нижнего отступа и не дёргались после первого `onLayout`.
  // Дальше значение приходит из самого таббара: в него входит `insets.bottom`,
  // который на каждом аппарате свой.
  const [tabBarHeight, setTabBarHeight] = useState(TAB_BAR_ESTIMATE);

  // Мониторинг блокировок JS thread. Включён в v4.32.10 «временно», без
  // `__DEV__`-гейта, чтобы видеть реальные блоки в release-сборке.
  //
  // v4.32.362: на устройстве обычного пользователя он всё это время работал
  // впустую. Файлового sink у логов там нет (он включается скрытым жестом в
  // настройках), а без него log.warn не доходит никуда — ни в файл, ни в
  // console. То есть детектор десять раз в секунду будил JS-поток, собирал
  // события и звал логи, результат которых сразу выбрасывался: чистый расход
  // батареи, да ещё и в те самые минуты, когда потоку и без него тяжело.
  // Теперь он поднимается там же, где и запись лога: в отладочной сборке или
  // при включённой скрытой диагностике.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      let enabled = typeof __DEV__ !== 'undefined' && __DEV__;
      if (!enabled) {
        try {
          const { isInternalDiagnosticsEnabled } = await import('./core/internalDiagnostics');
          enabled = await isInternalDiagnosticsEnabled();
        } catch { /* не прочиталось — считаем выключенным */ }
      }
      if (!enabled || cancelled) return;
      stop = startJsThreadWatcher({
        // Уровень 1: базовый порог — любая задержка > 150 мс попадает в лог
        thresholdMs: 150,
        onBlock: ({ delayMs, timestamp }) => {
          log.warn('js_thread_blocked', { delayMs, timestamp });
        },
        // Уровень 2: агрегированная сводка каждые 5 с (не спамим лог каждым кадром)
        flushIntervalMs: 5_000,
        onFlush: ({ blocks, totalBlockedMs, maxDelayMs }) => {
          log.warn('js_thread_flush', {
            count: blocks.length,
            totalBlockedMs,
            maxDelayMs,
          });
        },
        // Уровень 3: тяжёлые блоки (> 1 с) — v4.32.14: Sentry.captureMessage отключён.
        // Гипотеза: require('@sentry/react-native') + sync stack capture на каждом severe блоке
        // мог провоцировать 30с катастрофические блокировки из-за рекурсии / native bridge call.
        severeThresholdMs: 1_000,
        onSevereBlock: ({ delayMs, timestamp }) => {
          log.error('js_thread_severe_block', { delayMs, timestamp });
        },
      });
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabName>('feed');
  // v4.32.525: слой уведомлений должен знать активную вкладку. Через
  // TabRefContext это не передать — он отдаёт ref без перерисовки, — а без
  // этого «открытая переписка» означала «когда-то открытая»: вкладки остаются
  // смонтированными, отметка не снималась, и уведомления от собеседника
  // пропадали до перезапуска. Здесь перерисовка и так происходит на каждый
  // setTab, поэтому лишней работы не добавляется.
  useEffect(() => { setActiveTabName(tab); }, [tab]);
  // Редкие разделы не должны выполнять свои SQLite/сеть-эффекты во время
  // первого кадра. Лента монтируется сразу, остальные разделы поднимаются при
  // первом открытии и затем остаются keep-alive для быстрых повторных тапов.
  const [mountedTabs, setMountedTabs] = useState<Set<TabName>>(
    () => new Set<TabName>(['feed']),
  );
  const mountedTabsRef = useRef<Set<TabName>>(new Set<TabName>(['feed']));
  const [mountingTab, setMountingTab] = useState<TabName | null>(null);
  const pendingMountTabRef = useRef<TabName | null>(null);
  const mountInteractionRef = useRef<{ cancel?: () => void } | null>(null);
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingMount = useCallback((clearVisual = true) => {
    pendingMountTabRef.current = null;
    mountInteractionRef.current?.cancel?.();
    if (mountTimerRef.current !== null) clearTimeout(mountTimerRef.current);
    mountInteractionRef.current = null;
    mountTimerRef.current = null;
    if (clearVisual) setMountingTab(null);
  }, []);
  const mountTab = useCallback((next: TabName) => {
    if (mountedTabsRef.current.has(next)) {
      // Возврат на уже готовый таб отменяет тяжёлый mount, который был
      // запрошен предыдущим тапом и больше не нужен пользователю.
      cancelPendingMount();
      return;
    }
    cancelPendingMount();
    pendingMountTabRef.current = next;
    setMountingTab(next);

    let settled = false;
    const commitMount = () => {
      if (settled || pendingMountTabRef.current !== next) return;
      settled = true;
      pendingMountTabRef.current = null;
      mountInteractionRef.current = null;
      mountTimerRef.current = null;
      mountedTabsRef.current.add(next);
      setMountedTabs((current) => {
        if (current.has(next)) return current;
        const updated = new Set(current);
        updated.add(next);
        return updated;
      });
      setMountingTab((current) => (current === next ? null : current));
    };

    // Переключение таба должно завершить текущий touch-событие. Сам экран
    // может быть большим (Chat/Groups), поэтому его первый mount переносим
    // после жеста; иначе React строит тысячи узлов прямо в цепочке onPress.
    mountInteractionRef.current = InteractionManager.runAfterInteractions(commitMount);
    mountTimerRef.current = setTimeout(commitMount, 350);
  }, [cancelPendingMount]);
  // v4.32.13: latest-tap-wins коалесинг.
  // Каждый setTab провоцирует ~2.2с JS-блок (React reconcile 5 keep-alive экранов + isActive-flip
  // триггерит useEffect cleanup/setup в GroupsScreen/ChatScreen). При тап-шторме (юзер физически
  // тапает 3-4 раза за <100мс) колбэки скапливаются в event loop. Без коалесинга каждый
  // setTab — отдельный render pass. Здесь: N тапов за 1 rAF-окно → один setTab с последним
  // значением. Сохраняет отзывчивость ripple (UI-thread), но не ставит N рендеров в очередь.
  const pendingTabRef = useRef<typeof tab | null>(null);
  // v4.32.505: заказанный кадр жил в голом ref и не снимался никогда. При
  // размонтировании корня (смена профиля, выход) отложенный кадр всё равно
  // срабатывал и звал setTab на снятом дереве. Область снимает его в cleanup
  // и после этого новых кадров не заказывает вовсе.
  const tabScopeRef = useRef<TimerScope | null>(null);
  if (tabScopeRef.current === null) tabScopeRef.current = createTimerScope();
  // v4.32.17: измеряем время от тапа до коммита setTab через useEffect([tab]).
  const tabTapTsRef = useRef<number>(0);
  const tabPrevRef = useRef<typeof tab>('feed');
  const scheduleTab = useCallback((next: typeof tab) => {
    pendingTabRef.current = next;
    if (tabTapTsRef.current === 0) tabTapTsRef.current = Date.now();
    const scope = tabScopeRef.current;
    if (!scope || scope.disposed) return;
    // Непустой счёт значит «кадр уже заказан» — коалесинг тапов держится
    // именно на этом. Одноразовый кадр снимается с учёта до вызова тела, так
    // что бросок изнутри не залипнет панелью вкладок навсегда.
    if (scope.activeCount > 0) return;
    scope.frame(() => {
      const pick = pendingTabRef.current;
      pendingTabRef.current = null;
      if (pick != null) {
        const raf2tap = Date.now() - tabTapTsRef.current;
        log.info('ui_settab_raf_done', { pick, from: tabPrevRef.current, tapToRaf: raf2tap });
        // Сначала меняем лёгкую оболочку и отдаём управление touch-событию.
        // Если вкладка ещё не смонтирована, mountTab покажет placeholder и
        // добавит тяжёлый экран после InteractionManager. Это не ставит
        // reconcile Chat/Groups в очередь прямо из onPress.
        setTab(pick);
        mountTab(pick);
      }
    });
  }, [mountTab]);
  useEffect(() => {
    const scope = tabScopeRef.current;
    return () => { scope?.dispose(); };
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingMount(false);
    };
  }, [cancelPendingMount]);
  // v4.32.17: коммит фактической смены tab — измеряем render→commit время.
  useEffect(() => {
    if (tabTapTsRef.current === 0) return;
    const ms = Date.now() - tabTapTsRef.current;
    log.info('ui_settab_commit_done', { tab, from: tabPrevRef.current, tapToCommit: ms });
    tabTapTsRef.current = 0;
    tabPrevRef.current = tab;
  }, [tab]);
  // В старой реализации все пять экранов монтировались на старте, поэтому
  // первый кадр конкурировал с загрузкой чатов, групп, профиля и настроек.
  // Теперь `mountedTabs` сохраняет keep-alive после первого открытия, но не
  // оплачивает работу редких вкладок до того, как они понадобятся.
  const [chatUnread, setChatUnread] = useState(0);
  const [groupUnread, setGroupUnread] = useState(0);
  /**
   * v4.32.229: бейджи непрочитанного на табах «Чаты»/«Группы».
   * До этого `chatUnread`/`groupUnread` объявлялись и рендерились (см. tabBadge
   * ниже), но ни один сеттер не вызывался нигде в проекте — счётчики всегда
   * оставались 0, т.е. фича была мёртвой с момента появления вёрстки бейджей.
   * Читаем суммы из SQLite на маунте/смене профиля (`pair` приходит новый после
   * `profileManager.switchProfile`) и на каждое изменение чатов —
   * `subscribeChatWrites` уже схлопнут дебаунсом 100мс в local.ts, так что
   * массовая доставка очереди DM не даст 50 запросов подряд.
   */
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      const pidAtCall = profileManager.getActiveProfile()?.id ?? 1;
      void (async () => {
        try {
          const [chat, groups] = await Promise.all([
            getTotalUnreadCount(pidAtCall),
            getTotalGroupUnreadCount(pidAtCall),
          ]);
          if (cancelled) return;
          // Профиль мог переключиться, пока шёл запрос — чужие счётчики не показываем.
          if ((profileManager.getActiveProfile()?.id ?? 1) !== pidAtCall) return;
          setChatUnread(chat);
          setGroupUnread(groups);
        } catch (e) {
          log.warn('unread_badges_refresh_failed', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    };
    refresh();
    const unsub = subscribeChatWrites(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pair]);
  const [profileSelOpen, setProfileSelOpen] = useState(false);
  const [activeProfileLabel, setActiveProfileLabel] = useState<string | null>(null);
  const [peerJump, setPeerJump] = useState<{ peer: string; token: number } | null>(null);
  const [groupJump, setGroupJump] = useState<{ groupId: string; token: number } | null>(null);
  // v4.32.228 (BUG-07): сигнал «вернуться к списку чатов из открытого диалога»
  // при повторном тапе по уже активному табу «Чаты» (поведение tap-active-tab→pop).
  const [chatPopToken, setChatPopToken] = useState(0);
  // Стабильная ссылка — иначе React.memo(ChatScreen) ререндерится каждый раз.
  const handleConversationClosed = useCallback(() => setPeerJump(null), []);
  const [feedTick, setFeedTick] = useState(0);

  // v4.32.61: системная кнопка «Назад» (Android) — top-level навигация.
  // Приоритет: активный чат/группа (peerJump/groupJump) → открытая модалка
  // выбора профиля → не-feed таб (возврат на feed как домашний) → exit app.
  // Ниже по дереву каждый экран/модалка сам перехватывает back через
  // useBackHandler / Modal.onRequestClose (покрывают свои subScreen'ы,
  // compose-сайды, selectedIds-режим). Этот handler — fallback верхнего уровня.
  useBackHandler(true, () => {
    if (peerJump) {
      setPeerJump(null);
      return true;
    }
    if (groupJump) {
      setGroupJump(null);
      return true;
    }
    if (profileSelOpen) {
      setProfileSelOpen(false);
      return true;
    }
    if (tab !== 'feed') {
      scheduleTab('feed');
      return true;
    }
    return false;
  });
  const meshCoordinatorRef = useRef<MeshCoordinator | null>(null);
  /**
   * v4.32.22: fast-path для identity-effect. Храним последние байты ключа,
   * чтобы при повторном `setPair` с тем же значением (напр. повторный тап
   * того же профиля в ProfileSelector → `profileManager.switchProfile` на
   * активный id) не запускать teardown+setup всех транспортов. `pair` из
   * useState — новый object reference каждый раз, сравниваем по bytes.
   */
  const prevPairBytesRef = useRef<Uint8Array | null>(null);

  // ─── In-app notification banner ────────────────────────────────────────────
  const [inAppBanner, setInAppBanner] = useState<{ peerPubB64: string; name: string; preview: string; groupId?: string; feed?: boolean } | null>(null);
  const bannerAnim = useRef(new Animated.Value(-80)).current;
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v4.32.191 (Round-21 #10): alive flag + active pid capture so a stale
  // listContacts().then resolved after unmount or profile switch doesn't
  // flash a cross-profile banner.
  const bannerAliveRef = useRef(true);

  // v4.32.147 (AUDIT P2 U3): top-level cleanup. Если MainTabs размонтируется
  // (например, при identity-change через `key={did}`) во время показа баннера —
  // 4-секундный setTimeout выживает unmount и в итоге дергает `setInAppBanner`
  // + `Animated.timing.start()` на уже размонтированном компоненте.
  useEffect(() => () => {
    bannerAliveRef.current = false;
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    try { bannerAnim.stopAnimation(); } catch { /* ignore */ }
  }, [bannerAnim]);

  const showBanner = useCallback((peerPubB64: string, preview: string, groupId?: string) => {
    const pidAtCall = profileManager.getActiveProfile()?.id ?? 1;
    void listContacts().then((ctacts) => {
      if (!bannerAliveRef.current) return;
      if ((profileManager.getActiveProfile()?.id ?? 1) !== pidAtCall) return;
      const c = ctacts.find((x) => x.peerPublicKey === peerPubB64);
      const name = contactLabel(c?.displayName, shortIdentity(peerPubB64));
      setInAppBanner({ peerPubB64, name, preview, groupId });
      Animated.timing(bannerAnim, { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => {
        Animated.timing(bannerAnim, { toValue: -80, duration: 250, useNativeDriver: true }).start(() => setInAppBanner(null));
      }, 4000);
    });
  }, [bannerAnim]);

  const showGroupBanner = useCallback((groupId: string, groupName: string, senderName: string, preview: string) => {
    setInAppBanner({ peerPubB64: '', name: `${groupName}`, preview: `${senderName}: ${preview}`, groupId });
    Animated.timing(bannerAnim, { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => {
      Animated.timing(bannerAnim, { toValue: -80, duration: 250, useNativeDriver: true }).start(() => setInAppBanner(null));
    }, 4000);
  }, [bannerAnim]);

  // v4.32.92: banner для событий ленты (новый пост / комментарий).
  const showFeedBanner = useCallback((title: string, preview: string) => {
    setInAppBanner({ peerPubB64: '', name: title, preview, feed: true });
    Animated.timing(bannerAnim, { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => {
      Animated.timing(bannerAnim, { toValue: -80, duration: 250, useNativeDriver: true }).start(() => setInAppBanner(null));
    }, 4000);
  }, [bannerAnim]);

  useEffect(() => {
    const { subscribeInAppNotifications } = require('./core/social/messaging') as typeof import('./core/social/messaging');
    const unsub = subscribeInAppNotifications((n: { peerPubB64: string; preview: string }) => {
      if (tab === 'chat' && peerJump?.peer === n.peerPubB64) return;
      showBanner(n.peerPubB64, n.preview);
    });
    return unsub as () => void;
  }, [tab, peerJump, showBanner]);

  useEffect(() => {
    const { setGroupMessageNotifyCallback } = require('./core/social/groupMessaging') as typeof import('./core/social/groupMessaging');
    // v4.32.195 (Round-25 #4): registry now returns unsub; no more clobbering
    // pushNotifications.ts's sibling subscription.
    const unsub = setGroupMessageNotifyCallback((groupName: string, senderName: string, text: string, groupId?: string, _kind?: 'group' | 'channel') => {
      if (tab === 'groups' && groupJump?.groupId === groupId) return;
      showGroupBanner(groupId ?? '', groupName, senderName, text.slice(0, 60));
    });
    return () => { unsub(); };
  }, [tab, groupJump, showGroupBanner]);

  // v4.32.92: in-app banner при входящих событиях ленты. Суппрессим, если юзер
  // уже в «Новостях» — он и так увидит обновление через feedTick-refresh.
  useEffect(() => {
    setFeedNotifyCallback(async (ev) => {
      if (tab === 'feed') return;
      // v4.32.166: per-entity mute. Post-level mute глушит только комменты
      // к конкретному посту; chat-level mute автора глушит и посты, и комменты.
      try {
        const { isMuted } = require('./core/notifications/muteStore') as typeof import('./core/notifications/muteStore');
        if (ev.kind === 'comment' && ev.postId && (await isMuted('post', ev.postId))) return;
        if (ev.authorDid && (await isMuted('chat', ev.authorDid))) return;
      } catch { /* fallthrough */ }
      const authorLabel = ev.authorName?.trim() || shortIdentity(ev.authorDid);
      const title = ev.kind === 'post' ? `${authorLabel} · новая публикация` : `${authorLabel} · комментарий`;
      const body = ev.preview || (ev.kind === 'post' ? '(медиа)' : '');
      showFeedBanner(title, body);
      // v4.32.165: параллельно с in-app banner'ом — system notification в шторку
      // через notifee (канал airchat_feed_v2, DEFAULT importance). In-app banner
      // виден только когда приложение открыто; system-notif нужен для фон-сценария
      // (screen-off, другая app, home-screen).
      void notifyFeedEvent({
        title,
        body,
        postId: ev.kind === 'comment' ? ev.postId : undefined,
        kind: ev.kind,
      });
    });
    return () => { setFeedNotifyCallback(null); };
  }, [tab, showFeedBanner]);

  /**
   * v4.32.22: единый последовательный identity-effect.
   *
   * Раньше при `setPair(newPair)` (после `profileManager.switchProfile`) срабатывали
   * 4 разных useEffect'а с `[pair]` / `[pair, did]`:
   *   (1) profileManager.init + label
   *   (2) mesh coordinator dispose+create (+ loadConfig)
   *   (3) rebindFeedToProfile + startFeedInboxListener (открывает SQLite feed)
   *   (4) initMessagingService + startLanTransport + startStoryInbox + startScheduler
   *       + purgeDisappearedMessages + setInterval 60с (+ loadConfig)
   *
   * Все 4 cleanup'а и 4 setup'а выполнялись параллельно в один SQLite → 5× race
   * на `feedStorage.init` (зафиксировано в логах v4.32.21), 30-50с write-lock
   * (`p1:contact:* ms=37223`, `feed_publish_queue_v1 ms=35209`, `tapToCommit=50869`).
   *
   * Теперь teardown → setup идут СЕРИЙНО внутри одного эффекта. Плюс вход
   * `setFeedProfileContext` / `FeedStorage.init` мемоизирован promise'ом (v4.32.22).
   *
   * Scheduled update: один раз `loadConfig`, один раз `getActiveProfile`.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    let purgeTimer: ReturnType<typeof setInterval> | null = null;
    let sweepTimer: ReturnType<typeof setTimeout> | null = null;
    const deferredCleanups: Array<() => void> = [];
    const deferAfterFirstFrame = (task: () => Promise<void> | void): void => {
      // v4.32.557: ждать кадра — да, ждать его вечно — нет. В фоне кадров не
      // бывает вовсе, и весь сетевой запуск (транспорт, push, звонки,
      // presence) не начинался никогда. См. firstFrameGate.
      const cancel = scheduleAfterFirstFrame(
        {
          appState: AppState.currentState,
          requestFrame: (cb) => requestAnimationFrame(cb),
          cancelFrame: (h) => cancelAnimationFrame(h as number),
          setTimer: (cb, ms) => setTimeout(cb, ms),
          clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        (trigger) => {
          if (!alive) return;
          if (trigger !== 'frame') {
            // Дать понять по журналу, что запуск пошёл в обход кадра.
            log.info('deferred_setup_without_frame', { trigger, appState: AppState.currentState });
          }
          void Promise.resolve(task()).catch((err) => {
            log.warn('deferred_identity_setup_failed', {
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }
      );
      deferredCleanups.push(cancel);
    };
    // v4.32.22: сравниваем с prev — если байты ключа те же, каскад НЕ нужен.
    const prev = prevPairBytesRef.current;
    const sameIdentity =
      prev !== null &&
      prev.length === pair.secretKey.length &&
      (() => {
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] !== pair.secretKey[i]) return false;
        }
        return true;
      })();
    if (sameIdentity) {
      // Ничего не пересоздаём. Обновим только label (имя могло поменяться
      // через renameProfile → onIdentityUpdated).
      setActiveProfileLabel(profileManager.getActiveProfile()?.name ?? null);
      return () => {
        alive = false;
      };
    }
    prevPairBytesRef.current = pair.secretKey.slice();
    void (async () => {
      try {
        await profileManager.init();
        if (!alive) return;
        setActiveProfileLabel(profileManager.getActiveProfile()?.name ?? null);
        const pid = profileManager.getActiveProfile()?.id ?? 1;

        // v4.32.186 (Round-16 #5): rateLimiter is constructed at module-load
        // (before profileManager initializes) and loads blocked list for
        // pid=1. If the active profile is 2+, blocked peers are stale until
        // a profile switch. Force reload now.
        try {
          const { rateLimiter } = await import('./core/security/rateLimiter');
          await rateLimiter.resetForProfileSwitch();
        } catch { /* non-fatal */ }

        const cfg = await loadConfig();
        if (!alive) return;

        // 1. Feed bind (SQLite open — выполняется строго первым, чтобы избежать
        //    гонки с FeedScreen.loadFeed на новом pair).
        await rebindFeedToProfile(pid);
        if (!alive) return;

        // 2. Messaging service (new instance after dispose in cleanup).
        initMessagingService(pair);
        initPowerManager();

        // Локальная подписка нужна сразу: она дешёвая и позволяет первому
        // экрану обновиться, пока сетевые сервисы запускаются в фоне.
        await startFeedInboxListener(did, pid, () => {
          if (alive) setFeedTick((t) => t + 1);
        });
        if (!alive) return;
        deferAfterFirstFrame(async () => {
          // Orphan cleanup walks every feed/profile and can be expensive after
          // a long offline period. It is maintenance work, so keep the first
          // interactive frame independent from it. The feed listener is live
          // already; a stale inline attachment is harmless until this sweep
          // removes it.
          try {
            await reconcileOrphanInlineMedia(pid);
          } catch (err) {
            log.warn('feed_reconcile_failed', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
          if (!alive) return;

          // Транспорт и фоновые сервисы запускаются после первого кадра. Это
          // не меняет локальную готовность ленты, но убирает конкуренцию за JS
          // поток во время входа.
          await startLanTransportIfEnabled(pair, cfg);
          if (!alive) return;
          await startInternetTransportIfEnabled(pair, cfg);
          if (!alive) return;
          let syncMnemonic: string | null = null;
          const runLiveSync = () => {
            if (!syncMnemonic || !alive) return;
            void syncActiveAccount(syncMnemonic, pair, pid);
          };
          startNetworkReconnectWatcher(pair, runLiveSync);
          void getStoredMnemonic().then((storedMnemonic) => {
            if (!alive || !storedMnemonic) return;
            syncMnemonic = storedMnemonic;
            runLiveSync();
          }).catch((error) => {
            log.warn('live_sync_mnemonic_load_failed', {
              err: error instanceof Error ? error.message : String(error),
            });
          });
          meshCoordinatorRef.current = createMeshCoordinatorIfEnabled(pair, cfg.mesh);
          resumeCommentOutbox(pair);
          startStoryInboxListener(pair, () => {});
          startScheduler();
          void pushNotificationService.init({ peerId: did });
          sweepTimer = setTimeout(() => {
            if (!alive) return;
            // v4.32.518: уборщику передаётся источник живых ссылок. Без него он
            // стирал файлы по одному возрасту — вместе с вложениями переписки,
            // у которых копии больше нигде нет (см. cacheSweepPolicy).
            void import('./core/media/mediaBlob')
              .then((m) => m.sweepMediaCache(liveAttachmentBlobIds))
              .catch(() => { /* best-effort */ });
          }, 20_000);

          try {
            await initCallService(did, pair, pid);
          } catch (e) {
            log.warn('init_call_service_failed', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
          if (!alive) return;
          let peerKeys: string[] = [];
          try {
            const contacts = await listContacts();
            peerKeys = contacts.map((c) => c.peerPublicKey);
          } catch (e) {
            log.warn('presence_contacts_failed', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
          if (!alive) return;
          try {
            await loadPersistedPresence(peerKeys, ownerPidForPublicKey(pair.publicKey));
          } catch (e) {
            log.warn('presence_load_persisted_failed', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
          if (!alive) return;
          try {
            const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
            await startPresenceBroadcast(myPubB64);
          } catch (e) {
            log.warn('presence_broadcast_start_failed', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
          if (!alive) return;
          void purgeDisappearedMessages();
          purgeTimer = setInterval(() => void purgeDisappearedMessages(), 60_000);
          void import('./core/storage/local').then((m) => m.sweepOrphanSendingMessages());
          void import('./core/storage/local').then((m) => m.purgeControlEnvelopeMessages());
        });
      } catch (e) {
        log.warn('identity_effect_setup_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      alive = false;
      deferredCleanups.forEach((cleanup) => cleanup());
      // Teardown порядок обратный setup'у: сначала верхние слои (таймеры,
      // подписки), потом транспорт, потом messaging, потом mesh.
      if (purgeTimer) clearInterval(purgeTimer);
      if (sweepTimer) clearTimeout(sweepTimer);
      stopScheduler();
      stopStoryInboxListener();
      stopFeedInboxListener();
      // v4.32.135: stop presence heartbeat + unsub contact topics before we
      // tear down the transport layer underneath it.
      void stopPresenceBroadcast();
      // v4.32.143 (AUDIT P1 T3/T4): detach FCM onMessage + onTokenRefresh so
      // identity rotation doesn't stack listeners (2× banners) or leak a
      // token-refresh handler still bound to the old peerId.
      void disposePushNotificationService();
      stopLanTransportStack();
      stopInternetTransportStack();
      stopNetworkReconnectWatcher();
      getMessagingService()?.dispose();
      meshCoordinatorRef.current?.dispose();
      meshCoordinatorRef.current = null;
    };
  }, [pair, did]);

  /** adb/UI automation: нижние табы на части Android (жест «Домой») перехватывают координатные тапы — открываем вкладку по deep link. */
  const lastDeepLinkTabUrlRef = useRef<{ url: string; at: number } | null>(null);
  useEffect(() => {
    const applyTabUrl = (url: string | null): void => {
      if (!url?.startsWith('airchat:')) return;
      // Dedup FIRST: на холодном старте getInitialURL() опрашивается несколько
      // раз подряд и отдаёт один и тот же URL, а следом может прийти событие
      // 'url' с ним же. Без защиты ветка join-group выстроила бы очередь из
      // одинаковых Alert.
      //
      // v4.32.249: раньше сравнивался только URL, без времени, и запись никогда
      // не сбрасывалась. Поэтому ссылка срабатывала ровно один раз за запуск
      // приложения: нажал приглашение, нажал «Отмена» — и та же ссылка больше
      // не открывалась вообще, до перезапуска. То же с airchat://tab/... .
      // Дедуп нужен только на всплеск в пределах пары секунд, дальше повторное
      // нажатие — осознанное действие пользователя.
      const prev = lastDeepLinkTabUrlRef.current;
      const now = Date.now();
      if (prev && prev.url === url && now - prev.at < DEEP_LINK_DEDUP_MS) return;
      lastDeepLinkTabUrlRef.current = { url, at: now };
      // v4.32.180 (Round-10 #6): bound URL/path length before split — defensive against crafted links.
      if (url.length > 16384) return;
      const path = url.replace(/^airchat:\/\//, '').split(/[?#]/)[0];
      if (path.length > 8192) return;
      const parts = path.split('/').filter(Boolean);
      if (parts.length > 16) return;

      // Handle group invite links: airchat://join-group/<base64>
      if (parts[0] === 'join-group' && parts[1]) {
        try {
          // v4.32.260: разбор и проверка формы недоверенной ссылки живут в
          // groupInviteLink — там же, где сборка, и покрыты тестами. Раньше всё
          // это лежало здесь в одном экземпляре, проверялось только глазами и
          // требовало поля members, которого основная кнопка приглашения не
          // клала — то есть отвергало собственные ссылки приложения.
          const payload = parseGroupInviteLink(parts[1]);
          if (!payload) throw new Error('invite_bad_shape');
          const pid = profileManager.getActiveProfile()?.id ?? 1;
          const requireApproval = payload.requireApproval;
          // Имя и имена участников уже очищены от control-символов: они идут
          // прямо в Alert.alert, где перевод строки подделывает диалог.
          const safeName = payload.name;
          Alert.alert(
            requireApproval ? 'Запрос на вступление' : 'Присоединиться к группе',
            requireApproval
              ? `Группа "${safeName}" требует одобрения администратора. Отправить запрос?`
              : `"${safeName}" — ${payload.members.length} участников`,
            [
              { text: 'Отмена', style: 'cancel' },
              {
                text: requireApproval ? 'Отправить запрос' : 'Присоединиться',
                onPress: () => {
                  void (async () => {
                    // v4.32.185 (Round-15 #1): guard pair null (invite arrived
                    // before identity was loaded) — previously crashed with
                    // TypeError on pair!.publicKey.
                    if (!pair) {
                      Alert.alert('AirChat', 'Профиль ещё загружается, попробуйте снова через несколько секунд');
                      return;
                    }
                    // v4.32.463: ссылка заводит группу, но никогда не
                    // переписывает уже заведённую. Проверка стоит до обеих
                    // дорог (заявка и прямое вступление) и до единой записи в
                    // БД; само правило и разбор того, что ломалось без него,
                    // живут в groupInviteApply.
                    const { decideInviteApply, inviteApplyProblem } = await import('./core/social/groupInviteApply');
                    const applyDecision = decideInviteApply(await groupIdState(payload.id, pid));
                    const applyProblem = inviteApplyProblem(applyDecision, safeName);
                    if (applyProblem) {
                      Alert.alert('AirChat', applyProblem);
                      // Группа уже наша — показать её полезнее, чем оставить
                      // человека на том экране, с которого он открыл ссылку.
                      if (applyDecision.kind === 'already_here') {
                        mountTab('groups');
                        setTab('groups');
                        return;
                      }
                      return;
                    }
                    const { getOwnDisplayName } = await import('./core/identity/ownProfile');
                    const displayName = (await getOwnDisplayName()) ?? 'Пользователь';
                    const myPub = Buffer.from(pair.publicKey).toString('base64');
                    if (requireApproval) {
                      // Send join request to admin, don't create group locally yet
                      const { sendGroupJoinRequest, INVITE_PENDING_KEY_PREFIX } = await import('./core/social/groupMessaging');
                      // v4.32.303: токен предъявляется и здесь — отзыв ссылки
                      // должен работать на обеих дорогах, иначе отозванная
                      // ссылка перестала бы пускать без одобрения и продолжала
                      // бы приводить незнакомцев в список заявок.
                      const asked = await sendGroupJoinRequest(payload.id, safeName, payload.adminPub, myPub, displayName, undefined, payload.token);
                      // Помечаем, что мы сами попросились именно к этому
                      // администратору — тогда его приглашение будет принято,
                      // даже если он не в наших контактах. Метка ставится и
                      // после неудачи: она про наше намерение, а не про факт
                      // отправки, и нужна при повторной попытке по той же ссылке.
                      // v4.32.465: маркер намерения — свой у каждого аккаунта.
                      // Под общим именем он пускал приглашение в тот профиль,
                      // который об этой группе не просил: в нём могло быть
                      // включено «в группы добавляют только контакты», а
                      // администратора там нет в контактах вовсе.
                      const { profileKvSet } = await import('./core/storage/local');
                      await profileKvSet(pid, INVITE_PENDING_KEY_PREFIX + payload.id, payload.adminPub);
                      // v4.32.451: «Запрос отправлен» говорилось безусловно —
                      // в том числе когда конверт никуда не ушёл. Группы у
                      // заявителя нет, повторить неоткуда: он просто ждал.
                      const { joinRequestProblem } = await import('./core/social/groupControlOutcome');
                      Alert.alert('AirChat', joinRequestProblem(asked) ?? 'Запрос на вступление отправлен администратору');
                    } else {
                      // isAdmin=false: вступивший по ссылке — обычный участник,
                      // а не администратор (см. createGroup в local.ts).
                      //
                      // v4.32.513: вид группы берётся из ссылки. Здесь стояло
                      // литеральное 'group', и канал, в который вошли по
                      // ссылке, заводился обычной группой — навсегда:
                      // createGroup это INSERT OR IGNORE, ветка 'invite' на
                      // известной группе выходит сразу, а 'meta' вида не
                      // несёт. Подписчик получал поле ввода, писал в канал и
                      // видел своё сообщение только у себя: на чужих
                      // устройствах его отбрасывал canSendToGroup.
                      await createGroup(payload.id, pid, safeName, payload.type, undefined, false);
                      for (const m of payload.members) {
                        // pub проверен на 32-байтную base64, имя очищено —
                        // всё это сделал parseGroupInviteLink.
                        await upsertGroupMember({ groupId: payload.id, peerPubB64: m.pub, role: m.pub === payload.adminPub ? 'admin' : 'member', displayName: m.name, joinedAt: Date.now(), ownerProfileId: pid });
                      }
                      // v4.32.260: администратор — единственная гарантированная
                      // точка входа: через него мы сообщаем о себе остальным.
                      // В ссылке его может не быть (ссылки, выданные основной
                      // кнопкой, шли вообще без списка участников), а без него
                      // конверт 'join' рассылать некому.
                      if (payload.adminPub !== myPub && !payload.members.some((m) => m.pub === payload.adminPub)) {
                        await upsertGroupMember({ groupId: payload.id, peerPubB64: payload.adminPub, role: 'admin', displayName: null, joinedAt: Date.now(), ownerProfileId: pid });
                      }
                      // Себя тоже записываем — иначе собственный список
                      // участников не совпадает с чужими.
                      await upsertGroupMember({ groupId: payload.id, peerPubB64: myPub, role: 'member', displayName, joinedAt: Date.now(), ownerProfileId: pid });
                      // v4.32.231 (CRIT): сообщаем о себе остальным. Без этого
                      // нас нет ни в одной чужой таблице group_members, и
                      // анти-спуф-фильтр входящих молча выбрасывает все наши
                      // сообщения в группу на каждом устройстве.
                      const { fanoutGroupControl } = await import('./core/social/groupMessaging');
                      // v4.32.303: токен из ссылки предъявляется вместе с
                      // самопредставлением — по нему получатель и отличает
                      // действующую ссылку от отозванной. Своего решения мы тут
                      // не принимаем: у ссылки старой версии токена нет, и
                      // отказ (или пропуск) — целиком дело принимающего.
                      const intro = await fanoutGroupControl(
                        payload.id,
                        pid,
                        myPub,
                        { op: 'join', target: myPub, targetName: displayName, ...(payload.token ? { inviteToken: payload.token } : {}) },
                        displayName
                      );
                      mountTab('groups');
                      setTab('groups');
                      // v4.32.449: если самопредставление не ушло, «Вы добавлены
                      // в группу» — неправда: участники о нас не знают, и их
                      // анти-спуф-фильтр молча выбросит каждое наше сообщение.
                      // Повторной отправки у конверта нет, поэтому сказать об
                      // этом надо здесь и сейчас.
                      const { groupControlProblem } = await import('./core/social/groupControlOutcome');
                      Alert.alert('AirChat', groupControlProblem(intro) ?? `Вы добавлены в группу "${safeName}"`);
                    }
                  })();
                },
              },
            ]
          );
        } catch {
          Alert.alert('AirChat', 'Недействительная ссылка приглашения');
        }
        return;
      }

      if (parts[0] !== 'tab' || !parts[1]) return;
      const map: Record<string, TabName> = {
        feed: 'feed',
        chat: 'chat',
        groups: 'groups',
        // v4.32.461: список контактов живёт в Профиле (с v4.32.30), поэтому
        // старая ссылка airchat://tab/contacts ведёт туда, а не в пустоту.
        contacts: 'profile',
        profile: 'profile',
        settings: 'settings',
      };
      const next = map[parts[1]];
      if (!next) return;
      recordUserActivity();
      mountTab(next);
      setTab(next);
      log.info('deep_link_tab', { url, tab: next });
    };
    const sub = Linking.addEventListener('url', (e) => applyTabUrl(e.url));
    let cancelled = false;
    void (async () => {
      // Poll getInitialURL() a few times early in cold start; stop once we see any URL
      // (or keep polling briefly if null). Previously looped 24× / 6s unconditionally.
      for (let i = 0; i < 8 && !cancelled; i++) {
        try {
          const u = await Linking.getInitialURL();
          if (u) {
            applyTabUrl(u);
            break;
          }
        } catch {
          /* empty */
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    })();
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [pair, mountTab]);

  /**
   * v4.32.558: нажатие на уведомление наконец открывает переписку.
   *
   * До этого не открывал никто: обработчик при открытом приложении звал
   * необязательный onOpenChat, которого не передавали, фонового обработчика не
   * было вовсе, а нажатие, запустившее приложение, никто не читал. Здесь —
   * единственная точка, где намерение превращается в открытый диалог; ждать
   * этой точки намерение умеет само (см. notifications/openIntent).
   */
  useEffect(() => {
    return setOpenIntentConsumer((intent, source) => {
      recordUserActivity();
      if (intent.kind === 'group') {
        // v4.32.560: групповой баннер обзавёлся полезной нагрузкой, и нажатие
        // на него наконец ведёт в саму группу. Открытие делает GroupsScreen по
        // groupJump — он же отличает «такой группы нет» от «не смогли
        // прочитать» и не врёт про первое, когда случилось второе.
        log.info('notification_open_intent', { source, target: 'group' });
        setGroupJump({ groupId: intent.groupId, token: Date.now() });
        mountTab('groups');
        setTab('groups');
        return;
      }
      if (intent.kind === 'call') {
        // v4.32.573: нажатие на баннер звонка только выводит приложение
        // вперёд. Само окно звонка поднимет CallOverlay, когда по сокету
        // приедет предложение: звонящий повторяет его, пока телефон не
        // появится в сети (см. notifications/callPush). Открывать здесь
        // нечего — соединение через уведомление не поднимешь.
        log.info('notification_open_intent', { source, target: 'call' });
        return;
      }
      log.info('notification_open_intent', { source, target: 'chat', hasDid: !!intent.contactDid });
      // Собеседник известен — прыгаем прямо в его ветку; неизвестен (старое
      // уведомление без DID) — открываем хотя бы список переписок, это
      // заметно лучше, чем прежнее «ничего не произошло».
      const pub = intent.contactDid ? parseDidKey(intent.contactDid) : null;
      if (pub) setPeerJump({ peer: Buffer.from(pub).toString('base64'), token: Date.now() });
      mountTab('chat');
      setTab('chat');
      // Сообщение могло ещё не доехать по сети: уведомление несёт только cid.
      void Promise.resolve(getMessagingService()?.handlePushOpen(intent.cid, intent.contactDid)).catch(
        (e: unknown) => {
          log.warn('notification_open_fetch_failed', { err: e instanceof Error ? e.message : String(e) });
        }
      );
    });
  }, [mountTab]);

  const colors = useColors();
  const styles = useMainTabsStyles();
  const tabColor = (active: boolean) => (active ? colors.accent : colors.textSecondary);

  // @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
  // Причина: useCallback-стабильные хендлеры для React.memo-экранов. Если заменить
  // на inline arrow — при каждом setTab ВСЕ экраны (даже display:none) перерисуются,
  // вернётся лаг кликов при быстрых переключениях (см. v4.32.5).
  const handleOpenDmFromGroup = useCallback((peer: string, name: string) => {
    setPeerJump({ peer, token: Date.now() });
    mountTab('chat');
    setTab('chat');
    void name;
  }, [mountTab]);
  const handleOpenChatWithPeer = useCallback((peer: string) => {
    setPeerJump({ peer, token: Date.now() });
    mountTab('chat');
    setTab('chat');
  }, [mountTab]);
  const handleOpenSettings = useCallback(() => {
    mountTab('settings');
    setTab('settings');
  }, [mountTab]);
  const handleOpenProfiles = useCallback(() => {
    setProfileSelOpen(true);
  }, []);
  const handleDisplayNameChanged = useCallback((name: string) => {
    onDisplayNameChanged(name);
    setActiveProfileLabel(name);
  }, [onDisplayNameChanged]);
  const handleProfileIdentityUpdated = useCallback(() => {
    onIdentityChange(profileManager.getActiveKeyPair());
    setActiveProfileLabel(profileManager.getActiveProfile()?.name ?? null);
  }, [onIdentityChange]);

  return (
    <TabRefProvider tab={tab}>
    <TabBarInsetProvider value={tabsHidden ? 0 : tabBarHeight}>
    {/*
      v4.32.540: «По свайпу экрана слева направо по средней части экрана можно
      вернуться на предыдущую страницу». Обёртка стоит здесь, вокруг всех
      вкладок разом: жест ведёт в тот же стек «Назад», что и системная кнопка,
      поэтому отдельной логики возврата ни одному экрану заводить не нужно.
    */}
    <SwipeBackHost
      style={styles.main}
      testID="main_tabs"
      collapsable={false}
    >
      {/*
        v4.32.540: верхний отступ под часы и «остров» снят с оболочки и роздан
        экранам. Раньше полоса safe-area была частью оболочки и заливалась
        `c.background` — а значит обои переписки, единственный фон, который в
        приложении вообще есть, обрывались по нижнюю кромку часов. Теперь экран
        занимает стекло целиком, фон доходит до верхнего края, а под часы
        отступает уже содержимое: шапка переписки, заголовок ленты, шапка
        профиля и настроек. Каждая из них и так непрозрачна — им отступ идёт
        на пользу, фону он мешал.
      */}
      <View style={styles.tabBody}>
        {mountedTabs.has('feed') ? (
          <ScreenSlot active={tab === 'feed'}>
            <FeedScreen pair={pair} did={did} feedTick={feedTick} />
          </ScreenSlot>
        ) : tab === 'feed' ? <View style={{ flex: 1 }}><LoadingScreen message="Открываем раздел…" testID="tab_mount_feed" /></View> : null}
        {mountedTabs.has('chat') ? (
          <ScreenSlot active={tab === 'chat'}>
            <ChatScreen
              pair={pair}
              peerJump={peerJump}
              popToListToken={chatPopToken}
              onConversationClosed={handleConversationClosed}
            />
          </ScreenSlot>
        ) : tab === 'chat' && mountingTab === 'chat' ? <View style={{ flex: 1 }}><LoadingScreen message="Открываем раздел…" testID="tab_mount_chat" /></View> : null}
        {mountedTabs.has('groups') ? (
          <ScreenSlot active={tab === 'groups'}>
            <GroupsScreen
              pair={pair}
              groupJump={groupJump ?? undefined}
              onOpenDm={handleOpenDmFromGroup}
            />
          </ScreenSlot>
        ) : tab === 'groups' && mountingTab === 'groups' ? <View style={{ flex: 1 }}><LoadingScreen message="Открываем раздел…" testID="tab_mount_groups" /></View> : null}
        {mountedTabs.has('profile') ? (
          <ScreenSlot active={tab === 'profile'}>
            <ProfileScreen
              did={did}
              pair={pair}
              onOpenSettings={handleOpenSettings}
              multiProfileEnabled={multiProfileEnabled}
              onOpenProfiles={handleOpenProfiles}
              activeProfileName={activeProfileLabel}
              onDisplayNameChanged={handleDisplayNameChanged}
              onOpenChatWithPeer={handleOpenChatWithPeer}
            />
          </ScreenSlot>
        ) : tab === 'profile' && mountingTab === 'profile' ? <View style={{ flex: 1 }}><LoadingScreen message="Открываем раздел…" testID="tab_mount_profile" /></View> : null}
        {mountedTabs.has('settings') ? (
          <ScreenSlot active={tab === 'settings'}>
            <SettingsScreen
              profilesEnabled={multiProfileEnabled}
              onProfileIdentityUpdated={handleProfileIdentityUpdated}
              onLogout={onWalletLogout}
            />
          </ScreenSlot>
        ) : tab === 'settings' && mountingTab === 'settings' ? <View style={{ flex: 1 }}><LoadingScreen message="Открываем раздел…" testID="tab_mount_settings" /></View> : null}
      </View>
      {/*
        v4.32.552: знак лежит ПОД «островом» — и в этом весь его смысл.

        «Остров» не принадлежит приложению: это чёрная маска, которую рисует
        система поверх окна. В работе она закрывает собой всё, что оказалось под
        ней, — знака не видно вовсе, и он никому не мешает. Но в снимок экрана
        маска не попадает: снимок это содержимое окна, и на месте «острова»
        оказывается то, что под ним лежало. Ровно то, чем водяной знак и должен
        быть: невидим на устройстве, виден на каждом скриншоте.

        Отсюда и середина полосы вместо нижней кромки. Полоса safe-area на
        аппаратах с «островом» устроена симметрично: одиннадцать точек сверху,
        сам «остров», одиннадцать точек снизу, — значит её центр это центр
        «острова», и считать геометрию выреза не нужно. Высота 16 при высоте
        «острова» около 37 и ширине 125 оставляет запас с каждой стороны: знак
        должен прятаться целиком, иначе из-под маски выглядывают верхушки букв.
        При развёрнутом «острове» (музыка, таймер, звонок) маска только больше,
        и запас растёт.

        Порог по высоте полосы отсекает всё, кроме аппаратов с «островом», и
        здесь он уже не про красоту: прятать знак не за что. У выреза (iPhone
        12–14, полоса 47) вырез уходит вверх за край окна, у полосы без выреза
        (Android, iPhone SE) прятать нечем вовсе — знак оказался бы прямо на
        часах. Там его нет.
      */}
      {insets.top >= 54 ? (
        <View pointerEvents="none" style={[styles.islandMark, { height: insets.top }]}>
          <AirChatWordmark height={16} style={styles.islandMarkGlyph} />
        </View>
      ) : null}
      {multiProfileEnabled ? (
        <ProfileSelector
          visible={profileSelOpen}
          onClose={() => setProfileSelOpen(false)}
          onIdentityUpdated={() => {
            onIdentityChange(profileManager.getActiveKeyPair());
            setActiveProfileLabel(profileManager.getActiveProfile()?.name ?? null);
          }}
          activeProfile={profileManager.getActiveProfile()}
        />
      ) : null}
      {tabsHidden ? (
        // v4.32.109 K.11f: при скрытом таббаре держим spacer с insets.bottom —
        // иначе на Vivo Android 13 композер уходит под клавиатуру (adjustResize не
        // сжимает окно на величину gesture-hint/nav области). Spacer занимает те же
        // ~96px, что и скрытый таббар, — layout стабилен независимо от состояния клавы.
        <View style={[styles.tabBar, { height: insets.bottom }]} />
      ) : (
      <View
        style={[styles.tabBarOverlay, { paddingBottom: insets.bottom }]}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setTabBarHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
        }}
      >
        <GlassSurface style={styles.glassTabBar} intensity={46} variant="regular">
        <View style={styles.tabs}>
          <AppPressable
            style={styles.tabBtn}
            onPress={() => {
              log.info('ui_tab_press', { to: 'feed', from: tab, ts: Date.now() });
              recordUserActivity();
              scheduleTab('feed');
            }}
            testID="tab_feed"
          >
            <TabGlyph
              active={tab === 'feed'}
              name="newspaper"
              inactiveName="newspaper-outline"
              color={tabColor(tab === 'feed')}
            />
            <Text style={tab === 'feed' ? styles.tabActive : styles.tabText}>Новости</Text>
          </AppPressable>
          <AppPressable
            style={styles.tabBtn}
            onPress={() => {
              log.info('ui_tab_press', { to: 'chat', from: tab, ts: Date.now() });
              recordUserActivity();
              // v4.32.228 (BUG-07): если уже на табе «Чаты» — повторный тап
              // возвращает из открытого диалога к списку чатов (pop-to-root).
              if (tab === 'chat') { setPeerJump(null); setChatPopToken((t) => t + 1); }
              scheduleTab('chat');
            }}
            testID="tab_chat"
          >
            <TabGlyph
              active={tab === 'chat'}
              name="chatbubbles"
              inactiveName="chatbubbles-outline"
              color={tabColor(tab === 'chat')}
            >
              {chatUnread > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {chatUnread > 99 ? '99+' : String(chatUnread)}
                  </Text>
                </View>
              ) : null}
            </TabGlyph>
            <Text style={tab === 'chat' ? styles.tabActive : styles.tabText}>Чаты</Text>
          </AppPressable>
          <AppPressable
            style={styles.tabBtn}
            onPress={() => {
              log.info('ui_tab_press', { to: 'groups', from: tab, ts: Date.now() });
              recordUserActivity();
              scheduleTab('groups');
            }}
            testID="tab_groups"
          >
            <TabGlyph
              active={tab === 'groups'}
              name="people"
              inactiveName="people-outline"
              color={tabColor(tab === 'groups')}
            >
              {groupUnread > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {groupUnread > 99 ? '99+' : String(groupUnread)}
                  </Text>
                </View>
              ) : null}
            </TabGlyph>
            <Text style={tab === 'groups' ? styles.tabActive : styles.tabText}>Группы</Text>
          </AppPressable>
          <AppPressable
            style={styles.tabBtn}
            onPress={() => {
              log.info('ui_tab_press', { to: 'profile', from: tab, ts: Date.now() });
              recordUserActivity();
              scheduleTab('profile');
            }}
            testID="tab_profile"
          >
            <TabGlyph
              active={tab === 'profile'}
              name="person"
              inactiveName="person-outline"
              color={tabColor(tab === 'profile')}
            />
            <Text style={tab === 'profile' ? styles.tabActive : styles.tabText}>Профиль</Text>
          </AppPressable>
          <AppPressable
            style={styles.tabBtn}
            onPress={() => {
              log.info('ui_tab_press', { to: 'settings', from: tab, ts: Date.now() });
              recordUserActivity();
              scheduleTab('settings');
            }}
            testID="tab_settings"
          >
            <TabGlyph
              active={tab === 'settings'}
              name="settings"
              inactiveName="settings-outline"
              color={tabColor(tab === 'settings')}
            />
            <Text style={tab === 'settings' ? styles.tabActive : styles.tabText}>Ещё</Text>
          </AppPressable>
        </View>
        <View style={styles.userHintRow}>
          {/* v4.32.74: показываем имя АКТИВНОГО профиля (меняется при switchProfile
              через identity-effect → setActiveProfileLabel). До того как profileManager
              инициализирован — показываем username из route.params (введённый при
              регистрации). Это чинит баг: после смены аккаунта под табами оставалось
              старое имя "anna" из регистрации, независимо от выбранного профиля. */}
          <Text style={styles.userHint} numberOfLines={1}>{activeProfileLabel ?? username}</Text>
          {multiProfileEnabled ? (
            <AppPressable
              onPress={() => setProfileSelOpen(true)}
              hitSlop={10}
              style={styles.profileSwitchBtn}
              accessibilityLabel="Сменить аккаунт"
            >
              <Ionicons name="swap-horizontal-outline" size={14} color={colors.textMuted} />
              <Text style={styles.profileSwitchHint}>Сменить</Text>
            </AppPressable>
          ) : null}
        </View>
        </GlassSurface>
      </View>
      )}
      {/* In-app notification banner */}
      {inAppBanner ? (
        <Animated.View
          style={[
            styles.inAppBanner,
            { transform: [{ translateY: bannerAnim }] },
          ]}
        >
          <AppPressable
            style={styles.inAppBannerInner}
            onPress={() => {
              if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
              Animated.timing(bannerAnim, { toValue: -80, duration: 200, useNativeDriver: true }).start(() => setInAppBanner(null));
              if (inAppBanner.feed) {
                setTab('feed');
              } else if (inAppBanner.groupId) {
                setGroupJump({ groupId: inAppBanner.groupId, token: Date.now() });
                mountTab('groups');
                setTab('groups');
              } else {
                setPeerJump({ peer: inAppBanner.peerPubB64, token: Date.now() });
                mountTab('chat');
                setTab('chat');
              }
            }}
          >
            <Ionicons name={inAppBanner.feed ? 'newspaper' : 'chatbubble'} size={18} color={toastSurface.ink.text} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.inAppBannerName} numberOfLines={1}>{inAppBanner.name}</Text>
              <Text style={styles.inAppBannerPreview} numberOfLines={1}>{inAppBanner.preview}</Text>
            </View>
            <AppPressable
              hitSlop={10}
              onPress={() => {
                if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
                Animated.timing(bannerAnim, { toValue: -80, duration: 200, useNativeDriver: true }).start(() => setInAppBanner(null));
              }}
            >
              <Ionicons name="close" size={16} color={toastSurface.ink.secondary} />
            </AppPressable>
          </AppPressable>
        </Animated.View>
      ) : null}
    </SwipeBackHost>
    </TabBarInsetProvider>
    </TabRefProvider>
  );
}

function MainScreen({
  route,
  navigation,
  pair,
  multiProfileEnabled,
  onIdentityChange,
  onWalletLogout,
}: NativeStackScreenProps<RootStackParamList, 'Main'> & {
  pair: KeyPairBytes;
  multiProfileEnabled: boolean;
  onIdentityChange: (kp: KeyPairBytes) => void;
  onWalletLogout: () => Promise<void>;
}): React.ReactElement {
  const did = publicKeyToDidKey(pair.publicKey);
  useEffect(() => {
    log.debug('[BOOT] MainScreen mounted → auto_test_identity next');
    const peerB64 = Buffer.from(pair.publicKey).toString('base64');
    log.info('auto_test_identity', { did, peerB64 });
    const path = `${FileSystem.cacheDirectory ?? ''}adb_test_identity_did.txt`;
    void FileSystem.writeAsStringAsync(path, did, {
      encoding: FileSystem.EncodingType.UTF8,
    }).catch(() => {
      /* adb run-as чтение на устройствах без ReactNativeJS в logcat */
    });
  }, [did, pair]);
  return (
    <MainTabs
      key={did}
      pair={pair}
      username={route.params.username}
      did={did}
      multiProfileEnabled={multiProfileEnabled}
      onIdentityChange={onIdentityChange}
      onWalletLogout={onWalletLogout}
      onDisplayNameChanged={(name) => {
        navigation.setParams({ username: name });
      }}
    />
  );
}

/**
 * Экран ошибки запуска.
 *
 * Вынесен в компонент по той же причине, что и `RootNavigator` с `AppShell`:
 * `App` сам рендерит `ThemeProvider`, поэтому его собственный render провайдеру
 * не подписан — `useColors()` прямо в `App` вернул бы дефолт контекста и не
 * обновлялся бы при смене темы. Всё, чему нужна тема, живёт ниже провайдера.
 */
function BootErrorView({ message }: { message: string }): React.ReactElement {
  const styles = useThemedStyles((c) => ({
    center: { flex: 1, justifyContent: 'center' as const, alignItems: 'center' as const, backgroundColor: c.background },
    title: { color: c.error, fontSize: 18, fontWeight: '700' as const, marginBottom: 8 },
    body: { color: c.textSecondary, textAlign: 'center' as const, paddingHorizontal: 24 },
  }));
  return (
    <SafeScreen edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.center} testID="boot_error">
        <Text style={styles.title}>Ошибка запуска</Text>
        <Text style={styles.body}>{message}</Text>
      </View>
    </SafeScreen>
  );
}

/** Стек навигации с темой, собранной из текущей палитры. */
function RootNavigator({
  pair,
  savedSession,
  multiProfileEnabled,
  onIdentityChange,
  onWalletLogout,
}: {
  pair: KeyPairBytes;
  savedSession: { username: string; did: string } | null;
  multiProfileEnabled: boolean;
  onIdentityChange: (kp: KeyPairBytes) => void;
  onWalletLogout: () => Promise<void>;
}): React.ReactElement {
  const colors = useColors();
  const { scheme } = useTheme();
  const navTheme = useMemo(() => buildNavTheme(colors, scheme), [colors, scheme]);
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.text,
      contentStyle: { backgroundColor: colors.background },
    }),
    [colors]
  );
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        initialRouteName={savedSession ? 'Main' : 'Login'}
        screenOptions={screenOptions}
      >
        <Stack.Screen name="Login" options={{ title: 'AirChat' }}>
          {(props) => (
            <LoginScreen
              pair={pair}
              onDone={(username, did) => {
                props.navigation.replace('Main', { username, did });
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="Main"
          options={{ headerShown: false }}
          initialParams={
            savedSession ? { username: savedSession.username, did: savedSession.did } : undefined
          }
        >
          {(props) => (
            <MainScreen
              {...props}
              pair={pair}
              multiProfileEnabled={multiProfileEnabled}
              onIdentityChange={onIdentityChange}
              onWalletLogout={onWalletLogout}
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

/**
 * Корневой контейнер под провайдером темы.
 *
 * Здесь же живёт системный фон окна: `SystemUI.setBackgroundColorAsync`
 * закрашивает то, что видно ЗА деревом React (over-scroll, кадр между сменой
 * экранов, полоса под клавиатурой). Раньше вызывался один раз с тёмным
 * литералом — в светлой теме из-под белого интерфейса проглядывал тёмно-синий.
 */
function AppShell({
  vpnStatus,
  onVpnRetry,
  children,
}: {
  vpnStatus: AirChatVpnUiStatus;
  onVpnRetry: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const colors = useColors();
  const { scheme } = useTheme();
  const styles = useThemedStyles((c) => ({ root: { flex: 1, backgroundColor: c.background } }));
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);
  return (
    <View style={styles.root}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {Platform.OS === 'android' ? (
        <VpnStatusBanner status={vpnStatus} onRetry={onVpnRetry} />
      ) : null}
      {/* v4.32.300: выше очереди отправки — «место кончилось» объясняет и её
          длину тоже: на переполненном диске в неё не попадает ничего. */}
      <StoragePressureBanner />
      <OfflineStatus />
      {children}
    </View>
  );
}

export default function App(): React.ReactElement {
  const didLogFirstRender = useRef(false);
  if (!didLogFirstRender.current) {
    didLogFirstRender.current = true;
    log.debug('[App] Component rendering');
  }

  /** Инкремент после `performLocalWalletWipe` — повторный проход boot без перезапуска процесса. */
  const [walletBootNonce, setWalletBootNonce] = useState(0);

  useEffect(() => {
    log.debug('[App] useEffect mounted');
    log.info('app_js_mounted', {});
  }, []);

  useEffect(() => {
    return subscribeChatWrites(() => scheduleDialogBackupPersist());
  }, []);

  const [gate, setGate] = useState<Gate>('boot');
  const [pair, setPair] = useState<KeyPairBytes | null>(null);
  const [multiProfileEnabled, setMultiProfileEnabled] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  /** undefined = ещё читаем KV; null = вход не завершён; объект = открыть Main сразу */
  const [savedSession, setSavedSession] = useState<
    { username: string; did: string } | null | undefined
  >(undefined);
  /** Сообщения на экране загрузки — без технических терминов. */
  const [loadingScreenMessage, setLoadingScreenMessage] = useState('Подготовка приложения…');
  const [vpnStatus, setVpnStatus] = useState<AirChatVpnUiStatus>('off');
  /** Пароль приложения: проверка после загрузки сессии и до навигации. */
  const [passwordGateResolved, setPasswordGateResolved] = useState(false);
  const [appUnlocked, setAppUnlocked] = useState(false);
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);

  // ── Splash overlay ── @stable НЕ УДАЛЯТЬ и не переносить в другой файл ────
  // Логика скрытия — в useEffect ниже («Скрываем SplashOverlay»).
  // SplashOverlay заменяет LoadingScreen; оба экрана одновременно не должны быть видны.
  const [showSplash, setShowSplash] = useState(true);
  const splashRef             = useRef<SplashOverlayRef>(null);
  const splashHideStartedRef  = useRef(false);

  const handleVpnRetry = useCallback(async () => {
    try {
      setVpnStatus('starting');
      const cfg = await loadConfig();
      const s = await retryEmbeddedVpn(cfg);
      setVpnStatus(s === 'off' ? 'off' : s);
    } catch (e) {
      log.warn('vpn_retry_ui_failed', { err: e instanceof Error ? e.message : String(e) });
      setVpnStatus('failed');
    }
  }, []);

  /**
   * Нативная заставка нужна только до первого JS-кадра. Дальше управление
   * передаётся нашему SplashOverlay, иначе InteractionManager удерживает
   * системный splash до завершения тяжёлых фоновых задач.
   */
  useLayoutEffect(() => {
    let cancelled = false;
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const hide = () => {
      if (!cancelled) void ExpoSplashScreen.hideAsync().catch(() => {});
    };
    void (async () => {
      await nativeSplashPreventReady;
      if (cancelled) return;
      frame = requestAnimationFrame(hide);
      // На отдельных старых устройствах rAF может не прийти, но системный
      // splash всё равно не должен блокировать приложение дольше полсекунды.
      fallback = setTimeout(hide, 500);
    })();
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
    };
  }, []);

  const finishBackupWarn = useCallback(() => {
    setGate('ready');
  }, []);

  const onOnboardingComplete = useCallback(async (p: KeyPairBytes) => {
    log.debug('[BOOT] onboarding: complete callback start');
    log.info('app_onboarding_complete_start', {});
    await profileManager.init();
    log.debug('[BOOT] onboarding: ensureAfterNewWallet next');
    await profileManager.ensureAfterNewWallet();
    const kp = profileManager.isEnabled()
      ? await profileManager.applyActiveKeyPairToDevice()
      : p;
    setPair(kp);
    setMultiProfileEnabled(profileManager.isEnabled());
    const { restoreChatsAfterWalletImport } = await import('./core/security/chatRestore');
    await restoreChatsAfterWalletImport();
    log.info('app_boot_set_gate', { gate: 'ready', from: 'onboarding' });
    log.debug('[BOOT] onboarding: gate=ready');
    setGate('ready');
  }, []);

  const onWalletLogout = useCallback(async () => {
    // Unmount the account UI before closing SQLite. Feed/chat effects can still
    // issue reads while the confirmation handler awaits the wipe; keeping the
    // old tree mounted lets one of those reads reopen the database mid-reset.
    setGate('boot');
    setPair(null);
    setSavedSession(undefined);
    setMultiProfileEnabled(false);
    setAppUnlocked(false);
    setPasswordGateResolved(false);
    try {
      const { performLocalWalletWipe } = await import('./core/wallet/wipeLocalWallet');
      const wipe = await performLocalWalletWipe();
      setBootError(null);
      setWalletBootNonce((n) => n + 1);
      if (!wipe.ok) {
        // v4.32.353: сброс доходит до конца всегда, но подтвердить удаление
        // может не всегда. Экран сбросить надо в любом случае (данных на нём
        // уже нет), а вот сказать «удалено», когда часть секретов пережила
        // две попытки, нельзя: пользователь отдаёт устройство, полагаясь на
        // это сообщение.
        log.error('wallet_wipe_incomplete', { survivors: wipe.survivors, failed: wipe.failedSteps });
        Alert.alert(
          'Данные удалены не полностью',
          'Часть данных не удалось стереть — возможно, устройство было заблокировано. ' +
            'Повторите выход ещё раз. Если сообщение появится снова, удалите данные приложения в настройках Android.'
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('wallet_wipe_failed', { err: msg });
      setBootError(msg);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bootT0 = Date.now();
      try {
        setBootError(null);
        if (!cancelled) setLoadingScreenMessage('Проверяем сохранённые данные…');
        log.debug('[BOOT] init: start');
        log.debug('[App] init started');
        log.info('app_boot_start', { walletBootNonce });
        log.info('boot_trace', { step: 'init_start' });
        log.debug('[BOOT] init: loadConfig + SQLite parallel');
        log.info('boot_trace', { step: 'before_loadConfig_and_db' });
        const cfg = (
          await Promise.all([
            loadConfig(),
            withTimeout(ensureLocalStorageReadyForBoot(), 120000, 'ensureLocalStorageReadyForBoot'),
          ])
        )[0];
        void (async () => {
          if (cfg.vpn?.enabled && cfg.vpn?.autoStart) {
            setVpnStatus('starting');
            const s = await maybeStartEmbeddedVpn(cfg);
            setVpnStatus(s === 'off' ? 'off' : s);
          } else {
            setVpnStatus('off');
          }
        })();
        log.info('boot_timing_ms', { phase: 'config_and_sqlite', ms: Date.now() - bootT0 });
        log.info('boot_trace', { step: 'after_loadConfig_and_db' });
        log.debug('[BOOT] init: loadConfig + DB done');
        if (!cancelled) setLoadingScreenMessage('Загружаем ваш профиль…');
        initSentryFromEnv(cfg.sentry?.dsn);
        // v4.32.21: параллелизация двух независимых SecureStore-чтений.
        // Android Keystore внутри сериализуется, но Promise.all убирает JS-hop'ы
        // между ожиданиями (экономит 100-300мс на холодном старте).
        log.debug('[BOOT] init: isFirstLaunchDone + loadKeyPair (parallel)');
        log.info('boot_trace', { step: 'before_loadKeyPair_and_firstLaunch' });
        const [firstDone, keyRecord] = await Promise.all([
          withTimeout(isFirstLaunchDone(), BOOT_KEYSTORE_MS, 'isFirstLaunchDone'),
          withTimeout(readKeyRecord(), 120000, 'loadKeyPair'),
        ]);
        let existing = keyRecord.pair;
        log.info('boot_timing_ms', { phase: 'first_launch_and_keypair', ms: Date.now() - bootT0 });
        log.info('boot_trace', { step: 'after_loadKeyPair', hasKeys: !!existing });
        log.info('boot_trace', { step: 'after_isFirstLaunchDone', firstDone });
        log.debug('boot_load_keypair_done', { hasKeys: !!existing });
        log.debug('boot_first_launch_done', { firstDone });
        if (cancelled) return;
        log.info('app_boot_keys_checked', { firstLaunchDone: firstDone, hasExistingKeyPair: !!existing });

        // Восстановление из SecureStore: и при firstDone (обновление/сбой SQLite), и при первом запуске
        // после сохранения seed без завершённого флага (прерванный онбординг).
        if (!existing && (await withTimeout(hasStoredMnemonic(), BOOT_KEYSTORE_MS, 'hasStoredMnemonic_recover'))) {
          log.info('boot_trace', { step: 'recover_keys_from_mnemonic' });
          await withTimeout(profileManager.init(), 180000, 'profileManager.init_recover');
          try {
            if (profileManager.isEnabled()) {
              existing = await withTimeout(
                profileManager.applyActiveKeyPairToDevice(),
                180000,
                'applyActiveKeyPairToDevice_recover'
              );
            } else {
              const m = await withTimeout(getStoredMnemonic(), BOOT_KEYSTORE_MS, 'getStoredMnemonic_recover');
              if (m?.trim()) {
                const pair = deriveKeyPairFromMnemonic(m);
                await withTimeout(persistKeyPair(pair), 120000, 'persistKeyPair_recover');
                existing = pair;
              }
            }
          } catch (recErr) {
            log.warn('boot_mnemonic_key_recover_failed', {
              err: recErr instanceof Error ? recErr.message : String(recErr),
            });
          }
        }

        // v4.32.547: «ключ есть, но не читается» больше не считается «ключей
        // нет». Раньше эта развилка вела к ensureKeyPair, а тот заводил новую
        // личность поверх старой — адрес человека терялся навсегда. Обычная
        // причина поправима сама: Android Keystore молчит, пока телефон не
        // разблокировали после перезагрузки.
        if (!existing && keyRecord.state === 'unreadable') {
          log.error('app_boot_key_store_unreadable', { firstLaunchDone: firstDone });
          if (!cancelled) setBootError(KEY_STORE_UNREADABLE_TEXT);
          return;
        }
        if (!existing && firstDone && (await withTimeout(hasStoredMnemonic(), BOOT_KEYSTORE_MS, 'hasStoredMnemonic_stuck'))) {
          log.error('app_boot_recover_failed_keys_missing', {});
          if (!cancelled) {
            setBootError(
              'Не удалось восстановить ключи из сохранённых секретных слов. Перезапустите приложение или восстановите доступ из резервной копии в настройках.'
            );
          }
          return;
        }
        if (cancelled) return;

        if (!firstDone) {
          const hasMn = await withTimeout(hasStoredMnemonic(), BOOT_KEYSTORE_MS, 'hasStoredMnemonic_firstLaunch');
          const seedShown = hasMn
            ? await withTimeout(hasSeedShown(), BOOT_KEYSTORE_MS, 'hasSeedShown_firstLaunch')
            : true;
          if (existing && seedShown) {
            log.debug('[BOOT] init: first launch + existing keys + seedShown → setFirstLaunchDone');
            await setFirstLaunchDone();
          } else {
            // Если seed ещё не подтверждён — возвращаем в онбординг (он покажет сидку снова из SecureStore).
            log.info('app_boot_set_gate', { gate: 'onboarding', reason: existing ? 'seed_not_confirmed' : 'no_keys' });
            setGate('onboarding');
            log.debug('[BOOT] init: gate=onboarding — stop boot chain');
            log.debug('[App] init paused for onboarding');
            return;
          }
        }

        // v4.32.227 (PERF #29): hasStoredMnemonic() reads device-level SecureStore
        // keys (MNEMONIC_*), independent of the active profile, and on these
        // devices each Keystore read stalls ~30s. It used to run AFTER
        // profileManager.init() (also ~30s) — two serial 30s stalls = the bulk of
        // the 64s cold boot. Kick it off NOW so it runs concurrently with init;
        // we await the result only when the backup gate needs it. Graceful on
        // timeout/error → false (shows the backup-warn gate rather than crashing
        // boot, the safe default).
        const hasMnPromise: Promise<boolean> = withTimeout(hasStoredMnemonic(), BOOT_KEYSTORE_MS, 'hasStoredMnemonic').catch(() => false);

        log.debug('[BOOT] init: await profileManager.init()');
        log.info('boot_trace', { step: 'before_profileManager_init' });
        if (!cancelled) setLoadingScreenMessage('Настраиваем безопасное соединение…');
        await withTimeout(profileManager.init(), 180000, 'profileManager.init');
        log.info('boot_trace', { step: 'after_profileManager_init', multi: profileManager.isEnabled() });
        log.debug('boot_profile_manager_init', { enabled: profileManager.isEnabled() });
        let p: KeyPairBytes;
        if (profileManager.isEnabled()) {
          log.debug('[BOOT] init: await applyActiveKeyPairToDevice()');
          log.info('boot_trace', { step: 'before_applyActiveKeyPairToDevice' });
          // Fast path: if the stored key already matches the active profile's derived key,
          // skip the SecureStore write — avoids blocking setItemAsync on devices where
          // Android Keystore write operations hang indefinitely during boot.
          const activePair = profileManager.getActiveKeyPair();
          const keysAlreadyMatch =
            existing != null &&
            existing.secretKey.length === activePair.secretKey.length &&
            existing.secretKey.every((b, i) => b === activePair.secretKey[i]);
          if (keysAlreadyMatch) {
            p = activePair;
            log.info('boot_trace', { step: 'after_applyActiveKeyPairToDevice', fastPath: true });
            log.debug('[BOOT] init: applyActiveKeyPairToDevice skipped (keys match)');
          } else {
            p = await withTimeout(profileManager.applyActiveKeyPairToDevice(), 180000, 'applyActiveKeyPairToDevice');
            log.info('boot_trace', { step: 'after_applyActiveKeyPairToDevice' });
            log.debug('[BOOT] init: applyActiveKeyPairToDevice done');
          }
        } else {
          log.debug('[BOOT] init: await ensureKeyPair()');
          log.info('boot_trace', { step: 'before_ensureKeyPair' });
          p = await withTimeout(ensureKeyPair(), 90000, 'ensureKeyPair');
          log.info('boot_trace', { step: 'after_ensureKeyPair' });
          log.debug('[BOOT] init: ensureKeyPair done');
        }
        if (cancelled) return;
        setPair(p);
        setMultiProfileEnabled(profileManager.isEnabled());
        log.debug('[BOOT] init: backup gate (sequential keystore + fast path if seed exists)');
        log.info('boot_trace', { step: 'before_mnemonic_flags' });
        if (!cancelled) setLoadingScreenMessage('Почти готово…');
        // Already in flight since before profileManager.init() — usually resolved.
        const hasMn = await hasMnPromise;
        /** При наличии seed условие !hasMn && !ack ложно — не читаем backup_ack (быстрее, нет очереди за вторым таймером). */
        let ack = true;
        if (!hasMn) {
          ack = await withTimeout(hasBackupWarnAck(), BOOT_KEYSTORE_MS, 'hasBackupWarnAck');
        }
        log.info('boot_trace', { step: 'after_mnemonic_flags', hasMn, ack });
        log.debug('boot_mnemonic_flags', { hasMn, ack });
        if (!hasMn && !ack) {
          log.info('app_boot_set_gate', { gate: 'backup_warn' });
          setGate('backup_warn');
          log.debug('[BOOT] init: gate=backup_warn');
        } else {
          log.info('app_boot_set_gate', { gate: 'ready' });
          setGate('ready');
          log.debug('[BOOT] init: gate=ready');
        }
        log.debug('[BOOT] init: completed OK');
        log.debug('[App] init completed');
        log.info('boot_timing_ms', { phase: 'boot_js_ready_total', ms: Date.now() - bootT0 });
        log.info('app_boot_complete', {});
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          log.info('boot_timing_ms', { phase: 'failed', ms: Date.now() - bootT0 });
          log.error('app_boot_failed', { err: msg });
          if (msg.includes('profileManager.init')) {
            profileManager.resetStalledInit();
          }
          // Отказ браузерного хранилища выглядит как строка из недр
          // expo-sqlite: верная и нечитаемая. Заменяем на диагноз, из
          // которого понятно, чинится это сертификатом или браузером.
          setBootError(diagnoseStorageFailure(msg, currentStorageEnv()) ?? msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletBootNonce]);

  useEffect(() => {
    if (gate !== 'ready' || !pair) {
      setSavedSession(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        log.debug('[BOOT] session: gate=ready → own user_username');
        // Здесь именно сырое значение: это проверка «регистрация пройдена», а
        // не показ имени. Имя из одних невидимых символов — повод почистить
        // его при показе (getOwnDisplayName), но не повод отправить человека
        // обратно на экран регистрации и потерять сессию.
        //
        // v4.32.306: через ownFieldGet, а не kvGet по общему ключу. Общая
        // запись до v4.32.288 держалась только как зеркало для отката, и
        // читать факт регистрации по ней значило спрашивать не у того профиля:
        // у второго аккаунта имя лежит под своим префиксом, а в общей записи —
        // имя первого либо ничего. Теперь зеркала нет вовсе (карточка
        // шифруется), и эта строка отправила бы на регистрацию всех.
        const uname = await ownFieldGet(OWN_DISPLAY_NAME_KEY);
        log.debug('boot_session_kv', { uname: uname ? 'set' : 'empty' });
        const did = publicKeyToDidKey(pair.publicKey);
        if (cancelled) return;
        if (uname?.trim()) {
          log.debug('[BOOT] session: savedSession → Main (has username)');
          // Показываем имя активного профиля, а не ту сырую строку, по которой
          // только что проверили факт регистрации: общая запись принадлежит
          // первому профилю, и под таб-баром у второго мелькало бы чужое имя.
          const shown = (await getOwnDisplayName()) ?? stripOwnDisplayName(uname);
          if (cancelled) return;
          setSavedSession({ username: shown || uname.trim(), did });
        } else {
          log.debug('[BOOT] session: savedSession null → Login');
          setSavedSession(null);
        }
      } catch (e) {
        log.error('boot_session_kv_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
        if (!cancelled) setSavedSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, pair]);

  useEffect(() => {
    if (gate !== 'ready' || !pair || savedSession === undefined) {
      setPasswordGateResolved(false);
      setAppUnlocked(false);
      setForgotPasswordMode(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const hasPwd = await authGuard.hasPassword();
      if (cancelled) return;
      if (!hasPwd) {
        authGuard.unlockSession();
        setAppUnlocked(true);
      } else {
        authGuard.lockSession();
        setAppUnlocked(false);
      }
      setPasswordGateResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, pair, savedSession]);

  // Автоблокировка при сворачивании приложения
  useEffect(() => {
    if (!appUnlocked) return;
    const backgroundedAtRef = { ts: 0 };

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundedAtRef.ts = Date.now();
      } else if (nextState === 'active') {
        // v4.32.169: sweep expired mute entries on every foreground so stale
        // `mute:*:*` kv rows don't accumulate indefinitely.
        void (async () => {
          try {
            const { sweepExpiredMutes } = await import('./core/notifications/muteStore');
            await sweepExpiredMutes();
          } catch { /* ignore */ }
        })();
      }
      if (nextState === 'active' && backgroundedAtRef.ts > 0) {
        // v4.32.248: время ухода в фон снимается ЗДЕСЬ, до чтения настроек.
        // Раньше `elapsed` считался внутри асинхронной части, а обнуление
        // стояло сразу за её запуском — то есть к моменту подсчёта в ref уже
        // лежал ноль, и elapsed равнялся текущему времени эпохи. Любая задержка
        // оказывалась пройденной, и приложение запиралось мгновенно, что бы
        // человек ни выбрал: «1 мин», «5 мин», «30 мин» работали как «Сразу».
        const wentBackgroundAt = backgroundedAtRef.ts;
        backgroundedAtRef.ts = 0;
        void (async () => {
          const lockEnabled = (await kvGet('auto_lock_on_exit')) === 'true';
          if (!lockEnabled) return;
          const hasPwd = await authGuard.hasPassword();
          if (!hasPwd) return;
          const delayMs = parseInt((await kvGet('auto_lock_delay_ms')) ?? '0', 10) || 0;
          const elapsed = Date.now() - wentBackgroundAt;
          if (elapsed >= delayMs) {
            authGuard.lockSession();
            setAppUnlocked(false);
          }
        })();
      }
    });
    return () => sub.remove();
  }, [appUnlocked]);

  /**
   * Long-range заглушки: после готовности ключей и gate — иначе `longrange_stubs_ready` в логах
   * ошибочно выглядит как «JS уже весь поднялся», пока boot ещё ждёт SecureStore/SQLite (типично на части OEM).
   */
  useEffect(() => {
    if (gate !== 'ready' || !pair) return;
    log.debug('[AirChat] starting longrange after gate ready');
    void initLongRangeTransport();
    // v4.32.501: смена личности и выход обязаны разобрать ретрансляцию.
    // Раньше её держал модульный флаг, который никогда не сбрасывался: после
    // выхода long-range оставался поднятым на ключах прежнего аккаунта, а
    // повторный подъём — уже на текущем — молча не происходил. Повторный
    // вызов подъёма при живом транспорте ничего не делает, так что защита
    // от двойного старта переехала внутрь модуля.
    return () => {
      void shutdownLongRangeTransport();
    };
  }, [gate, pair]);

  /** Пустая БД после восстановления ключей без онбординга — подтянуть локальный файл резервной копии. */
  useEffect(() => {
    if (gate !== 'ready' || !pair) return;
    let cancelled = false;
    void (async () => {
      const { tryRestoreDialogBackupFromFile } = await import('./core/storage/dialogBackup');
      const n = await tryRestoreDialogBackupFromFile();
      if (!cancelled && n > 0) {
        log.info('app_boot_dialog_backup_restored', { messages: n });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, pair, walletBootNonce]);

  /**
   * Образовательные модули: только `__DEV__` + env (`EXPO_PUBLIC_ENABLE_EDUCATIONAL_MODULES` или
   * `ENABLE_EDUCATIONAL_MODULES`). Сетевые демо включаются отдельно в `assets/config.json` → `educational.*.enabled`.
   */
  useEffect(() => {
    if (!__DEV__) return;
    const envOn =
      process.env.EXPO_PUBLIC_ENABLE_EDUCATIONAL_MODULES === 'true' ||
      process.env.ENABLE_EDUCATIONAL_MODULES === 'true';
    if (!envOn) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await loadConfig();
        if (cancelled) return;
        const mod = cfg.educational?.experimentalModules;
        const router = new EducationalCommunicationRouter({
          enableDomainStudy: mod?.domainFrontingStudy?.enabled ?? false,
          enableDNSStudy: mod?.dnsStudy?.enabled ?? false,
          enablePublicAPIs: mod?.publicAPIs?.enabled ?? false,
          vkToken: cfg.publicServices?.vkToken?.trim() || undefined,
          telegramBotToken: cfg.publicServices?.telegramBotToken?.trim() || undefined,
          yandexToken: cfg.publicServices?.yandexToken?.trim() || undefined,
          experimentalMode: true,
        });
        const results = await router.demonstrateChannels();
        log.info('educational_channels_demo', { results });
      } catch (e) {
        log.warn('educational_modules_init_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Сброс ложного «таймаута»: инициализация может занимать >30 с (SQLite, SecureStore, профили).
   * Раньше сообщение не сбрасывалось после успешного boot — экран ошибки оставался навсегда.
   */
  useEffect(() => {
    if (gate !== 'boot') {
      setBootError(null);
    }
  }, [gate]);

  /**
   * @stable  НЕ ИЗМЕНЯТЬ условие скрытия без явного запроса.
   * Скрываем SplashOverlay только когда приложение полностью готово показать
   * реальный экран — не промежуточный LoadingScreen.
   * Это устраняет «двойной сплэш»: overlay держится до конца всего boot-цикла
   * (включая проверку пароля).
   * v4.32.21: `savedSession` убран из gate-условия. Это nice-to-have значение
   * для автологина (username/did), оно резолвится параллельно с основной
   * boot-цепочкой и раньше могло задерживать скрытие сплэша на 200-500мс
   * после того как pair+gate=ready уже готовы. Теперь сплэш скрывается
   * сразу по `gate=ready + pair + passwordGateResolved`; savedSession
   * применяется в `NavigationContainer initialRouteName` при рендере,
   * который всё равно происходит под сплэшем.
   * Условие: gate=ready + pair + passwordGateResolved.
   */
  useEffect(() => {
    // v4.32.39: onboarding/backup_warn — это интерактивные экраны (ввод имени,
    // подтверждение бэкапа), сплэш должен уйти, чтобы пользователь их увидел.
    // Раньше условие было только `gate==='ready' && pair && passwordGateResolved`,
    // и после pm clear (fresh install) сплэш висел вечно, блокируя OnboardingScreen.
    if (bootError !== null) {
      if (splashHideStartedRef.current) return;
      splashHideStartedRef.current = true;
      splashRef.current?.hide(() => setShowSplash(false));
      return;
    }
    const readyToShowUI =
      gate === 'onboarding' ||
      gate === 'backup_warn' ||
      (gate === 'ready' && !!pair && passwordGateResolved);
    if (!readyToShowUI) return;
    if (splashHideStartedRef.current) return;
    splashHideStartedRef.current = true;
    splashRef.current?.hide(() => setShowSplash(false));
  }, [gate, pair, passwordGateResolved, bootError]);

  /**
   * Подсказка только при реально зависшем запуске (нет Metro / JS не поднялся).
   * 28 с было мало для реальных устройств; отдельные шаги boot ждут до 120 с.
   */
  useEffect(() => {
    if (gate !== 'boot') return;
    const ms = typeof __DEV__ !== 'undefined' && __DEV__ ? 150000 : 240000;
    const t = setTimeout(() => {
      setBootError((prev) => {
        if (prev) return prev;
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          return 'Долгая инициализация. Запустите Metro (npm run android). Для эмулятора: adb reverse tcp:8081 tcp:8081 и expo start с --localhost.';
        }
        return 'Запуск занимает больше обычного. Подождите ещё минуту или проверьте, что приложение не ограничено в фоне. Если окно не исчезает — переустановите приложение или очистите данные AirChat в настройках Android.';
      });
    }, ms);
    return () => clearTimeout(t);
  }, [gate]);

  useEffect(() => {
    log.debug('boot_gate_pair_snapshot', { gate, hasPair: !!pair });
  }, [gate, pair]);

  let body: React.ReactElement;
  if (bootError) {
    body = <BootErrorView message={bootError} />;
  } else if (gate === 'onboarding') {
    body = <OnboardingScreen onComplete={onOnboardingComplete} />;
  } else if (gate === 'backup_warn' && pair) {
    body = <BackupWarningScreen onContinue={finishBackupWarn} />;
  } else if (
    gate === 'boot' ||
    !pair ||
    gate !== 'ready' ||
    (gate === 'ready' && pair && savedSession === undefined) ||
    (gate === 'ready' && pair && savedSession !== undefined && !passwordGateResolved)
  ) {
    /** Один экземпляр LoadingScreen: точки крутятся непрерывно до конца загрузки, без сброса при смене текста/этапа. */
    const loadingMessage =
      gate === 'ready' && pair && (savedSession === undefined || !passwordGateResolved)
        ? 'Завершаем вход…'
        : loadingScreenMessage;
    body = (
      <SafeScreen edges={['top', 'bottom', 'left', 'right']}>
        <LoadingScreen message={loadingMessage} testID="boot_loading" />
      </SafeScreen>
    );
  } else if (gate === 'ready' && pair && passwordGateResolved && !appUnlocked) {
    body = forgotPasswordMode ? (
      <ForgotPasswordScreen
        onSuccess={() => {
          setAppUnlocked(true);
          setForgotPasswordMode(false);
        }}
        onCancel={() => setForgotPasswordMode(false)}
      />
    ) : (
      <PasswordScreen
        onSuccess={() => setAppUnlocked(true)}
        onForgot={() => setForgotPasswordMode(true)}
      />
    );
  } else {
    body = (
      <RootNavigator
        pair={pair}
        savedSession={savedSession ?? null}
        multiProfileEnabled={multiProfileEnabled}
        onIdentityChange={setPair}
        onWalletLogout={onWalletLogout}
      />
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <AppShell vpnStatus={vpnStatus} onVpnRetry={handleVpnRetry}>
          {body}
          <CallOverlay />
          {/* Анимированная заставка — поверх всего, скрывается когда app готов */}
          {showSplash ? (
            <SplashOverlay
              ref={splashRef}
              message={
                gate === 'ready' && pair && (savedSession === undefined || !passwordGateResolved)
                  ? 'Завершаем вход…'
                  : loadingScreenMessage
              }
            />
          ) : null}
        </AppShell>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
