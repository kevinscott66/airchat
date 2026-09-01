/**
 * Markdown-lite + URL/mention segmentation for GroupsScreen (D.4.1 extract).
 */

export type GrpSeg = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
  mention?: boolean;
  spoiler?: boolean;
  strikethrough?: boolean;
};

export function parseGrpMd(raw: string): GrpSeg[] {
  const r: GrpSeg[] = []; let i = 0; let cur = '';
  while (i < raw.length) {
    if (raw[i] === '|' && raw[i + 1] === '|') {
      if (cur) { r.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('||', i + 2);
      if (end > i) { r.push({ text: raw.slice(i + 2, end), spoiler: true }); i = end + 2; } else { cur += raw[i++]; }
    } else if (raw[i] === '`') {
      if (cur) { r.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('`', i + 1);
      if (end > i) { r.push({ text: raw.slice(i + 1, end), code: true }); i = end + 1; } else { cur += raw[i++]; }
    } else if (raw[i] === '~' && raw[i + 1] === '~') {
      if (cur) { r.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('~~', i + 2);
      if (end > i) { r.push({ text: raw.slice(i + 2, end), strikethrough: true }); i = end + 2; } else { cur += raw[i++]; }
    } else if (raw[i] === '*' && raw[i + 1] === '*') {
      if (cur) { r.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('**', i + 2);
      if (end > i) { r.push({ text: raw.slice(i + 2, end), bold: true }); i = end + 2; } else { cur += raw[i++]; }
    } else if (raw[i] === '_') {
      if (cur) { r.push({ text: cur }); cur = ''; }
      const end = raw.indexOf('_', i + 1);
      if (end > i) { r.push({ text: raw.slice(i + 1, end), italic: true }); i = end + 1; } else { cur += raw[i++]; }
    } else { cur += raw[i++]; }
  }
  if (cur) r.push({ text: cur });
  return r;
}

export function parseGroupFmtSegments(raw: string): GrpSeg[] {
  const SPECIAL_REGEX = /https?:\/\/[^\s]+|@[\w\u0400-\u04FF]+/g;
  const matches: { start: number; end: number; url?: string; mention?: boolean }[] = [];
  let m: RegExpExecArray | null;
  SPECIAL_REGEX.lastIndex = 0;
  while ((m = SPECIAL_REGEX.exec(raw)) !== null) {
    const text = m[0];
    if (text.startsWith('@')) {
      matches.push({ start: m.index, end: m.index + text.length, mention: true });
    } else {
      matches.push({ start: m.index, end: m.index + text.length, url: text });
    }
  }
  if (matches.length === 0) return parseGrpMd(raw);
  const result: GrpSeg[] = []; let pos = 0;
  for (const match of matches) {
    if (match.start > pos) result.push(...parseGrpMd(raw.slice(pos, match.start)));
    if (match.url) result.push({ text: match.url, url: match.url });
    else result.push({ text: raw.slice(match.start, match.end), mention: true });
    pos = match.end;
  }
  if (pos < raw.length) result.push(...parseGrpMd(raw.slice(pos)));
  return result;
}
