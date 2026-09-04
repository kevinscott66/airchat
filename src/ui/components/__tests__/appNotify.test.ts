// Шина уведомлений: тост и диалог подтверждения приложения.
//
// v4.32.578: до этой версии showSuccess/showError на iOS звали системный
// Alert.alert, а на Android — ToastAndroid. Оба нарисованы не в теме
// приложения. Шина позволяет одному хосту (AppNotifyHost) перехватить все 489
// сообщений, не трогая их места вызова, — и именно это здесь проверяется:
// пока хост не смонтирован, вызов обязан честно сказать «не показал», чтобы
// вызывающий откатился на системное окно, а не потерял сообщение молча.
import {
  TOAST_MS,
  pushConfirm,
  pushToast,
  resetNotifyBus,
  setConfirmListener,
  setToastListener,
  type ConfirmSpec,
  type ToastSpec,
} from '../appNotify';

beforeEach(() => resetNotifyBus());

describe('шина уведомлений', () => {
  it('без хоста ничего не глотает — сообщает, что не показала', () => {
    expect(pushToast('success', 'готово')).toBe(false);
    expect(pushConfirm({ title: 'Удалить?', actions: [{ label: 'Ок' }] })).toBe(false);
  });

  it('с хостом доводит тост до него', () => {
    const seen: ToastSpec[] = [];
    setToastListener((t) => seen.push(t));
    expect(pushToast('error', 'не вышло')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].tone).toBe('error');
    expect(seen[0].message).toBe('не вышло');
  });

  it('каждый тост получает свой номер — иначе два одинаковых слипнутся в один', () => {
    const seen: ToastSpec[] = [];
    setToastListener((t) => seen.push(t));
    pushToast('success', 'сохранено');
    pushToast('success', 'сохранено');
    expect(seen).toHaveLength(2);
    expect(seen[0].id).not.toBe(seen[1].id);
  });

  it('ошибка висит дольше успеха: её надо успеть прочитать', () => {
    expect(TOAST_MS.error).toBeGreaterThan(TOAST_MS.success);
  });

  it('диалог доходит до хоста целиком, со всеми кнопками', () => {
    const seen: ConfirmSpec[] = [];
    setConfirmListener((c) => seen.push(c));
    const ok = pushConfirm({
      title: 'Удалить сообщение',
      actions: [
        { label: 'Удалить у себя', destructive: true },
        { label: 'Удалить у всех', destructive: true },
        { label: 'Отмена', cancel: true },
      ],
    });
    expect(ok).toBe(true);
    // Три кнопки — ровно тот предел, на котором нативный Android-диалог молча
    // терял хвост списка. Здесь не теряется.
    expect(seen[0].actions.map((a) => a.label)).toEqual([
      'Удалить у себя', 'Удалить у всех', 'Отмена',
    ]);
  });

  it('снятый хост возвращает вызовы системе, а не в пустоту', () => {
    setToastListener(() => {});
    expect(pushToast('success', 'раз')).toBe(true);
    setToastListener(null);
    expect(pushToast('success', 'два')).toBe(false);
  });
});
