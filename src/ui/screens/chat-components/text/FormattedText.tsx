import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { useTheme } from '../../../ThemeContext';
import { parseFormattedSegments } from '../../chat-utils/parseText';
import { MAX_RENDER_SEGMENTS, sanitizeBodyForRender } from '../../../utils/renderText';
import { accentOnFill } from '../../../theme';
import { SpoilerSpan } from './SpoilerSpan';
import { useBubbleSurface } from '../../../BubbleKindContext';
import { openExternal } from '../../../utils/openExternal';

export function FormattedText({
  text,
  style,
  numberOfLines,
  isOutgoing,
}: {
  text: string;
  style?: object;
  numberOfLines?: number;
  isOutgoing?: boolean;
}): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.411: подложка `code`-врезки задавалась серым под 20 % — она не
  // зависела от пузыря, а буквы на ней брались из стиля сообщения. В своём
  // пузыре получалось светлое по светлому.
  const bubble = useBubbleSurface(!!isOutgoing);
  // v4.32.352: в исходящем пузыре ссылка лежит на заливке bubbleOut, а не на
  // фоне страницы, под который подобран `accent`. На светлой теме это было
  // 1.11:1 — ссылку в собственном сообщении не видно. Пересчёт цикличный,
  // поэтому под useMemo: за кадр сообщений на экране десятки.
  const linkColor = useMemo(
    () =>
      isOutgoing
        ? accentOnFill(colors.accent, colors.bubbleOut, colors.bubbleOutText)
        : colors.accent,
    [isOutgoing, colors.accent, colors.bubbleOut, colors.bubbleOutText]
  );
  // v4.32.327: чужой текст чистится ДО разбора и до показа — в том числе на
  // ветке «разметки нет», которая раньше рисовала пришедшую строку как есть.
  const safe = useMemo(() => sanitizeBodyForRender(text), [text]);
  const segments = useMemo(() => parseFormattedSegments(safe), [safe]);
  const hasFormatting =
    segments.length <= MAX_RENDER_SEGMENTS &&
    segments.some((s) => s.bold || s.italic || s.code || s.url || s.spoiler || s.strikethrough);
  if (!hasFormatting) {
    return <Text style={style} numberOfLines={numberOfLines}>{safe}</Text>;
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((seg, idx) =>
        seg.url ? (
          <Text
            key={idx}
            style={{ color: linkColor, textDecorationLine: 'underline' }}
            onPress={() => openExternal(seg.url, 'chat_text_link')}
          >
            {seg.text}
          </Text>
        ) : seg.code ? (
          <Text key={idx} style={{ fontFamily: 'monospace', backgroundColor: bubble.plate.fill, color: bubble.plate.ink.text, fontSize: 13 }}>{seg.text}</Text>
        ) : seg.spoiler ? (
          <SpoilerSpan key={idx} text={seg.text} style={style} host={bubble.fill} />
        ) : seg.strikethrough ? (
          <Text key={idx} style={{ textDecorationLine: 'line-through' }}>{seg.text}</Text>
        ) : seg.bold && seg.italic ? (
          <Text key={idx} style={{ fontWeight: '700', fontStyle: 'italic' }}>{seg.text}</Text>
        ) : seg.bold ? (
          <Text key={idx} style={{ fontWeight: '700' }}>{seg.text}</Text>
        ) : seg.italic ? (
          <Text key={idx} style={{ fontStyle: 'italic' }}>{seg.text}</Text>
        ) : (
          <Text key={idx}>{seg.text}</Text>
        )
      )}
    </Text>
  );
}
