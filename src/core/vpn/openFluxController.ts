/**
 * Туннель OpenFlux: поднять, опустить, рассказать о состоянии (v4.32.723).
 *
 * Зачем он нужен. В сети с белым списком оператор пропускает соединения
 * только к нескольким разрешённым адресам, и прямое подключение к relay
 * (ntfy) просто не открывается — приложение молчит, хотя интернет «есть».
 * OpenFlux в такой сети ходит к Яндексу, который в белый список входит, и
 * несёт трафик внутри переписки с документом. Наружу приложение видит
 * обычный локальный SOCKS5, поэтому выше по стеку ничего менять не нужно.
 *
 * Состояний намеренно шесть, а не четыре. Разница между «в этой сборке
 * туннеля нет» (`unconfigured`, нет ссылки на документ) и «пробовали и не
 * вышло» (`failed`) для пользователя огромная: первое чинится пересборкой с
 * переменной, второе — сетью или документом. Слить их в одно `failed`
 * означало бы отправить человека искать поломку там, где её нет; в этом
 * репозитории такое уже ловили на облачной копии (см. config.bundledConfig).
 */
import AirChatOpenFlux from 'airchat-openflux';
import type { AppConfig } from '../config';
import { log } from '../logger';
// Модуль интерфейса в ядре — осознанно, по той же причине, что и в
// `bridge/agentBridgeCommands`: ответ на вопрос «есть ли на этой платформе
// ядро OpenFlux» в проекте должен быть один. Своя копия условия здесь
// разъехалась бы с той, по которой интерфейс решает, показывать ли настройку,
// — и ровно в тот день, когда ядро принесут под следующую платформу.
//
// Сам по себе этот ответ ничего не гарантирует — нативная часть отвечает за
// себя сама (`isSupported`), и на iOS она скажет «нет», если ядро не собрано
// или система старше iOS 17.
import { openFluxAvailable } from '../../ui/platformCapabilities';
import { openFluxErrorText } from './openFluxErrorText';

export type OpenFluxUiStatus =
  /** Выключен пользователем или конфигом. */
  | 'off'
  /** Ядро поднимается: документ отвечает не мгновенно. */
  | 'starting'
  /** Канал есть, трафик идёт через него. */
  | 'on'
  /** Ядра в этой сборке нет (web; iOS без собранного xcframework или до iOS 17). */
  | 'unsupported'
  /** Сборка без EXPO_PUBLIC_OPENFLUX_DOC_URL: вести туннель некуда. */
  | 'unconfigured'
  /** Пробовали поднять — не вышло. */
  | 'failed';

/** Куда просить ядро положить локальный SOCKS5. Порт 0 — пусть выберет сам. */
function socksAddrFor(cfg: AppConfig): string {
  const port = cfg.openflux?.localSocksPort ?? 0;
  return `127.0.0.1:${port}`;
}

/**
 * Настроен ли туннель в этой сборке: есть секция, включена, и есть ссылка.
 * Ссылку кладёт переменная сборки, поэтому «нет ссылки» — обычное состояние
 * стороннего клона репозитория, а не поломка.
 */
export function openFluxConfigured(cfg: AppConfig): boolean {
  const o = cfg.openflux;
  return !!o?.enabled && !!o.docUrl?.trim();
}

/**
 * Поднять туннель, если он включён и должен подниматься сам.
 *
 * `force` — это нажатая кнопка: она обходит только `autoStart`, но не
 * `enabled` и не отсутствие ссылки. Выключенный туннель кнопкой не
 * включается, иначе «выключить» в настройках перестало бы что-то значить.
 */
export async function maybeStartOpenFlux(
  cfg: AppConfig,
  opts?: { force?: boolean },
): Promise<OpenFluxUiStatus> {
  const o = cfg.openflux;
  if (!o?.enabled) return 'off';
  if (!opts?.force && !o.autoStart) return 'off';
  if (!o.docUrl?.trim()) {
    log.info('openflux_no_doc_url');
    return 'unconfigured';
  }
  // На web ядра нет и быть не может — это не ошибка, а отсутствие реализации,
  // и говорить о ней надо именно так.
  if (!openFluxAvailable()) return 'unsupported';
  const mod = AirChatOpenFlux;
  if (!mod) {
    log.warn('openflux_module_missing');
    return 'unsupported';
  }
  try {
    if (!(await mod.isSupported())) return 'unsupported';
  } catch {
    return 'unsupported';
  }

  try {
    const addr = await mod.start({
      transport: o.transport ?? 'yandex',
      docUrl: o.docUrl.trim(),
      socksAddr: socksAddrFor(cfg),
      dns: o.dns ?? '1.1.1.1:53',
    });
    log.info('openflux_started', { socks: addr });
    await noteHttpLayer();
    return 'on';
  } catch (e) {
    // Текст ядра (документ недоступен, старый редактор выключен, нет прав на
    // запись) уносим в журнал: без него причина неотличима от «сеть». Но без
    // адресов — ссылка на документ есть право писать в него, см.
    // openFluxErrorText.
    log.warn('openflux_start_failed', { err: openFluxErrorText(e) });
    return 'failed';
  }
}

