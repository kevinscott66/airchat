import { channelAuthor, channelIdentity } from '../channelIdentity';

describe('channel attribution', () => {
  it('uses the channel even when anonymousPosting was never enabled', () => {
    expect(channelAuthor({ type: 'channel', name: 'Новости' }, 'Private Admin')).toBe('Новости');
    expect(channelAuthor({ type: 'channel', name: '' }, 'Private Admin')).toBe('Канал');
  });
  it('does not change ordinary group authors', () => {
    expect(channelAuthor({ type: 'group', name: 'Друзья' }, 'Аня')).toBe('Аня');
    expect(channelIdentity({ type: 'group' })).toBeNull();
  });
});

it('anonymous identity is per message and does not leak into following personal posts', () => {
 const group = { type: 'group' as const, name: 'Friends' };
 expect(channelAuthor(group, 'Admin', {authorAsGroup: true})).toBe('Friends');
 expect(channelAuthor(group, 'Admin', {authorAsGroup: false})).toBe('Admin');
});
