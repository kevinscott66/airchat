/**
 * Строка сообщения, которую можно смахнуть: вправо — ответить, влево — в
 * избранное.
 *
 * Компонент объявлен на уровне модуля, и это здесь главное. В GroupsScreen он
 * жил внутри экрана — `const GrpSwipeRow = useCallback(({ item, children }) =>
 * …, [setReplyTo, loadMessages])` — и при этом заводил внутри себя хуки
 * (`useRef` на анимацию и на PanResponder), из-за чего рядом стояли два
 * `eslint-disable react-hooks/rules-of-hooks`. Отключённое правило было не
 * придиркой: useCallback не делает объявление компонентом уровня модуля, он
 * лишь реже меняет его identity. А `loadMessages` в зависимостях пересоздаётся
 * при каждом изменении `group.unreadCount` — то есть прямо во время
 * переписки. На каждое такое изменение React видел новый ТИП компонента и
 * перемонтировал всю ленту: сбрасывалась анимация свайпа (в том числе посреди
 * жеста) и пересоздавался PanResponder.
 *
 * Пропсы могут меняться сколько угодно — перемонтирования это не вызывает.
 * Поэтому обработчики приходят пропсами, а не замыканием.
 */
import React, { useRef } from 'react';
import { Animated as RNAnimated, PanResponder, Vibration } from 'react-native';

/** За сколько точек жест считается смахиванием, а не промахом по списку. */
const TRIGGER = 50;
/** Докуда строка вообще едет за пальцем. */
const LIMIT = 80;

export type SwipeRowProps = {
  children: React.ReactNode;
  /** Смахнули вправо. */
  onReply: () => void;
  /** Смахнули влево. */
  onStar: () => void;
};

export function SwipeRow({ children, onReply, onStar }: SwipeRowProps): React.ReactElement {
  const swipeAnim = useRef(new RNAnimated.Value(0)).current;

  // Обработчики держатся в ref: PanResponder создаётся один раз на жизнь
  // строки и иначе замкнул бы на себе самые первые колбэки.
  const handlers = useRef({ onReply, onStar });
  handlers.current = { onReply, onStar };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0 && g.dx < LIMIT) swipeAnim.setValue(g.dx);
        else if (g.dx < 0 && g.dx > -LIMIT) swipeAnim.setValue(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > TRIGGER) {
          Vibration.vibrate(20);
          handlers.current.onReply();
        } else if (g.dx < -TRIGGER) {
          Vibration.vibrate(20);
          handlers.current.onStar();
        }
        RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(swipeAnim, { toValue: 0, useNativeDriver: true, tension: 200, friction: 20 }).start();
      },
    })
  ).current;

  return (
    <RNAnimated.View style={{ transform: [{ translateX: swipeAnim }] }} {...panResponder.panHandlers}>
      {children}
    </RNAnimated.View>
  );
}
