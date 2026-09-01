/**
 * RichText — renders text with inline formatting:
 *   **bold**, *bold*, _italic_, `code`, ~~strikethrough~~, ||spoiler||, URLs, #hashtags
 *
 * Usage: <RichText text="Hello **world**!" style={styles.body} />
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { MAX_RENDER_SEGMENTS, sanitizeBodyForRender } from '../utils/renderText';
import { useColors } from '../ThemeContext';
import { inkOn, nestedFill, searchMark, spoilerPlate, type TintedIcon } from '../theme';
import { openExternal } from '../utils/openExternal';

type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strikethrough'; value: string }
  | { kind: 'spoiler'; value: string }
  | { kind: 'url'; value: string; href: string }
  | { kind: 'hashtag'; value: string }
  | { kind: 'mention'; value: string };

const TOKEN_RE =
  /(\*\*(.+?)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|~~([^~]+)~~|\|\|([^|]+)\|\||(https?:\/\/[^\s<>[\]"'()]+)|(#[\wА-Яа-яЁёÀ-ÿ-]+)|(@[\wА-Яа-яЁёÀ-ÿ.]+))/gu;

function parse(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [full, , boldDouble, boldSingle, italic, code, strikethrough, spoiler, url, hashtag, mention] = match;
    const start = match.index;

    if (start > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, start) });
    }

    if (boldDouble) {
      segments.push({ kind: 'bold', value: boldDouble });
    } else if (boldSingle) {
      segments.push({ kind: 'bold', value: boldSingle });
    } else if (italic) {
      segments.push({ kind: 'italic', value: italic });
    } else if (code) {
      segments.push({ kind: 'code', value: code });
    } else if (strikethrough) {
      segments.push({ kind: 'strikethrough', value: strikethrough });
    } else if (spoiler) {
      segments.push({ kind: 'spoiler', value: spoiler });
    } else if (url) {
      segments.push({ kind: 'url', value: url, href: url });
    } else if (hashtag) {
      segments.push({ kind: 'hashtag', value: hashtag });
    } else if (mention) {
      segments.push({ kind: 'mention', value: mention });
    } else {
      segments.push({ kind: 'text', value: full });
    }

    lastIndex = start + full.length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

function SpoilerText({ value, style, host }: { value: string; style?: TextStyle | TextStyle[]; host: string }): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <Text style={style}>{value}</Text>;
  return (
    <Text
      style={[style as TextStyle, { backgroundColor: spoilerPlate(host), color: 'transparent', borderRadius: 3 }]}
      onPress={() => setRevealed(true)}
    >
      {value}
    </Text>
  );
}

type Props = {
  text: string;
  style?: TextStyle | TextStyle[];
  /** По умолчанию — акцент активной темы. */
  linkColor?: string;
  /** По умолчанию — акцент активной темы. */
  hashtagColor?: string;
  onHashtagPress?: (tag: string) => void;
  onMentionPress?: (mention: string) => void;
  numberOfLines?: number;
  /** Highlight occurrences of this substring (case-insensitive) */
  searchTerm?: string;
  /**
   * Заливка, на которой лежит текст. От неё считается плашка `код`:
   * v4.32.413 она была прибита как серая плёнка под 15 % — не зависящая ни от
   * темы, ни от карточки. На светлой карточке она давала 1.02–1.17:1, то есть
   * подложки под кодом фактически не было.
   */
  host?: string;
};

