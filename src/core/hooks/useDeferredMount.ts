import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

/**
 * Крайний срок монтирования, если очередь взаимодействий не опустеет.
 * Заметно длиннее анимации открытия модалки (~200 мс), чтобы в обычном случае
 * срабатывал именно InteractionManager, а таймер оставался страховкой.
 */
const MOUNT_DEADLINE_MS = 400;

/**
 * Возвращает true не сразу после `visible=true`, а после завершения анимаций
 * (InteractionManager.runAfterInteractions). Нужен для отложенного монтирования
 * тяжёлого содержимого модалок — оболочка появляется в кадре клика, тяжёлое
 * тело рендерится после открытия, не блокируя анимацию входа.
 *
 * v4.32.356: рядом стоит крайний срок. Очередь взаимодействий считается пустой
 * только когда возвращены ВСЕ выданные handle, а выдают их анимации, жесты и
 * навигация; потерянный handle (прерванный жест, анимация, которую сняли на
 * полпути) держит очередь занятой до конца жизни экрана. Тогда
 * runAfterInteractions не вызывается никогда — а здесь от него зависит всё
 * содержимое модалки, и пользователь смотрит на пустую оболочку без единого
 * способа что-то с этим сделать. Таймер закрывает этот случай.
 */
export function useDeferredMount(visible: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    const handle = InteractionManager.runAfterInteractions(() => setMounted(true));
    const deadline = setTimeout(() => setMounted(true), MOUNT_DEADLINE_MS);
    return () => {
      handle.cancel();
      clearTimeout(deadline);
    };
  }, [visible]);
  return mounted;
}
