/**
 * Media helpers for ChatScreen (D.3.1 extract).
 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.3gp']);

export function isVideoDoc(name: string): boolean {
  const lower = name.toLowerCase();
  return Array.from(VIDEO_EXTENSIONS).some((ext) => lower.endsWith(ext));
}
