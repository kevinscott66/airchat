// @stable  Единая точка настройки defaults для всех кнопок приложения.
// v4.32.89: переключено с RNGH Pressable на core RN Pressable — RNGH-Pressable
// не доставлял onPress в top-level табах и пунктах «Ещё» (регрессия). Core
// Pressable работает везде, defaults (delayPressIn/Out=0) сохранены.
import React from 'react';
import { Pressable, type PressableProps } from 'react-native';

// delayPressIn/Out — legacy-совместимость со старым API core Pressable
type AppPressableProps = PressableProps & {
  delayPressIn?: number;
  delayPressOut?: number;
};

/**
 * AppPressable — обёртка над core RN Pressable с нулевыми delayPressIn/Out
 * по умолчанию (мгновенный отклик).
 */
export const AppPressable = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  AppPressableProps
>(function AppPressable({ delayPressIn = 0, delayPressOut = 0, ...rest }, ref) {
  return (
    <Pressable
      ref={ref}
      {...({ delayPressIn, delayPressOut } as object)}
      {...(rest as object)}
    />
  );
});
