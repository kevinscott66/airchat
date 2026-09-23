/**
 * v4.32.67: flush-on-reconnect watcher.
 *
 * Слушает `Network.addNetworkStateListener` — при любом переходе «offline → online»
 * (включение Wi-Fi, возврат в зону сотовой связи) прогоняет очереди доставки:
 *   - feed publish queue (все неотправленные посты по всем контактам);
 *   - DM outbox (через runSyncIfOnline).
 *
 * Это парный к lanCoordinator.onPeerDiscovered механизм, но для случаев когда
 * оффлайн был НА НАШЕЙ стороне (свой Wi-Fi упал → вернулся), а не на стороне
 * контакта. Например: юзер опубликовал пост в метро без интернета → вышел на
 * улицу → Wi-Fi/4G поднялся → post летит всем онлайн-контактам через multiTransport.
 *
 * Debounce 2с против всплесков connectivity-events (iOS иногда шлёт 3-4 события
 * подряд при переключении сетей).
 *
 * v4.32.723: здесь же замечается смена ПУТИ трафика, а не только его пропажа.
 *
 * Переезд с Wi-Fi на мобильный интернет и обратно, включение или выключение
 * постороннего VPN — для очередей доставки это почти ничего не значит (связь
 * была и осталась), а для туннеля OpenFlux значит всё: его ядро держит
 * переписку с документом поверх старого маршрута, и после переключения эта
 * переписка мертва. Заводить ради этого второй такой же наблюдатель незачем —
 * события те же самые, и две копии защиты от всплесков разъехались бы на
 * первой же правке. Поэтому путь отдаётся отдельным каналом
 * (`addNetworkPathListener`), а что с ним делать — дело подписчика.
 */
import * as Network from 'expo-network';
import type { KeyPairBytes } from '../crypto/keyManager';
import { log } from '../logger';
import { flushFeedPublishQueue, resumeCommentOutbox } from '../social/feedService';
import { runSyncIfOnline } from '../storage/sync';
import { createListenerSet } from './listenerSet';

const FLUSH_DEBOUNCE_MS = 2_000;

/**
 * Пауза перед сообщением о смене пути — дольше, чем перед прогоном очередей.
 *
 * Очередь можно прогнать и впустую, а по этому сигналу поднимают заново сетевое
 * ядро: это секунды работы и разрыв всех соединений приложения. Новая сеть в
 * первые мгновения ещё не раздала ни адрес, ни маршрут по умолчанию — ядро,
 * поднятое в эту секунду, упало бы ровно там, где мы его чиним.
 */
const PATH_DEBOUNCE_MS = 4_000;

/** Что именно случилось с путём трафика. */
export type NetworkPathChange = {
  /**
   * `reconnect` — связь пропадала и вернулась; `type` — не пропадала, но
   * сменился вид подключения (Wi-Fi ↔ LTE, включили или выключили чужой VPN).
   */
  reason: 'reconnect' | 'type';
  /** Вид подключения до и после: `WIFI`, `CELLULAR`, `VPN`… `null` — неизвестен. */
  from: string | null;
  to: string | null;
};

let subscription: { remove: () => void } | null = null;
let lastConnected: boolean | null = null;
let lastType: string | null = null;
/**
 * Успело ли первое настоящее событие сети опередить чтение начального
 * состояния. См. `startNetworkReconnectWatcher`: начальное состояние читается
 * асинхронно, и его запись обязана уступить дорогу тому, что пришло позже.
 */
let stateSeeded = false;
/**
 * Номер запуска. Нужен ровно затем, чтобы чтение начального состояния,
 * оставшееся в полёте от прошлого запуска, не приземлилось в следующий.
 */
