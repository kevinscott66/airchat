// v4.32.578: единая точка, из-за которой всплывающие окна приложения перестают
// быть системными.
//
// Зачем: `Alert.alert` в приложении вызывается из 171 места — экраны, модалки,
// сетевые обработчики. На iOS это системный алерт, нарисованный не в теме
// приложения: белая карточка поверх тёмного интерфейса. На Android нативный
// AlertDialog умеет ровно три кнопки и молча отбрасывает остальные — включая
// хвостовую «Отмена» (см. док-комментарий ActionSheet.tsx).
//
// Переписывать 171 вызов ради косметики — значит переписать половину экранов и
// сломать то, что работает. Поэтому подменяется сам `Alert.alert`: он
// перенаправляется в ConfirmLayer (AppNotifyHost), который рисует ту же
// карточку в теме приложения и не имеет ограничения на три кнопки.
//
// Подмена делается один раз при монтировании хоста и снимается вместе с ним.
// Пока хост не смонтирован (ранний старт, тесты), `pushConfirm` возвращает
// false и вызов уходит в оригинальный системный Alert — поведение не теряется,
// а лишь становится запасным.
import { Alert, type AlertButton } from 'react-native';
import { pushConfirm } from './appNotify';

type AlertFn = typeof Alert.alert;

let original: AlertFn | null = null;

export function installThemedAlert(): void {
  if (original) return;
  original = Alert.alert.bind(Alert) as AlertFn;
  const native = original;
  Alert.alert = ((title?: string, message?: string, buttons?: AlertButton[], options?: unknown) => {
    // Alert.alert(title) без кнопок рисует системную «OK» — повторяем явно,
    // иначе окно нечем будет закрыть.
    const list: AlertButton[] = buttons && buttons.length > 0 ? buttons : [{ text: 'OK', style: 'cancel' }];
    const shown = pushConfirm({
      title: title ?? '',
      message: message || undefined,
      actions: list.map((b) => ({
        label: b.text ?? 'OK',
        onPress: b.onPress ? () => { b.onPress?.(); } : undefined,
        destructive: b.style === 'destructive',
        cancel: b.style === 'cancel',
      })),
    });
    if (!shown) (native as (...a: unknown[]) => void)(title, message, buttons, options);
  }) as AlertFn;
}

export function uninstallThemedAlert(): void {
  if (!original) return;
  Alert.alert = original;
  original = null;
}
