/**
 * Туннель OpenFlux переживает смену сети на телефоне (v4.32.723).
 *
 * Что ломается. Ядро туннеля держит длинную переписку с документом Яндекса
 * поверх конкретного маршрута. Человек вышел из дома — Wi-Fi сменился на LTE;
 * включил или выключил посторонний VPN — маршрут по умолчанию уехал. Ядру об
 * этом никто не сообщает: оно продолжает писать в сокеты, которых больше нет.
 * Снаружи это выглядит как «приложение перестало работать после выхода на
 * улицу», и чинится сегодня только походом в настройки и щелчком выключателя.
 * Чинить связь руками — ровно то, ради чего туннель и заводился.
 *
 * Почему мало перезапустить транспорт. Подмена маршрута действует только на
 * НОВЫЕ соединения (см. OpenFluxProxy), а сам локальный SOCKS5 ядра висит на
 * эфемерном порту: после перезапуска ядра номер другой. Значит порядок здесь
 * не произвольный, а единственно возможный — сначала поднять ядро заново,
 * получить новый адрес и перевести на него перехват (это делает нативная часть
 * внутри `start`), и только потом рвать и поднимать интернет-транспорт. В
 * обратном порядке транспорт открыл бы сокеты в порт, которого уже нет.
 *
 * Чего здесь намеренно нет — самодеятельности. Выключенный человеком туннель
 * не включается ни при какой смене сети, а если ядро не поднялось, приложение
 * остаётся с прямой связью, а не без связи вовсе: лучше без туннеля, чем без
 * переписки (тот же принцип — в OpenFluxProxy.enable).
 */
import { loadConfig } from '../config';
import { log } from '../logger';
import { restartInternetTransport } from '../transport/internet/restartInternetTransport';
import { addNetworkPathListener, type NetworkPathChange } from '../transport/networkReconnectWatcher';
import {
  getOpenFluxRunning,
  getOpenFluxSocksAddr,
  openFluxConfigured,
  retryOpenFlux,
  type OpenFluxUiStatus,
} from './openFluxController';

export type OpenFluxReviveResult =
  /** Трогать туннель не надо: выключен, не настроен, платформе нечем. */
  | 'skipped'
  /** Ядро поднято заново, транспорт переоткрыт через новый SOCKS5. */
  | 'revived'
  /** Ядро не поднялось; трафик вернули напрямую, связь есть. */
  | 'degraded'
  /** Заход уже идёт — этот учтён догоняющим кругом. */
  | 'busy';

/** Чем кончился заход: то же, что видит экран настроек. */
export type OpenFluxRevived = { status: OpenFluxUiStatus; socks: string | null };

let unsubscribe: (() => void) | null = null;
let inFlight = false;
let changedAgain = false;
const reviveListeners = new Set<(r: OpenFluxRevived) => void>();

/**
 * Узнать, что туннель переподняли под новую сеть.
 *
 * Нужно экрану настроек: он читает состояние и адрес SOCKS5 один раз, при
 * открытии. Порт у ядра эфемерный, и после переезда на мобильный интернет
 * открытый экран показывал бы номер, которого уже нет, — а рядом бодрое
 * «Работает» в тот момент, когда ядро как раз не поднялось.
 */
export function addOpenFluxReviveListener(fn: (r: OpenFluxRevived) => void): () => void {
  reviveListeners.add(fn);
  return () => {
    reviveListeners.delete(fn);
  };
}

