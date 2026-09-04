import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { AppModal } from './AppModal';
import { AppPressable } from './AppPressable';
import { GlassSurface } from './GlassSurface';
import { motion, radius, scrim, spacing } from '../theme';
import { isReducedMotion } from '../motionPrefs';
import { useBackHandler } from '../../core/hooks/useBackHandler';

/**
 * Нижний лист: затемнение проявляется, лист выезжает, и оба уходят обратно.
 *
 * v4.32.533. Раньше каждый такой лист писался на месте одинаковыми двадцатью
 * строками: `<Modal animationType="slide">`, `AppPressable` с `scrim.modal` во
 * весь экран, внутри второй `AppPressable` с `marginTop: 'auto'` — он же
 * гасил всплытие нажатия. Системная `animationType="slide"` двигает ВСЁ окно
 * модалки разом, вместе с затемнением: затемнение не проявляется, а
 * приезжает снизу вместе с листом, и уход происходит без анимации вовсе,
 * потому что React убирает окно в том же кадре, в котором `visible` стал
 * ложным.
 *
 * Поэтому окно здесь открыто чуть дольше, чем сам лист: `mounted` держит
 * `AppModal` до конца анимации ухода, и только потом лист снимается.
 * Открывается пружиной (жест «лист подтолкнули снизу»), закрывается временем:
 * уход не должен пружинить — его не тянут, его отпустили.
 *
 * Лист сделан стеклом, а не глухой панелью: это ровно тот случай, для которого
 * стекло и нужно — слой, под которым лежит произвольное содержимое экрана.
 * Читаемость на нём обеспечивает не размытие, а заливка `prominent` поверх.
 */
export function SheetShell({
  visible,
  onClose,
  children,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  testID?: string;
}): React.ReactElement | null {
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return;
    if (isReducedMotion()) {
      t.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const anim = visible
      ? Animated.spring(t, { toValue: 1, ...motion.spring, useNativeDriver: Platform.OS !== 'web' })
      : Animated.timing(t, {
          toValue: 0,
          duration: motion.base,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        });
    anim.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => anim.stop();
  }, [visible, mounted, t]);

  // Нажатие внутри листа не должно закрывать лист: внешний `AppPressable` —
  // это и есть «нажали мимо».
  const swallow = useCallback(() => {}, []);

  // «Назад» — жестом на iOS и системной кнопкой на Android — обязано закрывать
  // лист, а не то, что лежит под ним (v4.32.579). Раньше лист в стек `backStack`
  // не вставал вовсе: свайп по открытому листу пролистывал стек насквозь и
  // доходил до обработчика экрана — из карточки профиля, открытой в переписке,
  // это уносило прямо в список чатов, вместе с закрытым диалогом.
  const back = useCallback(() => {
    onClose();
    return true;
  }, [onClose]);
  useBackHandler(visible, back);

  if (!mounted) return null;

  return (
    <AppModal visible transparent animationType="none" onRequestClose={onClose} testID={testID}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: t }]}>
        <AppPressable noScale style={styles.scrim} onPress={onClose} accessibilityLabel="Закрыть" />
      </Animated.View>
      {/* `box-none` — не украшение, а условие того, что нажатие мимо листа
          вообще куда-то доходит (v4.32.579). Полка растянута на весь экран
          (`flex-end` прижимает лист к низу), лежит поверх затемнения и до этой
          версии забирала себе каждое касание над листом: обработчика у неё нет,
          у затемнения он есть, но затемнение ей не предок, а сосед — событию
          некуда было всплыть, и «нажал мимо» не закрывало ничего. */}
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.dock,
          { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] },
        ]}
      >
        <AppPressable noScale onPress={swallow}>
          <GlassSurface variant="prominent" style={styles.sheet}>
            {children}
          </GlassSurface>
        </AppPressable>
      </Animated.View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: scrim.modal },
  dock: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
  },
});