/**
 * Довозит ли туннель HTTP-трафик приложения, или слой перехвата в этот раз мимо.
 *
 * `null` — вопрос не задавали или задавать некому (web, Android, старая iOS).
 * Это НЕ то же самое, что `false`: «не знаем» и «точно мимо» человеку означают
 * разное.
 */
let httpLayer: boolean | null = null;

/**
 * Спросить у платформы, попал ли перехват HTTP в поднятое ядро.
 *
 * Зачем это отдельным вопросом. На iOS перехват HTTP-стека React Native
 * ставится один раз за жизнь процесса и на заранее зарезервированный порт —
 * переставить его потом нельзя, RN спрашивает конфигурацию сессии ровно один
 * раз. Если к моменту старта этот порт кто-то занял, ядро поднимается на любом
 * свободном (туннель важнее второго слоя), и перехват остаётся нацелен в порт,
 * где никого нет. А поскольку у этого слоя намеренно включён failover — иначе
 * приложение с выключенным туннелем вообще не ходило бы в сеть, — запросы не
 * падают, а тихо уходят напрямую.
 *
 * Снаружи это выглядело как «Канал поднят». Человек, который включил туннель
 * ровно затем, чтобы трафик шёл не напрямую, узнать об этом мог только одним
 * способом: семь раз нажать на номер версии, включить счётчик соединений и
 * прочитать строку в инженерном разделе. То есть практически никак.
 */
async function noteHttpLayer(): Promise<void> {
  const stats = await getOpenFluxTunnelStats();
  httpLayer = stats ? stats.httpProxy : null;
  if (httpLayer === false) log.warn('openflux_http_layer_bypassed');
}

/** См. `httpLayer`. `null` — неизвестно, а не «нет». */
export function getOpenFluxHttpLayerActive(): boolean | null {
  return httpLayer;
}

/**
 * Погасить ядро. `true` — погасло, `false` — осталось поднятым (v4.32.1014).
 *
 * Прежде ответа не было вовсе: отказ ядра уходил в `log.warn`, наружу
 * возвращалось одно и то же `undefined`, и оба вызывающих — переключатель в
 * настройках и мост внешнего агента — объявляли туннель выключенным, не
 * спросив, выключился ли он.
 *
 * Отказ на `stop()` сам по себе ещё не значит «не погасло»: «ядра уже нет»
 * прилетает таким же отказом. Поэтому после отказа ядро спрашивают напрямую,
 * и только молчание или ответ «поднят» считаются неудачей — не ответило,
 * значит подтвердить остановку нечем.
 */
export async function stopOpenFlux(): Promise<boolean> {
  if (!openFluxAvailable()) {
    httpLayer = null;
    return true;
  }
  const mod = AirChatOpenFlux;
  if (!mod) {
    httpLayer = null;
    return true;
  }
  try {
    await mod.stop();
    httpLayer = null;
    log.info('openflux_stopped');
    return true;
  } catch (e) {
    try {
      if (!(await mod.isRunning())) {
        // Отказ был про то, что гасить уже нечего.
        httpLayer = null;
        log.info('openflux_stopped');
        return true;
      }
    } catch {
      // Ядро не ответило и на это: подтвердить остановку нечем.
    }
    // Слой перехвата не трогаем: он таким и остался, а `null` здесь значил бы
    // «неизвестно» про то, что как раз известно.
    log.warn('openflux_stop_failed', { err: openFluxErrorText(e) });
    return false;
  }
}

/**
 * Поднято ли ядро — с третьим ответом (v4.32.1058).
 *
 * `null` — спросить не удалось. До этой версии отказ ядра уходил в тот же
 * `false`, что и честно погашенный туннель. Раздел настроек писал «Выключен»
 * над живым каналом, а мост внешнего агента отдавал `state: 'off'` — то есть
 * неправда доезжала до машины, которая на неё действует.
 *
 * Тихий `false` остаётся там, где ядра нет по сборке или платформе: это не
 * отказ, а отсутствие туннеля. Соседи по файлу три ответа умеют давно:
 * `getOpenFluxHttpLayerActive` (`boolean | null`) и `stopOpenFlux`, который
 * с v4.32.1014 отвечает, погасло ли.
 */
export async function getOpenFluxRunning(): Promise<boolean | null> {
  if (!openFluxAvailable()) return false;
  const mod = AirChatOpenFlux;
  if (!mod) return false;
  try {
    return await mod.isRunning();
  } catch (e) {
    log.warn('openflux_running_unknown', { err: openFluxErrorText(e) });
    return null;
  }
}

