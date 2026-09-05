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
//
// v4.32.597: последним ребёнком идёт слой тоста. То же отдельное native-окно,
// из-за которого понадобился GestureHandlerRootView, оставляло за собой и
// уведомления приложения: «ID скопирован» выезжал ПОЗАДИ карточки профиля, из
// которой ID и копировали. Шина отдаёт сообщение верхнему слою — см.
// `addToastListener`, — поэтому тост показывает то окно, что сейчас на экране.
// Слой стоит только у ОТКРЫТОГО окна: на iOS закрытый Modal не размонтирует
// детей (Modal.js держит isRendered), и подписка закрытого окна перехватывала бы
// тосты в пустоту.

import React from 'react';
import { Modal, ModalProps, StyleProp, ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppToastLayer } from './AppToastLayer';

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
        {modalProps.visible === false ? null : <AppToastLayer overlay />}
      </GestureHandlerRootView>
    </Modal>
  );
}

export default AppModal;