let watcherRun = 0;
let pairRef: KeyPairBytes | null = null;
let onReconnectRef: ((pair: KeyPairBytes) => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pathTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPath: NetworkPathChange | null = null;
const pathListeners = createListenerSet<NetworkPathChange>('net_path_listener_failed');

/**
 * Подписаться на смену пути трафика. Возвращает отписку.
 *
 * Подписки живут отдельно от самого наблюдателя и переживают его остановку:
 * иначе смена аккаунта — наблюдатель снимается и поднимается заново — тихо
 * отключала бы восстановление туннеля до перезапуска приложения.
 */
export function addNetworkPathListener(fn: (change: NetworkPathChange) => void): () => void {
  return pathListeners.add(fn);
}

function schedulePathChange(change: NetworkPathChange): void {
  // Из пачки событий доживает последнее: промежуточные состояния («связи нет»
  // между двумя сетями) чинить незачем — чинить надо то, куда приехали.
  pendingPath = change;
  if (pathTimer) clearTimeout(pathTimer);
  pathTimer = setTimeout(() => {
    pathTimer = null;
    const settled = pendingPath;
    pendingPath = null;
    if (!settled) return;
    log.info('net_path_changed', settled);
    pathListeners.notify(settled);
  }, PATH_DEBOUNCE_MS);
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const pair = pairRef;
    if (!pair) return;
    log.info('net_reconnect_flush_start');
    void flushFeedPublishQueue(pair).catch((e) => {
      log.warn('net_reconnect_feed_flush_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    });
    // v4.32.164 P1#2: дренируем outbox comment/delete envelopes при появлении сети.
    try { resumeCommentOutbox(pair); } catch (e) {
      log.warn('net_reconnect_comment_outbox_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    void runSyncIfOnline().catch((e) => {
      log.warn('net_reconnect_outbox_flush_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    });
    try {
      onReconnectRef?.(pair);
    } catch (e) {
      log.warn('net_reconnect_sync_callback_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }, FLUSH_DEBOUNCE_MS);
}

export function startNetworkReconnectWatcher(
  pair: KeyPairBytes,
  onReconnect?: (pair: KeyPairBytes) => void,
): void {
  pairRef = pair;
  onReconnectRef = onReconnect ?? null;
  if (subscription) return; // уже запущен

  // Начальное состояние, чтобы первому событию было с чем сравниться.
  //
  // Читается оно асинхронно, а подписка ставится синхронно строчкой ниже —
  // то есть событие сети может прийти раньше, чем ответ на этот запрос. Тогда
  // записывать ответ уже нельзя: он описывает сеть на момент запуска
  // приложения, а обработчик к тому времени видел более свежую. Затерев его,
  // мы сравнивали бы следующее событие с устаревшим «до» — и либо пропустили
  // бы смену сети (туннель не переподняли бы), либо объявили бы лишнюю
  // (ядро и все соединения перезапустились бы впустую). Окно узкое, но
  // приходится ровно на запуск, когда сеть как раз и дёргается.
  const run = ++watcherRun;
  stateSeeded = false;
  void Network.getNetworkStateAsync()
    .then((st) => {
      if (run !== watcherRun || stateSeeded) return;
      stateSeeded = true;
      lastConnected = !!st.isConnected;
      lastType = st.type ? String(st.type) : null;
    })
    .catch(() => {
      if (run !== watcherRun || stateSeeded) return;
      stateSeeded = true;
      lastConnected = null;
      lastType = null;
    });

  try {
    subscription = Network.addNetworkStateListener((ev) => {
      stateSeeded = true;
      const now = !!ev.isConnected;
      const prev = lastConnected;
      const type = ev.type ? String(ev.type) : null;
      const prevType = lastType;
      lastConnected = now;
      lastType = type;
      // Только переход false/null → true считаем «reconnect».
      if (now && prev !== true) {
        log.info('net_reconnect_detected', { prev, now });
        scheduleFlush();
      }
      // Путь трафика. Сообщаем только про сеть, в которой уже есть связь:
      // о том, что её нет, чинить туннель бессмысленно — поднимать его некуда,
      // и следующее событие всё равно придёт.
      if (!now) return;
      if (prev !== true) {
        schedulePathChange({ reason: 'reconnect', from: prevType, to: type });
      } else if (prevType !== null && type !== null && type !== prevType) {
        // Связь не пропадала, но приложение поехало по другому проводу: Wi-Fi
        // сменился на мобильный, или поверх всего встал чужой VPN. Старые
        // соединения при этом не рвутся сразу, и без этой ветки переключение
        // осталось бы незамеченным.
        schedulePathChange({ reason: 'type', from: prevType, to: type });
      }
    });
    log.info('net_reconnect_watcher_started');
  } catch (e) {
    log.warn('net_reconnect_watcher_start_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    subscription = null;
  }
}

export function stopNetworkReconnectWatcher(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Отложенное сообщение о смене пути снимается вместе с наблюдателем: срабатывать
  // ему уже не по чему — состояние сети обнулено, и сравнивать «до» будет не с чем.
  if (pathTimer) {
    clearTimeout(pathTimer);
    pathTimer = null;
  }
  pendingPath = null;
  try {
    subscription?.remove();
  } catch {
    /* ignore */
  }
  subscription = null;
  pairRef = null;
  onReconnectRef = null;
  lastConnected = null;
  lastType = null;
  // Следующий запуск прочитает состояние заново; заодно этот номер отсекает
  // ответ на чтение, оставшееся в полёте от нынешнего.
  watcherRun += 1;
  stateSeeded = false;
  log.info('net_reconnect_watcher_stopped');
}
