/**
 * Emoji helpers for GroupsScreen (D.4.1 extract).
 */
const GRP_EMOJI_ONLY_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;

export function isGrpBigEmoji(text: string): boolean {
  return GRP_EMOJI_ONLY_RE.test(text.trim());
}
