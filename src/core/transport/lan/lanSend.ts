/**
 * Отправка одного кадра по локальной сети.
 *
 * v4.32.499. Раньше успех объявлялся по неподвижному таймеру: после
 * `write()` снимался общий 12-секундный срок и ставился новый на 150 мс, а по
 * нему — `resolve(true)` и `destroy()` сокета. Подтверждения записи никто не
 * ждал: `write` у react-native-tcp-socket уходит на нативную сторону и
 * сообщает о результате колбэком, который может прийти и позже 150 мс, и с
 * ошибкой. Всё, что не успевало уйти, обрывалось вместе с сокетом, а наверх
 * возвращалось «отправлено».
 *
 * Больнее всего это било по вложениям: `lanBlob` режет файл на куски по
 * полмегабайта и по каждому `true` пишет в журнал «кусок ушёл». Приёмная
 * сторона ждала недостающие куски и через полторы минуты выбрасывала всё
 * собранное. Человек видел у себя галочку «отправлено», собеседник не
 * получал ни картинки, ни ошибки, а повторная отправка вела себя так же.
 *
 * Теперь `true` возвращается только по колбэку записи, а общий срок до этого
 * момента не снимается: если подтверждение не пришло, отправка честно
 * считается неудачной и уходит на повтор.
 *
 * Модуль отделён от lanTransport.ts, чтобы модуль сокетов можно было
 * подставить и проверить поведение без сети.
 */

export type TcpModule = {
  createServer: (
    listener: (socket: {
      on: (ev: string, cb: (data?: Uint8Array | Error) => void) => void;
      destroy: () => void;
    }) => void
  ) => {
    listen: (opts: { port: number; host: string; reuseAddress?: boolean }, cb?: () => void) => unknown;
    close: (cb?: () => void) => void;
    on: (ev: string, cb: (err?: Error) => void) => void;
  };
  createConnection: (
    opts: { port: number; host: string; timeout?: number },
    cb: () => void
  ) => {
    write: (data: Buffer | Uint8Array, encoding?: undefined, cb?: (err?: Error) => void) => void;
    destroy: () => void;
    on: (ev: string, cb: (err?: Error) => void) => void;
  };
};

/** Общий срок на всю попытку: соединение плюс подтверждение записи. */
export const LAN_SEND_TIMEOUT_MS = 12_000;

export function tcpSend(
  TcpSocket: TcpModule,
  host: string,
  port: number,
  frame: Uint8Array
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    // v4.32.152 T8: держим ссылку на socket на верхнем уровне, чтобы outer
    // timeout/catch могли его уничтожить. Без этого при срабатывании 12s
    // timeout socket продолжал жить в фоне (leak + запоздалые 'error').
    let client: ReturnType<TcpModule['createConnection']> | null = null;
    const destroyClient = (): void => {
      if (!client) return;
      try { client.destroy(); } catch { /* ignore */ }
      client = null;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      destroyClient();
      resolve(ok);
    };
    // Срок ставится до соединения: он покрывает и его тоже. Ручка объявлена
    // выше `finish`, чтобы синхронно пришедший отказ мог её снять.
    timer = setTimeout(() => finish(false), LAN_SEND_TIMEOUT_MS);
    try {
      client = TcpSocket.createConnection({ port, host, timeout: 10_000 }, () => {
        try {
          const buf = Buffer.from(frame);
          // v4.32.499: срок НЕ снимается здесь — только в finish. Пока
          // подтверждение не пришло, попытка считается идущей, а не удачной.
          client?.write(buf, undefined, (err?: Error) => {
            finish(!err);
          });
        } catch {
          finish(false);
        }
      });
      client.on('error', () => {
        finish(false);
      });
      // Сам по себе опция `timeout` в createConnection лишь эмитит событие
      // 'timeout' — она НЕ закрывает socket. Явно закрываем в handler'е.
      client.on('timeout', () => {
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}
