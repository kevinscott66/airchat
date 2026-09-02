/**
 * Жест «Назад»: протянуть слева направо по середине экрана (v4.32.540).
 *
 * До этой версии вернуться назад можно было только кнопкой в шапке — то есть
 * дотянувшись до верхнего левого угла. На iOS системного жеста тут нет: он
 * принадлежит стековому навигатору, а экраны здесь переключаются состоянием.
 *
 * Что здесь важно и почему сделано именно так.
 *
 * Полоса. Жест ловится не по всему стеклу, а по средней части: сверху шапки и
 * «остров», снизу таббар и полоса жестов системы — начинать там значит
 * спорить и с ними, и с горизонтальными лентами историй. Полоса задана долями
 * высоты, а не точками: у SE и у Max это разные экраны.
 *
 * Ответственность. Ставится `onMoveShouldSetPanResponder`, а НЕ `Capture`:
 * захват отбирал бы касание у списков и полей ввода ещё до того, как станет
 * понятно, куда ведут пальцем. Тут наоборот — сначала палец должен пройти
 * порог именно вбок, и лишь тогда жест забирает ответственность. Вертикальная
 * прокрутка при этом не страдает: она забирает касание раньше и по-своему.
 *
 * Куда ведёт. В общий стек `backStack` — тот же, куда кладёт колбэки
 * `useBackHandler`. Поэтому жест закрывает ровно то, что закрыла бы системная
 * кнопка на Android: сначала верхнюю модалку, потом подэкран, потом вкладку.
 * Если возвращаться некуда, жест ничего не делает: приложение по нему НЕ
 * закрывается — свайпы случайны, а выход из приложения необратим.
 */
import React, { useMemo } from 'react';
import { PanResponder, StyleSheet, View, type ViewProps } from 'react-native';
import { runBackHandlers } from '../../core/hooks/backStack';

/** Порог по горизонтали, после которого жест считается намеренным (точки). */
const DX_THRESHOLD = 28;
/** Допустимый увод по вертикали на этом пороге: больше — это прокрутка. */
const DY_TOLERANCE = 22;
/** Средняя часть экрана: от какой и до какой доли высоты ловим жест. */
const BAND_TOP = 0.18;
const BAND_BOTTOM = 0.82;

export function SwipeBackHost({ children, style, ...rest }: ViewProps): React.ReactElement {
  const [height, setHeight] = React.useState(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (evt, g) => {
          if (height <= 0) return false;
          const y = evt.nativeEvent.locationY;
          if (y < height * BAND_TOP || y > height * BAND_BOTTOM) return false;
          // Только слева направо, только заметно вбок и почти без наклона.
          return g.dx > DX_THRESHOLD && Math.abs(g.dy) < DY_TOLERANCE && g.dx > Math.abs(g.dy) * 2;
        },
        onPanResponderRelease: () => {
          runBackHandlers();
        },
        // Ответственность могла уйти системе (шторка, Control Center) —
        // тогда жест не наш, и делать по нему ничего не надо.
        onPanResponderTerminationRequest: () => true,
      }),
    [height],
  );

  return (
    <View
      style={[styles.host, style]}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      {...responder.panHandlers}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
});

export default SwipeBackHost;
