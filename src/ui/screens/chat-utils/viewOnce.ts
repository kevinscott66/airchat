/**
 * View-once message helpers (D.3.1 extract).
 */
export const VIEW_ONCE_PREFIX_CONST = '\x09vo:';

export function isViewOnceMessage(text: string): boolean {
  return text.startsWith(VIEW_ONCE_PREFIX_CONST);
}

/** Strip VIEW_ONCE prefix from text (returns bare content). */
export function stripViewOncePrefix(text: string): string {
  return text.startsWith(VIEW_ONCE_PREFIX_CONST) ? text.slice(VIEW_ONCE_PREFIX_CONST.length) : text;
}

/**
 * v4.32.534: сборка конверта переехала сюда из ChatScreen.tsx. Разбор жил
 * здесь, а сборка — в экране, откуда её импортировал экран групп; половина
 * кодека не должна лежать в разметке ленты.
 */
export function makeViewOnceText(caption: string): string {
  return `${VIEW_ONCE_PREFIX_CONST}${caption}`;
}
