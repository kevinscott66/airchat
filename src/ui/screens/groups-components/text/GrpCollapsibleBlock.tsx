import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../../ThemeContext';
import { bubbleSurface } from '../../../theme';
import { GrpMessageBlock } from './GrpMessageBlock';

const GRP_COLLAPSE_THRESHOLD = 500;

/** Long group messages are collapsed with a "Показать больше" toggle. */
export function GrpCollapsibleBlock({ text, baseStyle, isMe, onMentionPress }: { text: string; baseStyle?: object; isMe?: boolean; onMentionPress?: (name: string) => void }): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.411: в групповом пузыре хуже, чем в личном: он залит выбранным
  // акцентом, и белый под 70 % давал 2.84:1 на «малиновом».
  const bubble = bubbleSurface(colors, !!isMe, 'group');
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > GRP_COLLAPSE_THRESHOLD;
  if (!isLong || expanded) {
    return (
      <View>
        <GrpMessageBlock text={text} baseStyle={baseStyle} onMentionPress={onMentionPress} isMe={isMe} />
        {isLong && expanded ? (
          <Text
            style={{ color: bubble.icon, fontSize: 13, marginTop: 4, paddingHorizontal: 12, paddingBottom: 4 }}
            onPress={() => setExpanded(false)}
          >Свернуть ↑</Text>
        ) : null}
      </View>
    );
  }
  const preview = text.slice(0, GRP_COLLAPSE_THRESHOLD);
  return (
    <View>
      <GrpMessageBlock text={preview + '…'} baseStyle={baseStyle} onMentionPress={onMentionPress} isMe={isMe} />
      <Text
        style={{ color: bubble.icon, fontSize: 13, marginTop: 4, paddingHorizontal: 12, paddingBottom: 4 }}
        onPress={() => setExpanded(true)}
      >Показать больше ↓</Text>
    </View>
  );
}
