/**
 * Markdown-lite + URL/упоминания в группах (D.4.1 extract).
 *
 * v4.32.605: своё выражение `https?:\/\/[^\s]+|@[\w\u0400-\u04FF]+` заменено
 * общим разбором (`core/text/entities`). Оно ошибалось дважды: забирало точку
 * и закрывающую скобку внутрь адреса, и считало упоминанием хвост почтового
 * адреса — `alice@bob.com` подсвечивался как `@bob`, хотя счётчик упоминаний
 * (`social/mentions`) такую границу как раз проверял. Подсветка и счётчик
 * теперь проверяют границу слова одинаково.
 */
import { findEntities } from '../../../core/text/entities';

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

/** Разметка ли это — то есть трогать ли внутренности сегмента. */
function isMarked(seg: GrpSeg): boolean {
  return !!(seg.bold || seg.italic || seg.code || seg.spoiler || seg.strikethrough);
}

/** Ссылки и упоминания внутри обычного текста. Теги в группах не открываются. */
function withEntities(raw: string): GrpSeg[] {
  const out: GrpSeg[] = [];
  let pos = 0;
  for (const e of findEntities(raw)) {
    if (e.kind === 'hashtag') continue;
    if (e.start > pos) out.push({ text: raw.slice(pos, e.start) });
    out.push(e.kind === 'url' ? { text: e.text, url: e.text } : { text: e.text, mention: true });
    pos = e.end;
  }
  if (out.length === 0) return [{ text: raw }];
  if (pos < raw.length) out.push({ text: raw.slice(pos) });
  return out;
}

export function parseGroupFmtSegments(raw: string): GrpSeg[] {
  // Разметка первой: `**@все**` — жирное слово, а не упоминание в звёздочках.
  const result: GrpSeg[] = [];
  for (const seg of parseGrpMd(raw)) {
    if (isMarked(seg)) { result.push(seg); continue; }
    result.push(...withEntities(seg.text));
  }
  return result;
}
