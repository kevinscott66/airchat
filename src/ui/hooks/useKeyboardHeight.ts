// src/ui/hooks/useKeyboardHeight.ts
//
// v4.32.103 K.9: ручной listener на Keyboard.addListener — возвращает текущую высоту
// клавиатуры. Используется как замена KeyboardAvoidingView там, где KAV не работает:
//   • внутри <Modal/> на Android (Modal имеет своё native-окно, adjustResize не
//     наследуется, KAV behavior="padding" иногда не получает keyboard-event);
//   • когда нужен точный контроль paddingBottom на конкретном View (а не на обёртке).
//
// Использование:
//   const kb = useKeyboardHeight();
//   <View style={{ paddingBottom: kb }}>...</View>
//
// На iOS используем keyboardWillShow/Hide (анимация синхронизирована с клавиатурой).
// На Android — keyboardDidShow/Hide (Will-события не диспатчатся Android'ом).

import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvt, (e) => {
      // v4.32.107 K.11d: на некоторых Android ROMs (ColorOS/Realme) endCoordinates.height
      // содержит Y-координату верха клавиатуры, а не её высоту — композер улетал в верх
      // экрана. Надёжнее вычислять height через (screenHeight - screenY). screenY — это
      // Y-позиция верхнего края клавиатуры в координатах окна.
      const ec = e.endCoordinates;
      const reportedHeight = ec?.height ?? 0;
      const screenY = ec?.screenY;
      const winHeight = Dimensions.get('window').height;
      let h = reportedHeight;
      if (Platform.OS === 'android' && typeof screenY === 'number' && screenY > 0) {
        const derivedHeight = Math.max(0, winHeight - screenY);
        // Если reportedHeight сильно больше вывода из screenY — используем screenY-derived.
        if (Math.abs(derivedHeight - reportedHeight) > 50) {
          h = derivedHeight;
        }
      }
      setHeight(h);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => {
      setHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}
