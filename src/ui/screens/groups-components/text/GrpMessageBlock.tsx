import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../../ThemeContext';
import { bubbleSurface } from '../../../theme';
import { GrpFormattedText } from './GrpFormattedText';

export function GrpMessageBlock({ text, baseStyle, onMentionPress, isMe }: { text: string; baseStyle?: object; onMentionPress?: (name: string) => void; isMe?: boolean }): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.411: та же врезка кода, что и в личной переписке, — и тот же дефект.
  const bubble = bubbleSurface(colors, !!isMe, 'group');
  const parts = text.split(/(```[\s\S]*?```)/);
  if (parts.length === 1) return <GrpFormattedText text={text} style={baseStyle} onMentionPress={onMentionPress} isMe={isMe} />;
  return (
    <View>
      {parts.map((part, idx) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const inner = part.slice(3, -3);
          const firstNl = inner.indexOf('\n');
          const code = firstNl > -1 ? inner.slice(firstNl + 1) : inner;
          return (
            <View key={idx} style={{ backgroundColor: bubble.plate.fill, borderRadius: 6, padding: 8, marginVertical: 4 }}>
              <Text style={{ fontFamily: 'monospace', fontSize: 12, color: bubble.plate.ink.text }}>{code.trim()}</Text>
            </View>
          );
        }
        if (!part) return null;
        return <GrpFormattedText key={idx} text={part} style={baseStyle} onMentionPress={onMentionPress} isMe={isMe} />;
      })}
    </View>
  );
}
