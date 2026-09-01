import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { useTheme } from '../../../ThemeContext';
import { isGrpBigEmoji } from '../../groups-utils/emoji';
import { parseGroupFmtSegments } from '../../groups-utils/parseText';
import { MAX_RENDER_SEGMENTS, sanitizeBodyForRender } from '../../../utils/renderText';
import { accentOnFill, bubbleSurface, contrastingInk } from '../../../theme';
import { GrpSpoilerSpan } from './GrpSpoilerSpan';
import { openExternal } from '../../../utils/openExternal';

export function GrpFormattedText({ text, style, onMentionPress, isMe }: { text: string; style?: object; onMentionPress?: (name: string) => void; isMe?: boolean }): React.ReactElement {
  const { colors } = useTheme();
  // v4.32.352: в собственном пузыре заливка — `primary`, и палитровые цвета
  // на ней не работают: ссылка и упоминание давали 2.90:1 на тёмной теме и
  // 1.11:1 на светлой, а «@все» жёстким #e53935 — 1.21:1, то есть красное на
  // синем сливалось полностью. Отсчёт ведём от заливки, тон сохраняется.
  const alertBase = colors.error;
  // v4.32.411: белый на `primary` — инвариант `normalizeAccent`, но написан
  // он был руками; берём его тем же способом, что и везде.
  const onPrimary = contrastingInk(colors.primary);
  const bubble = useMemo(() => bubbleSurface(colors, !!isMe, 'group'), [colors, isMe]);
  const ink = useMemo(
    () =>
      isMe
        ? {
            link: accentOnFill(colors.accent, colors.primary, onPrimary),
            alert: accentOnFill(alertBase, colors.primary, onPrimary),
          }
        : { link: colors.accent, alert: alertBase },
    [isMe, colors.accent, colors.primary, alertBase, onPrimary]
  );
  // v4.32.327: чужой текст чистится ДО разбора и до показа. Хуки — выше любой
  // ранней ветки: «одни эмодзи» и «разметки нет» возвращаются ниже.
  const safe = useMemo(() => sanitizeBodyForRender(text), [text]);
  const segs = useMemo(() => parseGroupFmtSegments(safe), [safe]);
  if (isGrpBigEmoji(safe)) {
    return <Text style={{ fontSize: 52, textAlign: 'center' }}>{safe}</Text>;
  }
  const hasFormatting =
    segs.length <= MAX_RENDER_SEGMENTS &&
    segs.some((s) => s.bold || s.italic || s.code || s.url || s.mention || s.spoiler || s.strikethrough);
  if (!hasFormatting) return <Text style={style}>{safe}</Text>;
  return (
    <Text style={style}>
      {segs.map((seg, idx) =>
        seg.url ? (
          <Text key={idx} style={{ color: ink.link, textDecorationLine: 'underline' }} onPress={() => openExternal(seg.url, 'group_text_link')}>{seg.text}</Text>
        ) : seg.mention ? (
          <Text
            key={idx}
            style={{ color: seg.text === '@все' || seg.text === '@all' ? ink.alert : ink.link, fontWeight: '700' }}
            onPress={onMentionPress && seg.text !== '@все' && seg.text !== '@all' ? () => onMentionPress(seg.text.slice(1)) : undefined}
          >{seg.text}</Text>
        ) : seg.spoiler ? (
          <GrpSpoilerSpan key={idx} text={seg.text} style={style} host={bubble.fill} />
        ) : seg.strikethrough ? (
          <Text key={idx} style={{ textDecorationLine: 'line-through' }}>{seg.text}</Text>
        ) : seg.code ? <Text key={idx} style={{ fontFamily: 'monospace', backgroundColor: bubble.plate.fill, color: bubble.plate.ink.text, fontSize: 13 }}>{seg.text}</Text>
        : seg.bold ? <Text key={idx} style={{ fontWeight: '700' }}>{seg.text}</Text>
        : seg.italic ? <Text key={idx} style={{ fontStyle: 'italic' }}>{seg.text}</Text>
        : <Text key={idx}>{seg.text}</Text>
      )}
    </Text>
  );
}
