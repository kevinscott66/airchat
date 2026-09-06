/**
 * RichText — renders text with inline formatting:
 *   **bold**, *bold*, _italic_, `code`, ~~strikethrough~~, ||spoiler||, URLs, #hashtags
 *
 * Usage: <RichText text="Hello **world**!" style={styles.body} />
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { findEntities } from '../../core/text/entities';
import { MAX_RENDER_SEGMENTS, sanitizeBodyForRender } from '../utils/renderText';
import { useColors } from '../ThemeContext';
import { inkOn, mono, nestedFill, radius, searchMark, spoilerPlate, type TintedIcon } from '../theme';
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

const TOKEN_RE = /(\*\*(.+?)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|~~([^~]+)~~|\|\|([^|]+)\|\|)/gu;

/**
 * Ссылки, теги и упоминания внутри куска обычного текста.
 *
 * v4.32.605: три выражения — своё в ленте, своё в личных чатах, своё в
 * группах — заменены общим разбором (`core/text/entities`). Здесь было ровно
 * две ошибки: адрес забирал точку в конце предложения (`https://example.com.`
 * — хост с точкой, переход не срабатывает), а имя забирало её же
 * (`@bob.` → «bob.»), и такое упоминание не совпадало ни с кем.
 */
function withEntities(raw: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const e of findEntities(raw)) {
    if (e.start > pos) out.push({ kind: 'text', value: raw.slice(pos, e.start) });
    if (e.kind === 'url') out.push({ kind: 'url', value: e.text, href: e.text });
    else if (e.kind === 'hashtag') out.push({ kind: 'hashtag', value: e.text });
    else out.push({ kind: 'mention', value: e.text });
    pos = e.end;
  }
  if (out.length === 0) return [{ kind: 'text', value: raw }];
  if (pos < raw.length) out.push({ kind: 'text', value: raw.slice(pos) });
  return out;
}

function parse(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;

  // Разметка разбирается первой — как и до общего разбора сущностей: в
  // `**https://a.io**` побеждали звёздочки, и порядок здесь тот же.
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [full, , boldDouble, boldSingle, italic, code, strikethrough, spoiler] = match;
    const start = match.index;

    if (start > lastIndex) {
      segments.push(...withEntities(text.slice(lastIndex, start)));
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
    } else {
      segments.push({ kind: 'text', value: full });
    }

    lastIndex = start + full.length;
  }

  if (lastIndex < text.length) {
    segments.push(...withEntities(text.slice(lastIndex)));
  }

  return segments;
}

function SpoilerText({ value, style, host }: { value: string; style?: TextStyle | TextStyle[]; host: string }): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <Text style={style}>{value}</Text>;
  return (
    <Text
      style={[style as TextStyle, { backgroundColor: spoilerPlate(host), color: 'transparent', borderRadius: radius.sm }]}
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
              <Text key={i} style={{ fontFamily: mono, fontSize: 13, backgroundColor: codeFill, color: codeInk.text }}>
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
          // v4.32.605: без обработчика тег и имя рисуются обычным текстом.
          // Цветное слово, которое ничем не отвечает на нажатие, — обещание,
          // которого экран не держит.
          case 'hashtag':
            return onHashtagPress ? (
              <Text
                key={i}
                accessibilityRole="link"
                style={{ color: hashtagColor, fontWeight: '600' }}
                onPress={() => onHashtagPress(seg.value)}
              >
                {seg.value}
              </Text>
            ) : (
              <Text key={i}>{seg.value}</Text>
            );
          case 'mention':
            return onMentionPress ? (
              <Text
                key={i}
                accessibilityRole="link"
                style={{ color: linkColor, fontWeight: '600' }}
                onPress={() => onMentionPress(seg.value)}
              >
                {seg.value}
              </Text>
            ) : (
              <Text key={i}>{seg.value}</Text>
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
