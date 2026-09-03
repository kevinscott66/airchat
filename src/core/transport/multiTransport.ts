import { log } from '../logger';
import { getWiFiMeshTransport } from './longrange/wifiMesh';
import { getLanTransportSingleton } from './lan/lanTransport';
import { getInternetTransportSingleton } from './internet/internetTransport';

export type TransportId = 'internet' | 'lan' | 'wifi_direct';

/**
 * Сколько символов DID попадает в лог.
 *
 * v4.32.332: раньше писался целиком, на каждую попытку каждого транспорта.
 * Из такого лога — а он уходит в отчёт о диагностике — восстанавливается
 * полный список, кто с кем переписывается и когда. Префикса хватает, чтобы
 * различить собеседников при разборе проблемы с доставкой.
 */
const DID_LOG_LEN = 24;
const shortDid = (did: string): string => did.slice(0, DID_LOG_LEN);

/**
 * Ограничение по времени, которое снимает за собой таймер.
 *
 * v4.32.332. Обе гонки ниже писались как Promise.race с голым setTimeout, и
 * таймер оставался заведённым, даже когда транспорт ответил сразу. На одно
 * сообщение это два висящих таймера на 2.5 и 5 секунд; при рассылке в группу
 * или веерной раздаче ленты (fan-out 64) — сотни таймеров, которые движок
 * обязан хранить и разбудить впустую.
 */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

type TransportEntry = {
  id: TransportId;
  priority: number;
  send: (data: Uint8Array, targetDid: string) => Promise<boolean>;
  canReach: (targetDid: string) => Promise<boolean>;
};

/**
 * Приоритет (базовый):
 *   1. **lan** (priority 1) — доставка в ту же Wi-Fi подсеть через mDNS + TCP.
 *      Быстрее, без зависимости от внешних серверов. Если пир в peers-Map'е
 *      lanTransport — идём сюда первым.
 *   2. **internet** (priority 2) — relay (по умолчанию ntfy.sh, адрес свой
 *      сервер задаётся в настройках), работает в разных сетях и через
 *      мобильный интернет. Fallback когда LAN не видит пира.
 *   3. **wifi_direct** (priority 3) — P2P WiFi-Direct, short-range.
 *
 * v4.32.332: убран четвёртый транспорт 'webrtc'. Он публиковал данные в
 * IPFS-pubsub на тему `airchat-router-webrtc-<did>`, на которую НИКТО никогда
 * не подписывался — доставить он не мог ни одного сообщения ни на одной
 * платформе. При этом pubsubPublish отвечал успехом, и роутер возвращал true:
 * недоставленное сообщение считалось отправленным и не попадало в повтор.
 * Отдельно тема содержала DID получателя открытым текстом — ровно то, от чего
 * internetTransport защищается хешированием DID в имя темы.
 *
 * Адаптация: фактический порядок сортируется по `priority - successRate*10`,
 * так что стабильно работающий транспорт с бóльшим success-rate опережает.
 *
 * На Android активны LAN + internet. Если устройства в разных сетях — internet
 * доставляет; если в одной — LAN быстрее, internet молча работает как дубль
 * (receiver-side дедуп через INSERT OR IGNORE и kvStore-guards).
 */
export class MultiTransportRouter {
  // v4.32.155 T7: EMA success-rate вместо равновесного success/fail-счёта.
  // Равновесные счётчики дают одинаковый вес старым и новым результатам —
  // транспорт, упавший 100 раз месяц назад, но работающий сейчас, всё
  // равно получает низкий rate. EMA с α=0.2 забывает прошлое (~20 событий
  // полураспада) и реагирует на текущее состояние сети.
  private readonly transportEma = new Map<string, number>();
  private static readonly EMA_ALPHA = 0.2;
  private static readonly EMA_DEFAULT = 0.5;

  private readonly transports: TransportEntry[] = [
    {
      id: 'lan',
      priority: 1,
      send: (d, t) => this.sendLan(d, t),
      canReach: (t) => this.canReachLan(t),
    },
    {
      id: 'internet',
      priority: 2,
      send: (d, t) => this.sendInternet(d, t),
      canReach: (t) => this.canReachInternet(t),
    },
    {
      id: 'wifi_direct',
      priority: 3,
      send: (d, t) => this.sendWiFiDirect(d, t),
      canReach: (t) => this.canReachWiFiDirect(t),
    },
  ];

