/**
 * Разговор вкладок об одном соединении с базой.
 *
 * v4.32.581. В браузере база живёт в OPFS, а `FileSystemSyncAccessHandle` на
 * файл существует ровно один на всё происхождение. Это не настройка и не
 * недосмотр: так устроено само хранилище. Вторая вкладка AirChat не «работала
 * медленнее» — она не открывала базу вовсе и падала на запуске, а человеку
 * предлагалось закрыть остальные вкладки.
 *
 * Здесь это устранено. Соединение по-прежнему одно, но принадлежит оно не
 * вкладке, а приложению: одна вкладка держит его и отвечает на запросы
 * остальных, остальные работают через неё. Когда держащая вкладка закрывается,
 * соединение забирает следующая — сама, без перезагрузки страницы.
 *
 * Этот модуль — только сам разговор: как выглядит запрос, как ответ находит
 * своего просителя, что делать с запросами, оставшимися без ответа. Ни
 * BroadcastChannel, ни Web Locks, ни SQLite он не знает и проверяется без
 * браузера. Провода — в webDbLease.
 */

/** Оператор, который просят выполнить. */
export type LeaseOp =
  | { kind: 'run'; sql: string; params: unknown[] }
  | { kind: 'all'; sql: string; params: unknown[] }
  | { kind: 'first'; sql: string; params: unknown[] }
  | { kind: 'exec'; sql: string };

export type LeaseMessage =
  /** Проситель → держателю: выполни. */
  | { t: 'req'; id: string; owner: string; op: LeaseOp }
  /** Держатель → просителю: вот что вышло. */
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; err: string }
  /** Держатель объявляется — новым вкладкам и после смены держателя. */
  | { t: 'lead'; epoch: number }
  /** Вкладка уходит: снять с неё незакрытую транзакцию, не дожидаясь срока. */
  | { t: 'bye'; owner: string }
  /**
   * Видимая вкладка просит соединение себе.
   *
   * Браузер усыпляет фоновые вкладки, и держатель в фоне отвечал бы на запросы
   * с задержкой или не отвечал вовсе — а ждал бы этого человек, глядя на
   * вкладку, которая у него открыта. Поэтому соединение переезжает к той, на
   * которую смотрят. Уступает только спрятанный держатель: двум видимым окнам
   * перебрасывать базу друг другу незачем, и обмен на этом останавливается.
   */
  | { t: 'yield'; from: string };

/** Запрос без ответа дольше этого — считается потерянным. */
export const LEASE_REQUEST_TIMEOUT_MS = 20_000;

/** Отказ, после которого запрос имеет смысл повторить новому держателю. */
export class LeaseRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseRetryable';
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Сторона просителя: раздаёт запросам номера и сводит с ними ответы.
 *
 * Номер уникален внутри вкладки — метка вкладки уже входит в него, поэтому
 * двух одинаковых номеров на канале не бывает.
 */
export class LeaseCaller {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly owner: string,
    private readonly post: (m: LeaseMessage) => void,
    private readonly timeoutMs: number = LEASE_REQUEST_TIMEOUT_MS
  ) {}

  get inFlight(): number {
    return this.pending.size;
  }

  /** Отправить оператор держателю и дождаться ответа. */
  call<T>(op: LeaseOp): Promise<T> {
    const id = `${this.owner}:${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Повторяемо: держатель мог закрыться ровно в этот момент, и следующая
        // попытка попадёт уже к новому.
        reject(new LeaseRetryable(`db_lease_timeout_${this.timeoutMs}ms`));
      }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.post({ t: 'req', id, owner: this.owner, op });
    });
  }

  /** Ответ с канала. Чужие и запоздавшие молча пропускаются. */
  accept(m: LeaseMessage): boolean {
    if (m.t !== 'res') return false;
    const p = this.pending.get(m.id);
    if (!p) return false;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.err));
    return true;
  }

  /**
   * Держателя больше нет: незавершённые запросы отпустить.
   *
   * Ждать их бессмысленно — отвечать некому, а держать вызвавший код до
   * истечения срока значит показать человеку зависший экран там, где смена
   * держателя занимает миллисекунды.
   */
  abortAll(reason: string): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(new LeaseRetryable(reason));
    }
  }
}

/** Сторона держателя: выполнить и ответить, не роняя канал. */
export async function serveLeaseRequest(
  m: LeaseMessage,
  exec: (owner: string, op: LeaseOp) => Promise<unknown>,
  post: (m: LeaseMessage) => void
): Promise<void> {
  if (m.t !== 'req') return;
  try {
    const value = await exec(m.owner, m.op);
    post({ t: 'res', id: m.id, ok: true, value });
  } catch (e) {
    post({ t: 'res', id: m.id, ok: false, err: e instanceof Error ? e.message : String(e) });
  }
}
