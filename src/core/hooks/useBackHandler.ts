// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единый способ перехватить Android hardware back button по всему приложению.
// При изменении контракта (возврат true/false, priority) сломаются все Modal/subScreen/overlay,
// которые сейчас корректно закрываются по back — вместо закрытия оверлея выйдет приложение.
import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

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
 * iOS: BackHandler no-op (там нет hardware-back, возврат идёт через жесты/стрелки в NavBar),
 * но хук безопасно вызывать — просто ничего не регистрирует.
 */
export function useBackHandler(active: boolean, onBack: () => boolean | void): void {
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
