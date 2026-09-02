// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единый способ перехватить Android hardware back button по всему приложению.
// При изменении контракта (возврат true/false, priority) сломаются все Modal/subScreen/overlay,
// которые сейчас корректно закрываются по back — вместо закрытия оверлея выйдет приложение.
import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';
import { pushBackHandler } from './backStack';

/**
 * Хук для обработки системной кнопки «Назад» (Android) и жеста назад.
 *
 * Используется везде, где открывается перекрывающий UI (Modal, subScreen, overlay, sheet) —
 * чтобы системная кнопка сначала закрывала текущий оверлей, а не приложение.
 *
 * @param active  — регистрировать ли слушатель. Обычно `visible` у Modal или `subScreen !== null`.
 *                  Когда `false`, хук ничего не делает.
 * @param onBack  — колбэк, вызываемый при нажатии back. Если вернул `true` —
 *                  событие поглощено (приложение не выходит). Если `false`/`undefined` —
 *                  событие всплывает дальше (обычно — к следующему зарегистрированному листенеру,
 *                  а если их нет — Android закрывает приложение).
 *                  В 99% случаев колбэк должен делать `onClose()` и вернуть `true`.
 *
 * Listeners обрабатываются в порядке LIFO (последний зарегистрированный — первый получит событие),
 * что совпадает с «самая верхняя модалка закроется первой», ровно то что нужно для вложенных sheet'ов.
 *
 * iOS: BackHandler no-op — hardware-back там нет. Но с v4.32.540 колбэк
 * регистрируется ещё и во внутреннем стеке `backStack`, и его прокручивает
 * жест «свайп слева направо по середине экрана», так что на iOS хук уже не
 * пустой: он и есть возврат по жесту.
 */
export function useBackHandler(active: boolean, onBack: () => boolean | void): void {
  // v4.32.540: тот же колбэк — ещё и в стек жеста «свайп слева направо», на
  // всех платформах. Контракт не тронут: колбэк тот же, порядок тот же LIFO,
  // а системная кнопка по-прежнему идёт через `BackHandler` ниже. Двух
  // вызовов на одно событие быть не может — источники разные.
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(onBack);
  }, [active, onBack]);

  useEffect(() => {
    if (!active) return;
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const result = onBack();
      // Трактуем undefined как "событие поглощено" — это самый частый кейс
      // (onClose закрыл модалку, не хотим чтобы Android продолжил обработку и закрыл app).
      return result === false ? false : true;
    });
    return () => sub.remove();
  }, [active, onBack]);
}
