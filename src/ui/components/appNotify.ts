/**
 * Шина уведомлений приложения: короткий тост и диалог подтверждения.
 *
 * Зачем. `showSuccess`/`showError` звали `Alert.alert` на iOS и `ToastAndroid`
 * на Android — то есть НИ ОДНО из 489 уведомлений приложения не знало о теме.
 * На iOS «Скопировано» открывало системное окно поверх тёмного приложения, со
 * светлой подложкой и обязательным «ОК»: подтверждение того, что человек и так
 * только что сделал, требовало ещё одного нажатия. Диалоги подтверждения
 * («Удалить у всех», «Завершить опрос?») — тот же случай.
 *
 * Здесь только шина: сам вид тоста и окна живёт в `AppNotifyHost.tsx`. Разделены
 * они не для красоты, а чтобы `userFeedback.ts` — который зовут и из мест, где
 * React не запущен, — не тянул за собой дерево компонентов.
 *
 * Подписчик один: хост монтируется один раз в `App.tsx`. Пока его нет (ранний
 * старт, тесты), `push*` честно возвращает false, и вызывающий откатывается на
 * системное окно — молча терять уведомление нельзя.
 *
 * Тост — исключение: у него подписчиков стопка, см. `addToastListener`.
 */

/** Назначение уведомления. Цвет и значок выбирает хост. */
export type NotifyTone = 'success' | 'error';

export interface ToastSpec {
  id: number;
  tone: NotifyTone;
  message: string;
}

/** Кнопка диалога подтверждения. */
export interface ConfirmActionSpec {
  label: string;
  onPress?: () => void;
  /** Необратимое действие: рисуется цветом ошибки. */
  destructive?: boolean;
  /** «Отмена»: закрывает окно и ничего не делает. Всегда последняя. */
  cancel?: boolean;
}

export interface ConfirmSpec {
  id: number;
  title: string;
  message?: string;
  actions: ConfirmActionSpec[];
}

/**
 * Сколько тост висит на экране.
 *
 * Об ошибке читать дольше, чем об успехе: у неё есть причина, и её надо успеть
 * прочесть. Значения те же, что были у `ToastAndroid.SHORT`/`LONG` (2 и 3.5 с),
 * — поведение Android этой заменой не меняется.
 */
export const TOAST_MS: Record<NotifyTone, number> = {
  success: 2000,
  error: 3500,
};

type ToastListener = (spec: ToastSpec) => void;
type ConfirmListener = (spec: ConfirmSpec) => void;

/**
 * Слушатели тоста — стопкой, и сообщение получает последний.
 *
 * v4.32.597. Хост тоста был один, на всё приложение. Но карточка профиля, лист
 * действий, окно комментариев — это `Modal`, а `Modal` живёт в отдельном
 * НАТИВНОМ окне поверх приложения, и нарисованный под ним тост человек не
 * видит: «ID скопирован» уходил за ту самую карточку, из которой ID и
 * копировали.
 *
 * Поэтому слой тоста рисует каждое окно (`AppModal`), а шина отдаёт сообщение
 * тому, кто подписался последним, — то есть верхнему окну на экране. Окно
 * закрылось, слой снялся — и тост снова рисует хост приложения.
 */
const toastListeners: ToastListener[] = [];
let confirmListener: ConfirmListener | null = null;
let seq = 0;

/** Подписать слой тоста. Возвращает отписку — её и надо звать при размонтировании. */
export function addToastListener(fn: ToastListener): () => void {
  toastListeners.push(fn);
  return () => {
    const at = toastListeners.lastIndexOf(fn);
    if (at >= 0) toastListeners.splice(at, 1);
  };
}

export function setConfirmListener(fn: ConfirmListener | null): void {
  confirmListener = fn;
}

/** true — тост отдан хосту; false — хоста нет, показывать нечем. */
export function pushToast(tone: NotifyTone, message: string): boolean {
  const top = toastListeners[toastListeners.length - 1];
  if (!top) return false;
  seq += 1;
  top({ id: seq, tone, message });
  return true;
}

/** true — окно отдано хосту; false — хоста нет, показывать нечем. */
export function pushConfirm(spec: Omit<ConfirmSpec, 'id'>): boolean {
  if (!confirmListener) return false;
  seq += 1;
  confirmListener({ ...spec, id: seq });
  return true;
}

/** Только для тестов: вернуть шину в исходное состояние. */
export function resetNotifyBus(): void {
  toastListeners.length = 0;
  confirmListener = null;
  seq = 0;
}
