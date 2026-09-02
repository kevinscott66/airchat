import React from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Системные настройки «меньше движения» и «меньше прозрачности».
 *
 * v4.32.532: до этой версии `AccessibilityInfo` не вызывался нигде в `src`, и
 * пока анимаций почти не было — это никого не задевало. С появлением сжатия по
 * нажатию, выезжающих пузырей и стеклянных слоёв бездействие стало ошибкой:
 * человек, у которого от движения кружится голова, включает переключатель в
 * системе и вправе ожидать, что приложение его услышит.
 *
 * Подписка ровно одна на процесс, а не одна на элемент. AppPressable стоит в 76
 * файлах; вешать туда по слушателю на каждую кнопку — это сотни подписок на одно
 * булево значение. Поэтому значение живёт в модуле, читается синхронно в момент
 * нажатия, а React-хук нужен только тем, кому от смены настройки надо
 * перерисоваться (стеклу).
 */

let reducedMotion = false;
let reducedTransparency = false;
let installed = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function publish(): void {
  for (const fn of listeners) fn();
}

/** Значение на сейчас. Безопасно звать в обработчике нажатия. */
export function isReducedMotion(): boolean {
  return reducedMotion;
}

/** Значение на сейчас. */
export function isReducedTransparency(): boolean {
  return reducedTransparency;
}

/**
 * Подписаться на системные настройки один раз за запуск.
 * Зовётся из `index.ts` рядом с остальной установкой окружения.
 */
export function installMotionPrefs(): void {
  if (installed) return;
  installed = true;

  AccessibilityInfo.isReduceMotionEnabled()
    .then((v) => {
      reducedMotion = v;
      publish();
    })
    .catch(() => {
      // Настройка недоступна (веб, старая платформа) — считаем, что выключена.
    });
  AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) => {
    reducedMotion = v;
    publish();
  });

  if (typeof AccessibilityInfo.isReduceTransparencyEnabled === 'function') {
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => {
        reducedTransparency = v;
        publish();
      })
      .catch(() => {});
    AccessibilityInfo.addEventListener('reduceTransparencyChanged', (v: boolean) => {
      reducedTransparency = v;
      publish();
    });
  }
}

function useMotionPref(read: () => boolean): boolean {
  const [value, setValue] = React.useState(read);
  React.useEffect(() => {
    const fn = (): void => setValue(read());
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, [read]);
  return value;
}

/** Человек попросил систему уменьшить движение — анимации выключаются. */
export function useReducedMotion(): boolean {
  return useMotionPref(isReducedMotion);
}

/** Человек попросил систему уменьшить прозрачность — стекло становится плотным. */
export function useReducedTransparency(): boolean {
  return useMotionPref(isReducedTransparency);
}
