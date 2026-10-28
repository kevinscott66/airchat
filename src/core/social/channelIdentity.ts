/** Channel attribution is presentation privacy, not anonymous cryptographic signing.
 * Keep the authenticated member key for authorization, edits and delivery receipts.
 */
export function channelIdentity(group: { type?: string; name?: string | null }, message?: { authorAsGroup?: boolean }): string | null {
  return group.type === 'channel' || message?.authorAsGroup ? (group.name?.trim() || (group.type === 'channel' ? 'Канал' : 'Группа')) : null;
}

/** Never carry the administrator's identity into a forwarded/exported attribution. */
export function channelAuthor(group: { type?: string; name?: string | null }, personalName: string, message?: { authorAsGroup?: boolean }): string {
  return channelIdentity(group, message) ?? personalName;
}
