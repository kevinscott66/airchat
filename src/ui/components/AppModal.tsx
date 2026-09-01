// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: drop-in замена React Native Modal, которая автоматически оборачивает
// children в <GestureHandlerRootView>. Без этого на Android RNGH-Pressable (наш
// AppPressable) внутри Modal не распознаёт касания — Modal создаёт отдельное
// native-окно вне корневого GestureHandlerRootView из App.tsx, и жестовый
// детектор RNGH не видит касания, `onPress` не срабатывает. Это и был баг
// v4.32.26 «Нажимаю Опубликовать и тишина».
//
// Использование: `<AppModal ...>` вместо `<Modal ...>`. Все props пробрасываются
// 1:1, плюс children автоматически заворачиваются в GestureHandlerRootView.
// Если надо стилизовать корневой контейнер внутри модалки — передайте
// `rootStyle` (по умолчанию flex:1).

import React from 'react';
import { Modal, ModalProps, StyleProp, ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export interface AppModalProps extends ModalProps {
  /** Стиль для GestureHandlerRootView-обёртки. По умолчанию `{ flex: 1 }`. */
  rootStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

const DEFAULT_ROOT_STYLE: ViewStyle = { flex: 1 };

export function AppModal({ rootStyle, children, ...modalProps }: AppModalProps): React.ReactElement {
  return (
    <Modal {...modalProps}>
      <GestureHandlerRootView style={rootStyle ?? DEFAULT_ROOT_STYLE}>
        {children}
      </GestureHandlerRootView>
    </Modal>
  );
}

export default AppModal;