/** Адрес локального SOCKS5, пока туннель поднят. Для экрана диагностики. */
export async function getOpenFluxSocksAddr(): Promise<string | null> {
  if (!openFluxAvailable()) return null;
  const mod = AirChatOpenFlux;
  if (!mod) return null;
  try {
    return await mod.socksAddr();
  } catch {
    return null;
  }
}

/**
 * Доказательство того, что трафик действительно идёт через туннель.
 *
 * Зачем это отдельно от статуса. `status === 'on'` означает ровно одно: ядро
 * поднялось и отдало адрес SOCKS5. Пойдёт ли в этот SOCKS5 хоть один байт —
 * вопрос перехвата, а перехват на iOS держится на двух слоях, про один из
 * которых (системный прокси Network.framework) нельзя сказать заранее,
 * покрывает ли он веб-сокеты. Нарисовать по «ядро поднялось» зелёную галочку
 * «работает» — значит соврать ровно в той ситуации, ради которой туннель и
 * писался.
 *
 * Поэтому счётчик берётся из самого ядра: оно печатает строку на каждое
 * принятое соединение. Ноль соединений — это честный ноль, а не «наверное,
 * работает».
 */
export type OpenFluxTunnelStats = {
  /** Включён ли подсчёт. Пока false, остальные числа ничего не значат. */
  counting: boolean;
  /** Сколько соединений ядро приняло на свой SOCKS5 с момента включения счёта. */
  connections: number;
  /** Из них не сумело довести до адресата. */
  failures: number;
  /** Последний адрес, куда шло соединение (host:port). */
  lastTarget: string | null;
  /** Когда это было, мс эпохи. */
  lastAt: number | null;
  /** Поставлен ли системный прокси процесса (iOS 17+). */
  systemProxy: boolean;
  /** Ведёт ли HTTP-стек React Native в наш SOCKS5. */
  httpProxy: boolean;
};

/** Исход включения счётчика. При отказе сказано, чей он (v4.32.1081). */
export type OpenFluxStatsStart = 'on' | 'unsupported' | 'refused';

/**
 * Включить подсчёт соединений. Обратного хода нет: в ядре отладочный флаг
 * односторонний, и выключается он только перезапуском приложения.
 *
 * v4.32.1081: исходов три, а не два. «Считать нечем» (web, Android — там
 * счётчика пока нет) и «ядро отказалось» — разные вещи: первое про сборку и
 * навсегда, второе про эту минуту и чинится повтором. Прежде оба уходили
 * наружу одним `false`, и кнопка говорила о сборке то, чего не знала.
 */
export async function enableOpenFluxTunnelStats(): Promise<OpenFluxStatsStart> {
  if (!openFluxAvailable()) return 'unsupported';
  const mod = AirChatOpenFlux;
  if (!mod?.enableTunnelStats) return 'unsupported';
  try {
    await mod.enableTunnelStats();
    log.info('openflux_stats_enabled');
    return 'on';
  } catch (e) {
    log.warn('openflux_stats_enable_failed', { err: openFluxErrorText(e) });
    return 'refused';
  }
}

/** `null` — счётчика на этой платформе нет; это не то же самое, что ноль. */
export async function getOpenFluxTunnelStats(): Promise<OpenFluxTunnelStats | null> {
  if (!openFluxAvailable()) return null;
  const mod = AirChatOpenFlux;
  if (!mod?.tunnelStats) return null;
  try {
    return await mod.tunnelStats();
  } catch {
    return null;
  }
}

/**
 * Опустить и поднять заново, с повторами (кнопка «Повторить» и включение
 * вручную). Документ Яндекса отвечает не всегда с первого раза, а разовая
 * неудача здесь стоит пользователю всей связи, поэтому повтор — не роскошь.
 */
export async function retryOpenFlux(cfg: AppConfig, session?: { renew: boolean }): Promise<OpenFluxUiStatus> {
  const o = cfg.openflux;
  if (!o?.enabled) return 'off';
  if (!o.docUrl?.trim()) return 'unconfigured';
  if (!openFluxAvailable()) return 'unsupported';
  await stopOpenFlux();
  // Only an explicit foreground action opens login. Cookies never cross this bridge.
  if (session && (o.transport ?? 'yandex') === 'yandex' && AirChatOpenFlux?.authorizeSession) {
    try {
      if (!(await AirChatOpenFlux.authorizeSession(o.docUrl.trim(), session.renew))) return 'failed';
    } catch { return 'failed'; }
  }
  const max = Math.max(1, o.startRetries ?? 3);
  const delayMs = o.retryDelayMs ?? 2000;
  let last: OpenFluxUiStatus = 'failed';
  for (let i = 0; i < max; i++) {
    last = await maybeStartOpenFlux(cfg, { force: true });
    // Повторять имеет смысл только `failed`: остальное от повтора не изменится.
    if (last !== 'failed') return last;
    if (i < max - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
