/**
 * Мост для внешнего агента: приём команд и ответы (v4.32.723).
 *
 * ПОЧЕМУ ТЕЛЕФОН НЕ СЛУШАЕТ ПОРТ. Два независимых довода, каждого хватило бы.
 * Телефон на мобильном интернете сидит за NAT оператора, и снаружи к нему не
 * подключиться вовсе. А открытый порт в мессенджере — это возможность для
 * любого в той же кофейне постучаться в приложение, где лежит переписка. Мост
 * вместо этого подписывается на отдельную тему того же ретранслятора, который
 * уже возит сообщения: наружу торчит только исходящее соединение.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СОКЕТ, А НЕ ОБЩИЙ С ПЕРЕПИСКОЙ. Соблазн был: соединение
 * стоит батареи, и второе — это второй реконнект, второй keepalive, вторая
 * причина проснуться. Решило три вещи.
 *
 *  1. `internetTransport` помечен «@stable v4.32.70 — НЕ ИЗМЕНЯТЬ без явного
 *     запроса» и возит 100% онлайновой доставки без запасного пути. Ошибка в
 *     нём стоит не «мост не ответил», а «сообщения не доходят».
 *  2. Подписки хотят разного `?since=`. Переписке нужна вся глубина хранения:
 *     человек, закрывший приложение на ночь, наутро должен получить всё
 *     накопленное. Мосту нужна противоположность — окно в пять минут, потому
 *     что исполнять команду недельной давности нельзя ни при каких условиях
 *     (см. agentBridgeGuard). Один сокет на двоих означал бы, что кто-то из
 *     двоих получает чужую политику.
 *  3. Мост включают и выключают отдельно, и отзыв ключа — это переподписка на
 *     новую тему. На общем сокете каждый такой щелчок ронял бы и переписку.
 *
 * Цена признаётся: одно лишнее TCP-соединение и свой цикл переподключения,
 * пока мост включён. Выключенный мост не стоит ничего — сокета просто нет.
 *
 * ЧТО ПРОИСХОДИТ СО СВЁРНУТЫМ ПРИЛОЖЕНИЕМ. Разное на разных системах, и это
 * приходится знать обоим — и человеку в настройках, и агенту.
 *
 * iOS: через несколько секунд после сворачивания система останавливает
 * выполнение JavaScript, сокет закрывается, мост перестаёт отвечать. В
 * приложении есть `initBackgroundKeepalive` (core/social/backgroundKeepalive),
 * он держит фон тишиной в аудиосессии — но он про доставку звонков и работает
 * не всегда и не вечно. Полагаться на него как на «мост ответит» нельзя, и
 * обходить это фоновыми уловками мы не будем: на iOS они не работают, а в
 * App Store с ними не пускают.
 *
 * Android: пока поднят туннель OpenFlux, работает служба переднего плана
 * (`OpenFluxForegroundService`), и процесс живёт вместе с ней — мост отвечает
 * и со свёрнутым приложением. Как только туннель выключили, служба
 * останавливается (`AirChatOpenFluxModule.stop`), и дальше процесс живёт
 * ровно столько, сколько ему отмерит система. То есть «на Android лучше» —
 * правда, но не безусловная: лучше именно тогда, когда туннель включён.
 */
import { log } from '../logger';
import { kvGet, kvSet } from '../storage/local';
import { loadConfig } from '../config';
import { DEFAULT_RELAY_BASE, DEFAULT_WS_BASE } from '../transport/internet/relayConfig';
import {
  deriveBridgeKeys,
  loadBridgeSecret,
  readAcceptedSeq,
  writeAcceptedSeq,
  type BridgeKeys,
} from './agentBridgeKeys';
import { MAX_FRAME_CHARS, openFrame, parseFrameHead, sealFrame } from './agentBridgeFrame';
import { BridgeGuard, FRESHNESS_WINDOW_MS, describeRefusal } from './agentBridgeGuard';
import { KNOWN_COMMANDS, parseCommand, runBridgeCommand, type BridgeReply } from './agentBridgeCommands';

/**
 * Включён ли мост. Ключ device-local: мост это свойство устройства, а не
 * учётной записи, и на втором телефоне того же человека он свой.
 */
const ENABLED_KEY = 'agent_bridge_enabled';

/**
 * Выключен, пока явно не включили.
 *
 * Обратите внимание на сравнение: у настроек уведомлений в проекте
 * противоположное соглашение (`!== 'false'`, то есть по умолчанию включено).
 * Здесь именно `=== 'true'`, и разница принципиальна: канал управления
 * приложением не должен оказаться открытым из-за того, что ключа в хранилище
 * не нашлось.
 */
