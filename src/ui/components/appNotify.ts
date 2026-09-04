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

let toastListener: ToastListener | null = null;
let confirmListener: ConfirmListener | null = null;
let seq = 0;

export function setToastListener(fn: ToastListener | null): void {
  toastListener = fn;
}

export function setConfirmListener(fn: ConfirmListener | null): void {
  confirmListener = fn;
}

/** true — тост отдан хосту; false — хоста нет, показывать нечем. */
export function pushToast(tone: NotifyTone, message: string): boolean {
  if (!toastListener) return false;
  seq += 1;
  toastListener({ id: seq, tone, message });
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
  toastListener = null;
  confirmListener = null;
  seq = 0;
}
