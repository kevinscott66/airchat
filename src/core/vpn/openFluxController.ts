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
import { Platform } from 'react-native';
import AirChatOpenFlux from 'airchat-openflux';
import type { AppConfig } from '../config';
import { log } from '../logger';

export type OpenFluxUiStatus =
  /** Выключен пользователем или конфигом. */
  | 'off'
  /** Ядро поднимается: документ отвечает не мгновенно. */
  | 'starting'
  /** Канал есть, трафик идёт через него. */
  | 'on'
  /** Платформы с ядром нет (iOS, web) или нативная часть не собрана. */
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
  // Ядро есть только под Android. На iOS и web это не ошибка, а отсутствие
  // реализации, и говорить о ней надо именно так.
  if (Platform.OS !== 'android') return 'unsupported';
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
    return 'on';
  } catch (e) {
    // Текст ядра (документ недоступен, старый редактор выключен, нет прав на
    // запись) уносим в журнал целиком: без него причина неотличима от «сеть».
    log.warn('openflux_start_failed', { err: e instanceof Error ? e.message : String(e) });
    return 'failed';
  }
}

export async function stopOpenFlux(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const mod = AirChatOpenFlux;
  if (!mod) return;
  try {
    await mod.stop();
    log.info('openflux_stopped');
  } catch (e) {
    log.warn('openflux_stop_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function getOpenFluxRunning(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = AirChatOpenFlux;
  if (!mod) return false;
  try {
    return await mod.isRunning();
  } catch {
    return false;
  }
}

/** Адрес локального SOCKS5, пока туннель поднят. Для экрана диагностики. */
export async function getOpenFluxSocksAddr(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const mod = AirChatOpenFlux;
  if (!mod) return null;
  try {
    return await mod.socksAddr();
  } catch {
    return null;
  }
}

/**
 * Опустить и поднять заново, с повторами (кнопка «Повторить» и включение
 * вручную). Документ Яндекса отвечает не всегда с первого раза, а разовая
 * неудача здесь стоит пользователю всей связи, поэтому повтор — не роскошь.
 */
export async function retryOpenFlux(cfg: AppConfig): Promise<OpenFluxUiStatus> {
  const o = cfg.openflux;
  if (!o?.enabled) return 'off';
  await stopOpenFlux();
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