/** Split a plain string around occurrences of `term` (case-insensitive), returning React nodes */
function highlightText(value: string, term: string, mark: TintedIcon, baseStyle?: TextStyle | TextStyle[]): React.ReactNode {
  if (!term) return value;
  const parts: React.ReactNode[] = [];
  const lower = value.toLowerCase();
  const lowerTerm = term.toLowerCase();
  // v4.32.327: позиции ищутся в приведённой строке, а подсвечивается исходная —
  // значит длины обязаны совпадать. Для некоторых букв приведение к нижнему
  // регистру длину меняет (U+0130 «İ» превращается в два символа), и тогда
  // индексы разъезжаются: подсвечивался сдвинутый кусок, а хвост строки
  // пропадал вовсе. В таком редком случае ищем как есть, с учётом регистра.
  if (lower.length !== value.length || lowerTerm.length !== term.length) {
    return highlightExact(value, term, mark, baseStyle);
  }
  let cursor = 0;
  let idx: number;
  while ((idx = lower.indexOf(lowerTerm, cursor)) !== -1) {
    if (idx > cursor) parts.push(value.slice(cursor, idx));
    parts.push(
      <Text key={idx} style={[baseStyle as TextStyle, { backgroundColor: mark.fill, color: mark.ink }]}>
        {value.slice(idx, idx + term.length)}
      </Text>
    );
    cursor = idx + term.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
}

/** То же, но без приведения регистра — запасной путь highlightText. */
function highlightExact(value: string, term: string, mark: TintedIcon, baseStyle?: TextStyle | TextStyle[]): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx: number;
  while ((idx = value.indexOf(term, cursor)) !== -1) {
    if (idx > cursor) parts.push(value.slice(cursor, idx));
    parts.push(
      <Text key={idx} style={[baseStyle as TextStyle, { backgroundColor: mark.fill, color: mark.ink }]}>
        {value.slice(idx, idx + term.length)}
      </Text>
    );
    cursor = idx + term.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
}

export function RichText({
  text,
  style,
  linkColor: linkColorProp,
  hashtagColor: hashtagColorProp,
  onHashtagPress,
  onMentionPress,
  numberOfLines,
  searchTerm,
  host,
}: Props): React.ReactElement {
  const colors = useColors();
  const ground = host ?? colors.surface;
  const codeFill = nestedFill(ground);
  const codeInk = inkOn(colors, codeFill);
  // v4.32.417: подсветка найденного была парой литералов и не спрашивала, на
  // чём лежит; на белом пузыре светлой темы бледный янтарь давал 1.25:1.
  const mark = useMemo(() => searchMark(colors, ground), [colors, ground]);
  const linkColor = linkColorProp ?? colors.accent;
  const hashtagColor = hashtagColorProp ?? colors.accent;
  // v4.32.327: чужой текст чистится ДО разбора и до показа, разбор
  // запоминается — раньше он повторялся на каждый кадр анимации ленты.
  const safe = useMemo(() => sanitizeBodyForRender(text), [text]);
  const parsed = useMemo(() => parse(safe), [safe]);
  // Слишком дробная разметка рисуется как обычный текст: см. MAX_RENDER_SEGMENTS.
  const segments = useMemo<Segment[]>(
    () => (parsed.length > MAX_RENDER_SEGMENTS ? [{ kind: 'text', value: safe }] : parsed),
    [parsed, safe]
  );

  const handleUrl = useCallback((raw: string) => {
    openExternal(raw, 'rich_text_link');
  }, []);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'bold':
            return <Text key={i} style={{ fontWeight: '700' }}>{seg.value}</Text>;
          case 'italic':
            return <Text key={i} style={{ fontStyle: 'italic' }}>{seg.value}</Text>;
          case 'code':
            return (
              <Text key={i} style={{ fontFamily: 'monospace', fontSize: 13, backgroundColor: codeFill, color: codeInk.text }}>
                {seg.value}
              </Text>
            );
          case 'strikethrough':
            return (
              <Text key={i} style={{ textDecorationLine: 'line-through' }}>
                {seg.value}
              </Text>
            );
          case 'spoiler':
            return <SpoilerText key={i} value={seg.value} style={style} host={ground} />;
          case 'url':
            return (
              <Text
                key={i}
                accessibilityRole="link"
                style={{ color: linkColor, textDecorationLine: 'underline' }}
                onPress={() => handleUrl(seg.href)}
              >
                {seg.value}
              </Text>
            );
          case 'hashtag':
            return (
              <Text
                key={i}
                accessibilityRole={onHashtagPress ? 'link' : undefined}
                style={{ color: hashtagColor, fontWeight: '600' }}
                onPress={onHashtagPress ? () => onHashtagPress(seg.value) : undefined}
              >
                {seg.value}
              </Text>
            );
          case 'mention':
            return (
              <Text
                key={i}
                accessibilityRole={onMentionPress ? 'link' : undefined}
                style={{ color: linkColor, fontWeight: '600' }}
                onPress={onMentionPress ? () => onMentionPress(seg.value) : undefined}
              >
                {seg.value}
              </Text>
            );
          default:
            return (
              <Text key={i}>
                {searchTerm ? highlightText(seg.value, searchTerm, mark, style) : seg.value}
              </Text>
            );
        }
      })}
    </Text>
  );
}
