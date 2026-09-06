/**
 * Markdown-lite + URL segmentation (D.3.1 extract).
 *
 * v4.32.605: ссылки искались своим выражением `https?:\/\/[^\s]+`, а
 * упоминания не искались вовсе. Выражение забирало точку и закрывающую скобку
 * внутрь адреса: подчёркнуто было `https://example.com.`, и открывалось тоже
 * оно — то есть не тот хост. Теперь разбор общий с лентой и группами
 * (`core/text/entities`), и имя в тексте стало сегментом, который умеет
 * открыть карточку.
 */
import { findEntities } from '../../../core/text/entities';

export type TextSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
  mention?: boolean;
  spoiler?: boolean;
  strikethrough?: boolean;
};

/** Разметка ли это — то есть трогать ли внутренности сегмента. */
function isMarked(seg: TextSegment): boolean {
  return !!(seg.bold || seg.italic || seg.code || seg.spoiler || seg.strikethrough);
}

/** Ссылки и упоминания внутри обычного текста. Теги в переписке не открываются. */
function withEntities(raw: string): TextSegment[] {
  const out: TextSegment[] = [];
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

export function parseFormattedSegments(raw: string): TextSegment[] {
  // Разметка разбирается первой: `**https://a.io**` — это жирный текст, а не
  // ссылка в звёздочках.
  const result: TextSegment[] = [];
  for (const seg of parseMd(raw)) {
    if (isMarked(seg)) { result.push(seg); continue; }
    result.push(...withEntities(seg.text));
  }
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
