/**
 * SendEffectOverlay — салют из эмодзи над лентой при отправке сообщения.
 *
 * v4.32.534. Эффект жил в ChatScreen.tsx, а запускали его двое: диалог и
 * группы. Второму приходилось импортировать анимацию из чужого экрана — вся
 * связь между экранами держалась на этих трёх символах.
 *
 * Ни таймингов, ни разбора триггеров не менялось. `SEND_EFFECT_TRIGGERS`
 * больше не публичен: наружу его никто не читал, только `detectSendEffect`
 * строкой ниже.
 */
import React, { useEffect, useRef } from 'react';
import { View, Dimensions, Animated as RNAnimated } from 'react-native';

const SEND_EFFECT_TRIGGERS: Record<string, string[]> = {
  '🎉': ['🎉', '🎊', '✨', '🎉', '🎊', '✨', '🎉', '🎊', '✨', '🎉'],
  '🎊': ['🎊', '🎉', '✨', '🎊', '🎉', '✨', '🎊', '🎉', '✨', '🎊'],
  '❤️': ['❤️', '💕', '💖', '❤️', '💕', '💗', '❤️', '💖', '💕', '❤️'],
  '💕': ['💕', '❤️', '💖', '💕', '💗', '💘', '💕', '💖', '❤️', '💕'],
  '🔥': ['🔥', '🔥', '💥', '🔥', '🔥', '✨', '🔥', '💥', '🔥', '🔥'],
  '🎂': ['🎂', '🎈', '🎉', '🎁', '🎈', '🎊', '🎂', '🎈', '✨', '🎉'],
  '👏': ['👏', '👏', '⭐', '👏', '⭐', '👏', '👏', '⭐', '👏', '✨'],
  '🥳': ['🥳', '🎉', '🎊', '🥳', '✨', '🎉', '🎊', '🥳', '🎈', '✨'],
};

export function detectSendEffect(text: string): string[] | null {
  for (const [trigger, particles] of Object.entries(SEND_EFFECT_TRIGGERS)) {
    if (text.includes(trigger)) return particles;
  }
  return null;
}

export function SendEffectOverlay({ particles, onDone }: { particles: string[]; onDone: () => void }): React.ReactElement {
  const { width: SW, height: SH } = Dimensions.get('window');
  const anims = useRef(particles.map(() => ({
    y: new RNAnimated.Value(0),
    x: new RNAnimated.Value(0),
    opacity: new RNAnimated.Value(1),
    scale: new RNAnimated.Value(0.5),
  }))).current;
  // v4.32.124 (AUDIT P0 #9): capture onDone via ref so the animation's
  // completion callback always calls the latest parent handler, even though
  // the effect intentionally runs once (empty deps). Without this, a re-
  // render of the parent with a different `onDone` leaves the animation
  // calling a stale closure at completion.
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    const animations = anims.map((a, i) => {
      const delay = i * 60;
      const xTarget = (Math.random() - 0.5) * SW * 0.8;
      const yTarget = -(SH * 0.5 + Math.random() * SH * 0.3);
      return RNAnimated.sequence([
        RNAnimated.delay(delay),
        RNAnimated.parallel([
          RNAnimated.spring(a.scale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 8 }),
          RNAnimated.timing(a.y, { toValue: yTarget, duration: 900, useNativeDriver: true }),
          RNAnimated.timing(a.x, { toValue: xTarget, duration: 900, useNativeDriver: true }),
          RNAnimated.sequence([
            RNAnimated.delay(400),
            RNAnimated.timing(a.opacity, { toValue: 0, duration: 500, useNativeDriver: true }),
          ]),
        ]),
      ]);
    });
    RNAnimated.stagger(40, animations).start(() => onDoneRef.current());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 80, left: SW / 2, zIndex: 9999 }}>
      {anims.map((a, i) => (
        <RNAnimated.Text
          key={i}
          style={{
            position: 'absolute',
            fontSize: 28,
            transform: [{ translateX: a.x }, { translateY: a.y }, { scale: a.scale }],
            opacity: a.opacity,
          }}
        >
          {particles[i]}
        </RNAnimated.Text>
      ))}
    </View>
  );
}
