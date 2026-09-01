/**
 * Заголовок и текст системного уведомления о личном сообщении.
 *
 * v4.32.477. Уведомление о переписке до этой версии собиралось в одном месте —
 * в обработчике входящего push'а, — и текста у него не было в принципе:
 * расшифровка происходит уже после доставки, а тело, присланное сервером,
 * недостоверно. Когда показ уведомления появился и на приёме по сети, текст
 * стал известен, и решение «что именно вынести на экран блокировки» перестало
 * быть тривиальным: превью можно выключить настройкой, оно бывает пустым и
 * бывает длиннее строки уведомления.
 *
 * Модуль без импортов и без обращений к базе: его решения проверяются без
 * notifee, SQLite и транспорта.
 */

/** Что показывать, когда сказать нечего или превью выключено. */
export const DM_BANNER_FALLBACK_BODY = 'Новое сообщение';

/** Имя, когда собеседник ещё не в контактах. */
export const DM_BANNER_FALLBACK_TITLE = 'AirChat';

/**
 * Длина тела уведомления. Android всё равно обрежет строку по ширине экрана,
 * но в журнал уведомлений и на часы уходит то, что мы передали, — класть туда
 * сообщение целиком незачем.
 */
export const DM_BANNER_BODY_MAX = 140;

export type DmBannerTextInput = {
  /** Имя из СВОЕЙ базы контактов. Имя из сети сюда попадать не должно. */
  senderName?: string | null;
  /** Расшифрованное превью, если оно уже известно. */
  preview?: string | null;
  /** Настройка «показывать текст сообщения в уведомлениях». */
  showPreview: boolean;
};

/**
 * Пусто ли по-настоящему: строка из одних пробелов на экране блокировки
 * выглядит как уведомление без текста, а не как сообщение.
 */
function blank(s: string | null | undefined): boolean {
  return !s || s.trim().length === 0;
}

export function dmBannerText(input: DmBannerTextInput): { title: string; body: string } {
  if (!input.showPreview) {
    // Превью выключено — уведомление не должно выдавать ни имени, ни текста.
    return { title: DM_BANNER_FALLBACK_TITLE, body: DM_BANNER_FALLBACK_BODY };
  }
  const title = blank(input.senderName) ? DM_BANNER_FALLBACK_TITLE : (input.senderName as string);
  const body = blank(input.preview)
    ? DM_BANNER_FALLBACK_BODY
    : (input.preview as string).slice(0, DM_BANNER_BODY_MAX);
  return { title, body };
}
