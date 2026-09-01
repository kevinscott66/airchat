/**
 * Skeleton loading placeholder — анимированный блок для имитации загружаемого контента.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useColors, useThemedStyles } from '../ThemeContext';

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
      borderRadius: 8,
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
      borderRadius: 12,
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
