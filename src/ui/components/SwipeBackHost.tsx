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
 * Куда ведёт. Слева направо — в общий стек `backStack` — тот же, куда кладёт колбэки
 * `useBackHandler`. Поэтому жест закрывает ровно то, что закрыла бы системная
 * кнопка на Android: сначала верхнюю модалку, потом подэкран, потом вкладку.
 * Если возвращаться некуда, жест ничего не делает: приложение по нему НЕ
 * закрывается — свайпы случайны, а выход из приложения необратим.
 *
 * Вкладки (v4.32.575). Тот же жест ходит по нижней панели: справа налево —
 * следующая вкладка, слева направо — предыдущая, но только когда возвращаться
 * уже некуда. Порядок приоритетов именно такой: закрыть открытое важнее, чем
 * сменить раздел, — иначе свайп из переписки уносил бы из неё вместо возврата
 * к списку. Края панели не заворачиваются: за «Ещё» и перед «Новостями»
 * ничего нет, и жест там просто ничего не делает.
 */
import React, { useMemo } from 'react';
import { PanResponder, StyleSheet, View, type ViewProps } from 'react-native';
import { runBackHandlers } from '../../core/hooks/backStack';
import { claimsSwipe, swipeStep } from './swipeBackGesture';
import type { TabStep } from '../tabOrder';

export type { TabStep };

type SwipeBackHostProps = ViewProps & {
  /**
   * Переход на соседнюю вкладку. Хост только распознаёт жест и говорит, в
   * какую сторону вели; решает, можно ли идти и куда именно, вызывающий.
   */
  onTabStep?: (step: TabStep) => void;
};

export function SwipeBackHost({
  children,
  style,
  onTabStep,
  ...rest
}: SwipeBackHostProps): React.ReactElement {
  const [height, setHeight] = React.useState(0);
  // Колбэк живёт в ref, а не в зависимостях: пересобранный на каждый render
  // PanResponder терял бы жест ровно в тот момент, когда палец уже ведёт.
  const tabStepRef = React.useRef(onTabStep);
  tabStepRef.current = onTabStep;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (evt, g) =>
          claimsSwipe({
            dx: g.dx,
            dy: g.dy,
            y: evt.nativeEvent.locationY,
            height,
            canStepTabs: tabStepRef.current != null,
          }),
        onPanResponderRelease: (_evt, g) => {
          const step = swipeStep(g.dx);
          // Справа налево: «Назад» тут ни при чём, это шаг вперёд по панели.
          // Слева направо: сначала «Назад» — закрыть модалку или подэкран
          // важнее, чем сменить вкладку, — и только если возвращаться некуда,
          // жест уводит на предыдущую вкладку.
          if (step < 0 && runBackHandlers()) return;
          tabStepRef.current?.(step);
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
