/** Channel attribution is presentation privacy, not anonymous cryptographic signing.
 * Keep the authenticated member key for authorization, edits and delivery receipts.
 */
export function channelIdentity(group: { type?: string; name?: string | null }): string | null {
  return group.type === 'channel' ? (group.name?.trim() || 'Канал') : null;
}

/** Never carry the administrator's identity into a forwarded/exported attribution. */
export function channelAuthor(group: { type?: string; name?: string | null }, personalName: string): string {
  return channelIdentity(group) ?? personalName;
}
