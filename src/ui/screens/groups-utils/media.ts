/**
 * Media helpers for GroupsScreen (D.4.1 extract).
 */
const GRP_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.3gp']);

export function isGrpVideoDoc(name: string): boolean {
  const lower = name.toLowerCase();
  return Array.from(GRP_VIDEO_EXTENSIONS).some((ext) => lower.endsWith(ext));
}
