import React from 'react';
import { Text, View } from 'react-native';
import { FormattedText } from './FormattedText';
import { useBubbleSurface } from '../../../BubbleKindContext';

/** Splits text by fenced code blocks (``` ... ```) and renders each part appropriately. */
export function MessageBlock({ text, baseStyle, isOutgoing }: { text: string; baseStyle?: object; isOutgoing?: boolean }): React.ReactElement {
  // v4.32.411: врезка кода заливалась 'rgba(0,0,0,0.25)', а текст в ней брался
  // из палитры. В светлой теме внутри СВОЕГО пузыря это тёмное по тёмному:
  // подложка уходила в синий, а буквы оставались почти чёрными.
  const bubble = useBubbleSurface(!!isOutgoing);
  // Split on ``` boundaries
  const parts = text.split(/(```[\s\S]*?```)/);
  if (parts.length === 1) {
    return <FormattedText text={text} style={baseStyle} isOutgoing={isOutgoing} />;
  }
  return (
    <View>
      {parts.map((part, idx) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const inner = part.slice(3, -3);
          // Strip optional language hint on first line
          const firstNl = inner.indexOf('\n');
          const code = firstNl > -1 ? inner.slice(firstNl + 1) : inner;
          return (
            <View key={idx} style={{ backgroundColor: bubble.plate.fill, borderRadius: 6, padding: 8, marginVertical: 4 }}>
              <Text style={{ fontFamily: 'monospace', fontSize: 12, color: bubble.plate.ink.text }}>{code.trim()}</Text>
            </View>
          );
        }
        if (!part) return null;
        return <FormattedText key={idx} text={part} style={baseStyle} isOutgoing={isOutgoing} />;
      })}
    </View>
  );
}
