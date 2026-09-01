/**
 * Одно обновление за раз, с повтором, и без молчаливых падений.
 *
 * v4.32.545. Один и тот же приём был переписан от руки трижды: обновление
 * переписки (ChatScreen), обновление списка сообщений группы (GroupsScreen) и
 * подсчёт очереди отправки (OfflineStatus). Схема везде одна — «пока идёт
 * запрос, второй не начинаем; попросили ещё раз — повторим после», — и везде
 * с одними и теми же тремя изъянами.
 *
 * Первый: отказ выходил наружу. Обновление переписки зовут из двадцати восьми
 * мест, и почти все — `void appendNewMessages()`. Отказавшее чтение базы там
 * не попадало ни в журнал, ни на экран: у пользователя переписка просто
 * переставала пополняться, а понять почему было нечем. Здесь работа
 * оборачивается так, что вернувшееся обещание не отказывает никогда, а
 * причина уходит в `onError` — зовущему остаётся решить, писать её в журнал
 * или показать.
 *
 * Второй: отказ доставался и тому, кто ни при чём. Второй зовущий ждал чужое
 * обещание (`await inFlightRef.current`) и получал чужую ошибку.
 *
 * Третий: повтор вызывал сам себя из `finally`. Пока запросы приходят быстрее,
 * чем выполняются, стек растёт. Здесь повтор — виток цикла.
 *
 * Модуль намеренно без импортов: ни таймеров, ни базы, ни экрана — только
 * порядок вызовов, который и проверяется тестом.
 */

export type CoalescedTask = {
  /**
   * Выполнить работу. Если предыдущая ещё идёт — запомнить и дождаться её;
   * новая начнётся сразу после. Возвращённое обещание не отказывает.
   */
  run(work: () => Promise<void>): Promise<void>;
  /** Идёт ли работа прямо сейчас. */
  isBusy(): boolean;
};

export type CoalescedTaskOptions = {
  /** Куда сообщить о сорвавшейся работе. Без него отказ просто гасится. */
  onError?: (e: unknown) => void;
  /**
   * Повторять ли работу, о которой попросили во время выполнения. По
   * умолчанию да: свежие данные и есть смысл вызова. `false` — когда работа
   * идемпотентна и лишний прогон ничего не добавит.
   */
  repeat?: boolean;
};

export function createCoalescedTask(options: CoalescedTaskOptions = {}): CoalescedTask {
  const { onError, repeat = true } = options;
  let inFlight: Promise<void> | null = null;
  let pending: (() => Promise<void>) | null = null;

  async function loop(first: () => Promise<void>): Promise<void> {
    let next: (() => Promise<void>) | null = first;
    while (next) {
      const work = next;
      next = null;
      try {
        await work();
      } catch (e) {
        if (onError) onError(e);
      }
      if (pending) {
        next = pending;
        pending = null;
      }
    }
  }

  return {
    run(work: () => Promise<void>): Promise<void> {
      if (inFlight) {
        if (repeat) pending = work;
        return inFlight;
      }
      let done: () => void = () => {};
      const waiter = new Promise<void>((resolve) => {
        done = resolve;
      });
      // Присваиваем до запуска: работа может позвать `run` синхронно, и до
      // этого места она обязана видеть, что обновление уже идёт.
      inFlight = waiter;
      void loop(work).then(() => {
        inFlight = null;
        done();
      });
      return waiter;
    },
    isBusy(): boolean {
      return inFlight !== null;
    },
  };
}
