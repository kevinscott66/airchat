// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: единый UX для permission-denied — если убрать «Настройки»,
// пользователь не поймёт как восстановить доступ после первичного отказа.
import { Alert, Linking } from 'react-native';

/**
 * Единообразный Alert для отказа в системных permissions.
 * Кнопка «Настройки» → `Linking.openSettings()` — открывает страницу
 * приложения в системных настройках, где пользователь может включить
 * нужный permission вручную. Актуально, когда система уже показала
 * «Don't ask again» (Android) или переключили permission в Deny (iOS/Android).
 *
 * @param feature      Человекочитаемое название функции («Камера», «Геолокация», …)
 *                     — подставляется в заголовок «Нужен доступ: {feature}».
 * @param explanation  Одно-двухстрочное объяснение ЗАЧЕМ нужен permission —
 *                     показывается в теле диалога.
 */
export function showPermissionDeniedAlert(feature: string, explanation: string): void {
  Alert.alert(
    `Нужен доступ: ${feature}`,
    `${explanation}\n\nОткройте настройки приложения, чтобы включить разрешение вручную.`,
    [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Настройки', onPress: () => { void Linking.openSettings(); } },
    ],
  );
}
