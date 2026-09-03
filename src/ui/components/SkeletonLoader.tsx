/**
 * Skeleton loading placeholder — анимированный блок для имитации загружаемого контента.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useColors, useThemedStyles } from '../ThemeContext';
import { radius } from '../theme';

type Props = {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: object;
};

export function SkeletonBlock({ width = '100%', height = 16, borderRadius = 6, style }: Props): React.ReactElement {
  const colors = useColors();
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: colors.surfaceHigh,
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Скелетон карточки поста в ленте. */
export function FeedPostSkeleton(): React.ReactElement {
  const skStyles = useThemedStyles((c) => ({
    card: {
      padding: 12,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    headerText: {
      flex: 1,
      marginLeft: 10,
      gap: 4,
    },
  }));

  return (
    <View style={skStyles.card}>
      <View style={skStyles.header}>
        <SkeletonBlock width={40} height={40} borderRadius={20} />
        <View style={skStyles.headerText}>
          <SkeletonBlock width="50%" height={14} />
          <SkeletonBlock width="30%" height={10} style={{ marginTop: 6 }} />
        </View>
      </View>
      <SkeletonBlock height={14} style={{ marginTop: 10 }} />
      <SkeletonBlock width="75%" height={14} style={{ marginTop: 6 }} />
    </View>
  );
}

/**
 * Скелетон строки списка чатов (v4.32.561).
 *
 * Список приходит из базы не мгновенно, а до этого он пуст — и на месте чатов
 * секунду висела надпись «Нет переписок» с советом добавить собеседника.
 * Человеку с сотней чатов приложение при каждом открытии сообщало, что чатов у
 * него нет. Размеры повторяют настоящую строку (аватар 48, отступы 16/12),
 * чтобы список не дёргался, когда данные доедут.
 */
export function ChatRowSkeleton(): React.ReactElement {
  const skStyles = useThemedStyles(() => ({
    row: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    body: { flex: 1, gap: 6 },
  }));

  return (
    <View style={skStyles.row}>
      <SkeletonBlock width={48} height={48} borderRadius={24} />
      <View style={skStyles.body}>
        <SkeletonBlock width="42%" height={15} />
        <SkeletonBlock width="68%" height={12} />
      </View>
    </View>
  );
}

/** Несколько строк подряд — заглушка всего списка, пока он читается. */
export function ChatListSkeleton({ count = 7 }: { count?: number }): React.ReactElement {
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        <ChatRowSkeleton key={i} />
      ))}
    </View>
  );
}

/** Скелетон пузыря сообщения. */
export function MessageSkeleton({ outgoing = false }: { outgoing?: boolean }): React.ReactElement {
  const skStyles = useThemedStyles((c) => ({
    bubbleRow: {
      flexDirection: 'row' as const,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    bubbleOut: { justifyContent: 'flex-end' as const },
    bubbleIn: { justifyContent: 'flex-start' as const },
    bubble: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: 10,
      gap: 4,
    },
  }));

  return (
    <View style={[skStyles.bubbleRow, outgoing ? skStyles.bubbleOut : skStyles.bubbleIn]}>
      <View style={[skStyles.bubble, { width: outgoing ? '60%' : '70%' }]}>
        <SkeletonBlock height={14} />
        <SkeletonBlock width="65%" height={14} style={{ marginTop: 6 }} />
      </View>
    </View>
  );
}
