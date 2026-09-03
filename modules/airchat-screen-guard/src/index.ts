/**
 * Экранный щит: содержимое обёртки не попадает на снимок экрана и в запись
 * экрана, оставаясь видимым живому глазу (v4.32.570).
 *
 * Различие платформ здесь настоящее, и оно не прячется за общим именем:
 *  • iOS умеет скрыть кусок экрана — шапка переписки на снимке остаётся,
 *    сообщения пропадают. За это отвечает нативная вьюха, `isSupported()`
 *    возвращает true.
 *  • Android умеет только закрыть окно целиком (FLAG_SECURE): снимок или не
 *    делается, или выходит чёрным. Частичного скрытия нет, `isSupported()`
 *    отвечает false, а окно закрывается через `setWindowSecure`.
 *  • В сборке без нативной части (web, тесты) обёртка — обычный View, и
 *    `isSupported()` тоже false: обещания без исполнителя быть не должно.
 */
import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';

type ScreenGuardNative = {
  isSupported: () => boolean;
  setWindowSecure: (enabled: boolean) => Promise<void>;
};

const native = requireOptionalNativeModule<ScreenGuardNative | null>('AirChatScreenGuard');

/** Нативная вьюха берётся один раз и только там, где она есть. */
const NativeSecureView: React.ComponentType<ViewProps> | null = (() => {
  if (!native || Platform.OS !== 'ios') return null;
  try {
    return requireNativeViewManager<ViewProps>('AirChatScreenGuard');
  } catch {
    return null;
  }
})();

/** Скрывается ли содержимое обёртки со снимка на этом устройстве. */
export function isSecureContentSupported(): boolean {
  if (!native || !NativeSecureView) return false;
  try {
    return native.isSupported();
  } catch {
    return false;
  }
}

/**
 * Закрыть или открыть окно целиком. Смысл есть только на Android; на iOS и без
 * нативной части — тихо ничего.
 */
export async function setWindowSecure(enabled: boolean): Promise<void> {
  if (!native) return;
  try {
    await native.setWindowSecure(enabled);
  } catch {
    // Щит — не единственная защита переписки, и падать из-за него нечему.
  }
}

/**
 * Обёртка вокруг того, что не должно попасть на снимок. Там, где нативной
 * вьюхи нет, ведёт себя как обычный View: разметка не должна зависеть от того,
 * работает щит или нет.
 */
export const SecureContent: React.FC<ViewProps> = ({ children, ...rest }) => {
  const Comp = NativeSecureView ?? View;
  return React.createElement(Comp, rest, children);
};