function notifyRevived(r: OpenFluxRevived): void {
  for (const fn of Array.from(reviveListeners)) {
    try {
      fn(r);
    } catch (e) {
      log.warn('openflux_revive_listener_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * Поднять туннель заново под новую сеть.
 *
 * Возвращает, что получилось, — это нужно тестам и журналу; вызывающему коду
 * (обработчику события) решение принимать не по чему.
 */
export async function reviveOpenFluxAfterNetworkChange(): Promise<OpenFluxReviveResult> {
  // Пока идёт заход, сеть может переключиться ещё раз — в метро или в лифте это
  // обычное дело. Второй параллельный подъём ядра не ускорил бы ничего, а вот
  // подрался бы с первым за документ; поэтому новое событие не запускает заход,
  // а помечает, что после текущего нужен догоняющий.
  if (inFlight) {
    changedAgain = true;
    return 'busy';
  }
  inFlight = true;
  let result: OpenFluxReviveResult = 'skipped';
  try {
    do {
      changedAgain = false;
      result = await reviveOnce();
      // Круг повторяется ровно столько раз, сколько сеть успела смениться за
      // время подъёма. Сеть перестала дёргаться — цикл закончился сам.
    } while (changedAgain);
  } finally {
    inFlight = false;
    changedAgain = false;
  }
  return result;
}

async function reviveOnce(): Promise<OpenFluxReviveResult> {
  const cfg = await loadConfig();
  // Решение человека сильнее любой смены сети. Выключенный туннель не
  // поднимается сам, даже если приложение из-за этого молчит: иначе «выключить»
  // в настройках означало бы «выключить до следующего выхода из дома».
  if (!openFluxConfigured(cfg)) return 'skipped';
  // `autoStart: false` — это «поднимаю руками». Такой туннель восстанавливаем
  // только если на момент переключения он стоял: поднять его на смене сети
  // значило бы включить то, чего не включали.
  if (!cfg.openflux?.autoStart && !(await getOpenFluxRunning())) return 'skipped';

  const status = await retryOpenFlux(cfg);
  if (status !== 'on' && status !== 'failed') {
    // `unsupported` (web, сборка без ядра) и `off`: трогать было нечего,
    // и транспорт тоже трогать незачем — путь трафика не менялся.
    log.info('openflux_net_change_untouched', { status });
    return 'skipped';
  }

  let socks: string | null = null;
  if (status === 'on') {
    // Адрес читаем после подъёма ядра, а не до: порт эфемерный, и старый номер
    // теперь ничей. Перехват на новый уже переведён нативной частью внутри
    // `start` — здесь адрес нужен журналу и экрану настроек. В журнале по смене
    // номера видно, что ядро действительно поднялось заново, а не отрапортовало
    // «и так работаю» поверх мёртвого маршрута.
    socks = await getOpenFluxSocksAddr();
    log.info('openflux_net_change_revived', { socks });
  } else {
    // Ядро не поднялось. Туннель при этом уже опущен — `retryOpenFlux`
    // начинает со `stop`, — то есть трафик идёт напрямую. Транспорт всё равно
    // перезапускаем: его сокеты до сих пор ведут в порт, которого больше нет,
    // и без этого человек остался бы не «без туннеля», а без связи.
    log.warn('openflux_net_change_failed');
  }

  try {
    await restartInternetTransport(cfg);
  } catch (e) {
    log.warn('openflux_net_change_transport_restart_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  notifyRevived({ status, socks });
  return status === 'on' ? 'revived' : 'degraded';
}

/** Следить за сменой сети и чинить туннель. Повторный вызов ничего не меняет. */
export function startOpenFluxNetworkGuard(): void {
  if (unsubscribe) return;
  unsubscribe = addNetworkPathListener((change: NetworkPathChange) => {
    log.info('openflux_net_change_seen', change);
    void reviveOpenFluxAfterNetworkChange().catch((e) => {
      log.warn('openflux_net_change_revive_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    });
  });
  log.info('openflux_net_guard_started');
}

export function stopOpenFluxNetworkGuard(): void {
  // Заход, начатый до остановки, намеренно доводится до конца: бросить его на
  // середине — это оставить ядро опущенным, а транспорт неперезапущенным.
  unsubscribe?.();
  unsubscribe = null;
  log.info('openflux_net_guard_stopped');
}
