import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { MessageBlock } from './MessageBlock';
import { useBubbleSurface } from '../../../BubbleKindContext';

const COLLAPSE_CHAR_THRESHOLD = 500;
// const COLLAPSE_LINE_LIMIT = 8;

/** Long messages are collapsed with a "Показать больше" toggle. */
export function CollapsibleMessageBlock({ text, baseStyle, isOutgoing }: { text: string; baseStyle?: object; isOutgoing?: boolean }): React.ReactElement {
  // v4.32.411: «Показать больше» в своём пузыре писалось белым под 70 % —
  // 3.40:1 в светлой теме при пороге 4.5. Считаем от заливки пузыря.
  const bubble = useBubbleSurface(!!isOutgoing);
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > COLLAPSE_CHAR_THRESHOLD;
  if (!isLong || expanded) {
    return (
      <View>
        <MessageBlock text={text} baseStyle={baseStyle} isOutgoing={isOutgoing} />
        {isLong && expanded ? (
          <Text
            style={{ color: bubble.icon, fontSize: 13, marginTop: 4 }}
            onPress={() => setExpanded(false)}
          >Свернуть ↑</Text>
        ) : null}
      </View>
    );
  }
  // Collapsed: truncate to COLLAPSE_LINE_LIMIT visual lines by slicing characters heuristically
  const preview = text.slice(0, COLLAPSE_CHAR_THRESHOLD);
  return (
    <View>
      <MessageBlock text={preview + '…'} baseStyle={baseStyle} isOutgoing={isOutgoing} />
      <Text
        style={{ color: bubble.icon, fontSize: 13, marginTop: 4 }}
        onPress={() => setExpanded(true)}
      >Показать больше ↓</Text>
    </View>
  );
}