export async function isBridgeEnabled(): Promise<boolean> {
  return (await kvGet(ENABLED_KEY)) === 'true';
}

export async function setBridgeEnabled(on: boolean): Promise<void> {
  await kvSet(ENABLED_KEY, on ? 'true' : 'false');
}

/**
 * Сколько накопленного просить у ретранслятора при подписке.
 *
 * Ровно окно годности: всё, что старше, `BridgeGuard` всё равно отбросит, и
 * скачивать 30 суток истории только для того, чтобы её выбросить, значит
 * тратить трафик и батарею при каждом переподключении.
 */
const SINCE_PARAM = `${Math.round(FRESHNESS_WINDOW_MS / 60_000)}m`;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Ответ ретранслятора в сокете. Интересны только события `message`. */
type RelayEvent = { event?: string; message?: string };

type BridgeState = {
  keys: BridgeKeys;
  guard: BridgeGuard;
  relayBase: string;
  wsBase: string;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  active: boolean;
};

let state: BridgeState | null = null;

/** Отдаёт темы для интерфейса. `null` — мост не поднят. */
export function bridgeTopicsForDiagnostics(): { command: string; reply: string } | null {
  return state ? { command: state.keys.commandTopic, reply: state.keys.replyTopic } : null;
}

export function isBridgeRunning(): boolean {
  return !!state?.active;
}

async function publishReply(s: BridgeState, seq: number, reply: BridgeReply): Promise<void> {
  const frame = sealFrame(s.keys.aeadKey, 'res', seq, Date.now(), reply);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${s.relayBase}/${s.keys.replyTopic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Tags: 'airchat' },
      body: frame,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Тема в журнал не попадает: она выведена из секрета, и знание темы это
    // половина доступа. По той же причине здесь нет ни ключа, ни тела ответа.
    if (!res.ok) log.warn('agent_bridge_reply_http_err', { status: res.status });
  } catch (e) {
    // Текста ошибки здесь нет намеренно: сообщения сетевых библиотек часто
    // содержат сам адрес запроса, а в адресе — тема ответов. Журнал уезжает в
    // отчёт о неполадке целиком, и тема моста в нём оказаться не должна.
    log.warn('agent_bridge_reply_failed', { kind: e instanceof Error ? e.name : 'unknown' });
  }
}

async function handleRaw(s: BridgeState, raw: string): Promise<void> {
  if (!raw || raw.length > MAX_FRAME_CHARS + 2048) return;
  let ev: RelayEvent;
  try {
    ev = JSON.parse(raw) as RelayEvent;
  } catch {
    return;
  }
  if (ev.event !== 'message' || typeof ev.message !== 'string') return;

  const head = parseFrameHead(ev.message);
  // Не кадр моста или кадр наш же собственный (ответ вернулся эхом) — молча
  // мимо. Отвечать на мусор в теме значит превращать мост в усилитель.
  if (!head || head.dir !== 'cmd') return;

  const now = Date.now();
  const verdict = s.guard.admit(head.seq, head.at, now);
  // Просроченное и уже исполненное отбрасывается ДО расшифровки: именно этим
  // переигранная при переподключении история обходится почти бесплатно. И
  // отвечать на неё нельзя — иначе каждое переподключение засыпало бы агента
  // отказами на команды, которые он отправлял неделю назад.
  if (!verdict.ok && (verdict.reason === 'stale' || verdict.reason === 'replayed')) {
    log.info('agent_bridge_frame_dropped', { reason: verdict.reason });
    return;
  }

  const payload = openFrame(s.keys.aeadKey, head);
  // Не расшифровалось — значит, кадр не от владельца ключа. Молчание здесь
  // намеренное: ответ подтвердил бы чужому, что тема угадана верно.
  if (payload === null) {
    log.info('agent_bridge_frame_foreign');
    return;
  }

  if (!verdict.ok) {
    await publishReply(s, head.seq, {
      ok: false,
      cmd: 'unknown',
      error: verdict.reason,
      message: describeRefusal(verdict.reason),
    });
    return;
  }

  const command = parseCommand(payload);
  if (!command) {
    s.guard.accept(head.seq, now);
    await writeAcceptedSeq(s.guard.lastAcceptedSeq());
    await publishReply(s, head.seq, {
      ok: false,
      cmd: 'unknown',
      error: 'malformed',
      message: `Кадр разобран, но команды в нём нет. Ожидается {"cmd":"…"}. Мост умеет: ${KNOWN_COMMANDS.join(', ')}.`,
    });
    return;
  }

  // Номер продвигается ДО исполнения. Иначе команда, на которой приложение
  // упало или было свёрнуто, при следующей подписке исполнилась бы второй раз
  // — а это ровно то, от чего вся защита.
  s.guard.accept(head.seq, now);
  await writeAcceptedSeq(s.guard.lastAcceptedSeq());

  const reply = await runBridgeCommand(command);
  await publishReply(s, head.seq, reply);
}

