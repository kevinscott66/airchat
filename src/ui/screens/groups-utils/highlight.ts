/**
 * Text highlight helper for GroupsScreen search results (D.4.1 extract).
 */

/** Split text into highlighted and normal segments for search result display. */
export function highlightSegments(text: string, query: string): Array<{ text: string; match: boolean }> {
  if (!query.trim()) return [{ text, match: false }];
  const lowerText = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  const result: Array<{ text: string; match: boolean }> = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = lowerText.indexOf(lowerQ, pos);
    if (idx < 0) { result.push({ text: text.slice(pos), match: false }); break; }
    if (idx > pos) result.push({ text: text.slice(pos, idx), match: false });
    result.push({ text: text.slice(idx, idx + query.length), match: true });
    pos = idx + query.length;
  }
  return result;
}