  /**
   * Отправить и сказать, каким транспортом ушло (v4.32.563).
   *
   * Раньше маршрутизатор отвечал только «да/нет». Сообщение, доставленное по
   * локальной сети без интернета, и сообщение, ушедшее через реле, выглядели
   * для отправителя одинаково — а разница между ними в том, кто в принципе
   * мог его увидеть по дороге. Теперь путь известен вызывающему, и в
   * «Сведениях о сообщении» стоит не догадка, а тот транспорт, который
   * подтвердил доставку.
   *
   * `null` — не доставил никто.
   */
  async sendVia(data: Uint8Array, targetDid: string): Promise<TransportId | null> {
    const sorted = [...this.transports].sort((a, b) => {
      const aScore = a.priority - this.getSuccessRate(a.id) * 10;
      const bScore = b.priority - this.getSuccessRate(b.id) * 10;
      return aScore - bScore;
    });

    // v4.32.213 (Audit-42 H4): bound per-transport send time. Without this
    // a hung internetTransport.send stalls the whole chain — combined with
    // gossip fan-out of 64, one bad peer freezes 64 outstanding sends. 5s
    // is generous for LAN/wifi-direct while still failing fast.
    const TRANSPORT_SEND_TIMEOUT_MS = 5000;
    const TRANSPORT_CANREACH_TIMEOUT_MS = 2500;
    for (const transport of sorted) {
      // v4.32.214 (Audit-43 H2): bound canReach. A hung reachability probe
      // (e.g. internetTransport pinging ntfy on a dead link) used to stall
      // the whole transport loop before the send-timeout ever applied.
      const canReach = await withTimeout(
        transport.canReach(targetDid),
        TRANSPORT_CANREACH_TIMEOUT_MS,
        false
      ).catch(() => false);
      if (!canReach) continue;

      // debug, а не info: строка пишется на КАЖДУЮ попытку КАЖДОГО транспорта
      // для каждого сообщения — при рассылке в группу это десятки строк на
      // одно нажатие, и полезные записи тонут между ними.
      log.debug('transport_trying', { transport: transport.id, targetDid: shortDid(targetDid) });

      try {
        const success = await withTimeout(
          transport.send(data, targetDid),
          TRANSPORT_SEND_TIMEOUT_MS,
          false,
          () =>
            log.warn('transport_send_timeout', {
              transport: transport.id,
              targetDid: shortDid(targetDid),
            })
        );
        this.recordResult(transport.id, success);

        if (success) {
          log.info('transport_success', { transport: transport.id, targetDid: shortDid(targetDid) });
          return transport.id;
        }
      } catch (error) {
        log.error('transport_failed', {
          transport: transport.id,
          targetDid: shortDid(targetDid),
          err: error instanceof Error ? error.message : String(error),
        });
        this.recordResult(transport.id, false);
      }
    }

    log.warn('transport_all_failed', { targetDid: shortDid(targetDid) });
    return null;
  }

  /** Прежний ответ «да/нет» — для мест, которым маршрут не нужен. */
  async send(data: Uint8Array, targetDid: string): Promise<boolean> {
    return (await this.sendVia(data, targetDid)) !== null;
  }

  /**
   * Виден ли получатель по локальному транспорту — без интернета.
   *
   * v4.32.550: раньше об этом никто не спрашивал до отправки. Проверка
   * «есть ли интернет» стояла выше маршрутизатора и обрывала отправку в
   * Wi‑Fi без выхода наружу, хотя LAN — транспорт первого приоритета и
   * доставил бы сообщение напрямую. См. `sync/writePathDecision.ts`.
   */
  async hasLocalPath(targetDid: string): Promise<boolean> {
    try {
      if (await this.canReachLan(targetDid)) return true;
      return await this.canReachWiFiDirect(targetDid);
    } catch {
      // Локальный путь не подтвердился — это не запрет на отправку, решение
      // принимает вызывающий.
      return false;
    }
  }

  private async sendLan(data: Uint8Array, targetDid: string): Promise<boolean> {
    return getLanTransportSingleton().send(data, targetDid);
  }

  private async canReachLan(targetDid: string): Promise<boolean> {
    const t = getLanTransportSingleton();
    return t.isActive() && t.canReach(targetDid);
  }

  private async sendInternet(data: Uint8Array, targetDid: string): Promise<boolean> {
    return getInternetTransportSingleton().send(data, targetDid);
  }

  private async canReachInternet(targetDid: string): Promise<boolean> {
    const t = getInternetTransportSingleton();
    if (!t.isActive()) return false;
    return t.canReach(targetDid);
  }

  private async sendWiFiDirect(data: Uint8Array, targetDid: string): Promise<boolean> {
    return getWiFiMeshTransport().send(data, targetDid);
  }

  private async canReachWiFiDirect(targetDid: string): Promise<boolean> {
    return getWiFiMeshTransport().canReach(targetDid);
  }

  private getSuccessRate(transportId: string): number {
    const ema = this.transportEma.get(transportId);
    return ema ?? MultiTransportRouter.EMA_DEFAULT;
  }

  private recordResult(transportId: string, success: boolean): void {
    // EMA: rate = rate*(1-α) + observed*α. α=0.2 → ~20-event half-life.
    const prev = this.transportEma.get(transportId) ?? MultiTransportRouter.EMA_DEFAULT;
    const α = MultiTransportRouter.EMA_ALPHA;
    const observed = success ? 1 : 0;
    const next = prev * (1 - α) + observed * α;
    this.transportEma.set(transportId, next);
  }
}

export const multiTransportRouter = new MultiTransportRouter();