function scheduleReconnect(s: BridgeState): void {
  if (!s.active || s.reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** s.reconnectAttempt);
  s.reconnectAttempt = Math.min(s.reconnectAttempt + 1, 6);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    openWs(s);
  }, delay);
}

function openWs(s: BridgeState): void {
  if (!s.active) return;
  const url = `${s.wsBase}/${s.keys.commandTopic}/ws?since=${SINCE_PARAM}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    // Без текста ошибки — по той же причине: в нём бывает адрес с темой.
    log.warn('agent_bridge_ws_ctor_failed', { kind: e instanceof Error ? e.name : 'unknown' });
    scheduleReconnect(s);
    return;
  }
  s.ws = ws;
  ws.onopen = () => {
    s.reconnectAttempt = 0;
    log.info('agent_bridge_ws_open');
  };
  ws.onmessage = (event: WebSocketMessageEvent) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    void handleRaw(s, raw).catch((e) => {
      log.warn('agent_bridge_handle_failed', { err: e instanceof Error ? e.message : String(e) });
    });
  };
  ws.onerror = () => {
    log.info('agent_bridge_ws_error');
  };
  ws.onclose = () => {
    if (s.ws === ws) s.ws = null;
    scheduleReconnect(s);
  };
}

/**
 * Поднять мост, если он включён и секрет создан.
 *
 * Возвращает, поднялся ли. Отсутствие секрета это не ошибка: включить мост,
 * не создав ключ доступа, в интерфейсе нельзя, но переустановка на Android
 * стирает SecureStore, и тогда флаг «включено» переживает секрет.
 */
export async function startAgentBridgeIfEnabled(): Promise<boolean> {
  stopAgentBridge();
  if (!(await isBridgeEnabled())) return false;
  const secret = await loadBridgeSecret();
  if (!secret) {
    log.warn('agent_bridge_no_secret');
    return false;
  }
  const cfg = await loadConfig();
  const s: BridgeState = {
    keys: deriveBridgeKeys(secret),
    guard: new BridgeGuard(await readAcceptedSeq()),
    relayBase: cfg.internet?.relayBase ?? DEFAULT_RELAY_BASE,
    wsBase: cfg.internet?.wsBase ?? DEFAULT_WS_BASE,
    ws: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    active: true,
  };
  state = s;
  openWs(s);
  log.info('agent_bridge_started');
  return true;
}

export function stopAgentBridge(): void {
  const s = state;
  state = null;
  if (!s) return;
  s.active = false;
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  if (s.ws) {
    try {
      s.ws.onopen = null;
      s.ws.onmessage = null;
      s.ws.onerror = null;
      s.ws.onclose = null;
      s.ws.close();
    } catch {
      /* сокет уже мёртв — закрывать нечего */
    }
    s.ws = null;
  }
  log.info('agent_bridge_stopped');
}

/**
 * Для тестов: обработать один кадр так, как это сделал бы сокет.
 *
 * Отдельный вход нужен потому, что WebSocket в jest-окружении не поднимается,
 * а проверять надо именно разбор и защиту, а не сетевую обвязку.
 */
export async function handleBridgeFrameForTest(
  keys: BridgeKeys,
  guard: BridgeGuard,
  frame: string,
  send: (reply: BridgeReply, seq: number) => void,
): Promise<void> {
  const s: BridgeState = {
    keys,
    guard,
    relayBase: 'https://example.invalid',
    wsBase: 'wss://example.invalid',
    ws: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    active: true,
  };
  const prev = state;
  state = s;
  const original = globalThis.fetch;
  // Ответ перехватывается подменой fetch: у моста нет другого способа его
  // отдать, и тест должен видеть ровно то, что ушло бы в сеть.
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ?? '';
    const head = parseFrameHead(body);
    if (head) {
      const opened = openFrame(keys.aeadKey, head);
      if (opened) send(opened as BridgeReply, head.seq);
    }
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    await handleRaw(s, JSON.stringify({ event: 'message', message: frame }));
  } finally {
    globalThis.fetch = original;
    state = prev;
  }
}
