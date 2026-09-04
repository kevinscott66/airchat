/**
 * Очередь операторов к одному соединению SQLite.
 *
 * v4.32.581. Появилась ради веба, но нужна везде.
 *
 * Соединение база отдаёт одно, а желающих в него писать — много: обмен,
 * подкачка ленты, разбор входящих конвертов и рука человека работают
 * одновременно. Одиночный оператор SQLite разложит по очереди сам, а вот
 * «BEGIN IMMEDIATE … COMMIT» — не оператор, а последовательность из нескольких
 * вызовов, и всё, что успеет вклиниться между ними с того же соединения,
 * попадёт внутрь чужой транзакции. Откат такой транзакции унесёт с собой и
 * чужую запись — при том что вызвавший её код об откате не узнает.
 *
 * Затвор здесь именно про это: пока кто-то держит транзакцию открытой,
 * операторы остальных ждут. Владелец определяется меткой (`owner`) — в вебе это
 * вкладка, на телефоне владелец ровно один.
 *
 * Чего затвор НЕ делает: он не разбирает, какой из операторов той же метки
 * относится к открытой транзакции, а какой просто оказался рядом. Внутри одной
 * вкладки поведение остаётся прежним (см. известную задачу про сериализацию
 * транзакций) — здесь закрывается межвкладочный случай, где чужая запись
 * прилетает из другого окна и раньше пропала бы молча.
 *
 * Ещё затвор не верит, что владелец обязательно вернётся: вкладку закрывают в
 * любой момент, в том числе между BEGIN и COMMIT. Поэтому у открытой
 * транзакции есть срок; по его истечении затвор освобождается сам, иначе одна
 * убитая вкладка заперла бы базу до перезагрузки остальных.
 */

/** Что оператор делает с затвором. */
export type TxnEffect = 'open' | 'close' | 'none';

/** Пока владелец молчит дольше этого, затвор считается брошенным. */
export const TXN_ABANDON_MS = 15_000;

const OPENERS = /^begin(\s|$)/;
const CLOSERS = /^(commit|end|rollback)(\s|$)/;

/**
 * Влияние оператора на затвор.
 *
 * Смотрит только на первое слово: комментарии и пробелы срезаются, регистр не
 * важен. `SAVEPOINT`/`RELEASE` сознательно считаются обычными операторами — в
 * этом хранилище их нет, а угадывать вложенность по тексту хуже, чем не
 * угадывать вовсе.
 */
export function txnEffect(sql: string): TxnEffect {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .toLowerCase();
  if (OPENERS.test(s)) return 'open';
  if (CLOSERS.test(s)) return 'close';
  return 'none';
}

type Waiter = { owner: string; resume: () => void };

export class SqlGate {
  /** Хвост очереди: операторы идут по одному, как их отдало соединение. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Метка того, кто держит открытую транзакцию. */
  private holder: string | null = null;
  private waiters: Waiter[] = [];
  private abandonTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly abandonMs: number = TXN_ABANDON_MS,
    private readonly onAbandon?: (owner: string) => void
  ) {}

  /** Держит ли кто-то транзакцию (для диагностики и тестов). */
  get openTransactionOwner(): string | null {
    return this.holder;
  }

  /**
   * Поставить оператор в очередь.
   *
   * `run` вызывается ровно один раз и только когда до него дошла очередь.
   */
  async submit<T>(owner: string, effect: TxnEffect, run: () => Promise<T>): Promise<T> {
    while (this.holder !== null && this.holder !== owner) {
      await new Promise<void>((resume) => this.waiters.push({ owner, resume }));
    }

    if (effect === 'open') this.take(owner);

    const chained = this.tail.then(run, run);
    // Хвост не должен помнить отказы: иначе первый же упавший оператор отравил
    // бы всю очередь, а каждый следующий получил бы чужое исключение.
    this.tail = chained.then(
      () => undefined,
      () => undefined
    );

    try {
      const value = await chained;
      if (effect === 'close') this.free(owner);
      else if (effect === 'open') this.touch();
      return value;
    } catch (e) {
      // Не открылась — затвор не наш. Не закрылась — держать дальше нечего:
      // соединение в неизвестном состоянии, и запирать им остальных вредно.
      if (effect !== 'none') this.free(owner);
      throw e;
    }
  }

  /** Отпустить затвор за владельца, который больше не отзовётся. */
  release(owner: string): void {
    if (this.holder === owner) this.free(owner);
  }

  private take(owner: string): void {
    this.holder = owner;
    this.touch();
  }

  private touch(): void {
    if (this.abandonTimer) clearTimeout(this.abandonTimer);
    if (this.abandonMs <= 0) return;
    const owner = this.holder;
    this.abandonTimer = setTimeout(() => {
      if (this.holder !== owner || owner === null) return;
      this.free(owner);
      this.onAbandon?.(owner);
    }, this.abandonMs);
    // Сторож не должен держать процесс живым ради пустого ожидания.
    (this.abandonTimer as { unref?: () => void }).unref?.();
  }

  private free(owner: string): void {
    if (this.holder !== owner) return;
    this.holder = null;
    if (this.abandonTimer) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w.resume();
  }
}
