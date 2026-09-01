/**
 * lanInbound — учёт входящих TCP-соединений LAN-сервера. Чистый модуль: знает
 * только про «объект, который можно закрыть», без react-native-tcp-socket.
 *
 * v4.32.338: сервер принимал соединения без счёта и без срока. На каждое
 * заводится накопитель кадров, который держит незавершённый кадр — до мегабайта
 * с небольшим. Устройство в той же сети могло открыть их сколько угодно и
 * замолчать: накопители висят, сокеты не закрываются, и ни память, ни файловые
 * дескрипторы никто не возвращает. Карта пиров кап получила ещё в v4.32.201,
 * а сокеты остались без него.
 */

export const LAN_MAX_INBOUND_SOCKETS = 32;
/** Соединение, по которому давно не приходило байт, закрываем. */
export const LAN_INBOUND_IDLE_MS = 30_000;
export const LAN_INBOUND_SWEEP_MS = 10_000;

export interface ClosableSocket {
  destroy: () => void;
}

interface Entry {
  socket: ClosableSocket;
  lastData: number;
}

function closeQuietly(socket: ClosableSocket): void {
  try {
    socket.destroy();
  } catch {
    /* сокет уже мёртв — это и требовалось */
  }
}

export class InboundSocketRegistry {
  private readonly open = new Map<number, Entry>();
  private seq = 0;

  get size(): number {
    return this.open.size;
  }

  /**
   * Взять соединение на учёт. При переполнении закрывает то, по которому дольше
   * всех ничего не приходило: молчащий сокет атакующего уступает место раньше
   * работающего соединения с реальным контактом.
   */
  add(socket: ClosableSocket, now: number): number {
    if (this.open.size >= LAN_MAX_INBOUND_SOCKETS) this.evictStalest();
    const id = ++this.seq;
    this.open.set(id, { socket, lastData: now });
    return id;
  }

  private evictStalest(): void {
    let stalestId: number | null = null;
    let stalestAt = Infinity;
    for (const [id, e] of this.open) {
      if (e.lastData < stalestAt) {
        stalestAt = e.lastData;
        stalestId = id;
      }
    }
    if (stalestId !== null) this.close(stalestId);
  }

  /** Отметить, что по соединению пришли байты. */
  touch(id: number, now: number): void {
    const e = this.open.get(id);
    if (e) e.lastData = now;
  }

  /** Снять с учёта, не закрывая: сокет уже закрылся сам. */
  forget(id: number): void {
    this.open.delete(id);
  }

  close(id: number): void {
    const e = this.open.get(id);
    if (!e) return;
    this.open.delete(id);
    closeQuietly(e.socket);
  }

  /** Закрыть всё, что молчит дольше срока. Возвращает число закрытых. */
  sweep(now: number): number {
    let closed = 0;
    for (const [id, e] of [...this.open]) {
      if (now - e.lastData > LAN_INBOUND_IDLE_MS) {
        this.close(id);
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const e of [...this.open.values()]) closeQuietly(e.socket);
    this.open.clear();
  }
}
