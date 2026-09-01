/**
 * Markdown-lite + URL segmentation (D.3.1 extract).
 */
const URL_REGEX = /https?:\/\/[^\s]+/g;

export type TextSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
  spoiler?: boolean;
  strikethrough?: boolean;
};

export function parseFormattedSegments(raw: string): TextSegment[] {
  // First split by URLs, then parse markdown within non-URL parts
  const urlMatches: { start: number; end: number; url: string }[] = [];
  let m: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(raw)) !== null) {
    urlMatches.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
  }

  if (urlMatches.length === 0) return parseMd(raw);

  const result: TextSegment[] = [];
  let pos = 0;
  for (const { start, end, url } of urlMatches) {
    if (start > pos) result.push(...parseMd(raw.slice(pos, start)));
    result.push({ text: url, url });
    pos = end;
  }
  if (pos < raw.length) result.push(...parseMd(raw.slice(pos)));
  return result;
}

export function parseMd(raw: string): TextSegment[] {
  const result: TextSegment[] = [];
  let i = 0; let cur = '';
  while (i < raw.length) {
    if (raw[i] === '|' && raw[i + 1] === '|') {
      if (cur) { result.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('||', i + 2);
      if (end > i) { result.push({ text: raw.slice(i + 2, end), spoiler: true }); i = end + 2; }
      else { cur += raw[i++]; }
    } else if (raw[i] === '`') {
      if (cur) { result.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('`', i + 1);
      if (end > i) { result.push({ text: raw.slice(i + 1, end), code: true }); i = end + 1; }
      else { cur += raw[i++]; }
    } else if (raw[i] === '~' && raw[i + 1] === '~') {
      if (cur) { result.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('~~', i + 2);
      if (end > i) { result.push({ text: raw.slice(i + 2, end), strikethrough: true }); i = end + 2; }
      else { cur += raw[i++]; }
    } else if (raw[i] === '*' && raw[i + 1] === '*') {
      if (cur) { result.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('**', i + 2);
      if (end > i) { result.push({ text: raw.slice(i + 2, end), bold: true }); i = end + 2; }
      else { cur += raw[i++]; }
    } else if (raw[i] === '_') {
      if (cur) { result.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('_', i + 1);
      if (end > i) { result.push({ text: raw.slice(i + 1, end), italic: true }); i = end + 1; }
      else { cur += raw[i++]; }
    } else { cur += raw[i++]; }
  }
  if (cur) result.push({ text: cur });
  return result;
}
