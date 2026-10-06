const mockCells = new Map<string, string>();
let mockUnreadable = false;
let mockActiveId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveId }) },
}));
jest.mock('../../storage/local', () => ({
  kvTryGet: jest.fn(async (key: string) => mockUnreadable ? null : { value: mockCells.get(key) ?? null }),
  kvSetChecked: jest.fn(async (key: string, value: string) => { mockCells.set(key, value); return true; }),
  kvDelete: jest.fn(async (key: string) => { mockCells.delete(key); }),
  kvDeleteChecked: jest.fn(async (key: string) => { mockCells.delete(key); }),
  kvTryListKeysByPrefix: jest.fn(async (prefix: string) => [...mockCells.keys()].filter(key => key.startsWith(prefix))),
}));

import { linkPublishedFor, listLinkPublishedPostIds, setLinkPublished } from '../postLinkState';
import { feedLinkPublishedKey, profileScopedKey } from '../../storage/kvKeys';

beforeEach(() => { mockCells.clear(); mockUnreadable = false; mockActiveId = 1; });

test('explicit publish permits refresh; revoke removes permission', async () => {
  expect(await linkPublishedFor(1, 'p')).toBe(false);
  expect(await setLinkPublished('p', true, 1)).toBe(true);
  expect(await linkPublishedFor(1, 'p')).toBe(true);
  expect(await setLinkPublished('p', false, 1)).toBe(true);
  expect(await linkPublishedFor(1, 'p')).toBe(false);
});

test('legacy server-discovered marker stays revocable but is not upload consent', async () => {
  mockCells.set(profileScopedKey(1, feedLinkPublishedKey('p')), '1700000000000');
  expect(await linkPublishedFor(1, 'p')).toBe(false);
  expect((await listLinkPublishedPostIds())?.has('p')).toBe(true);
});

test('unreadable consent remains unknown', async () => {
  await setLinkPublished('p', true, 1);
  mockUnreadable = true;
  expect(await linkPublishedFor(1, 'p')).toBeNull();
});

test('in-flight writes and revocation remain scoped to their captured profile', async () => {
  await setLinkPublished('p', true, 1);
  mockActiveId = 2;
  expect(await linkPublishedFor(2, 'p')).toBe(false);
  await setLinkPublished('p', true, 2);
  await setLinkPublished('p', false, 1);
  expect(await linkPublishedFor(1, 'p')).toBe(false);
  expect(await linkPublishedFor(2, 'p')).toBe(true);
});
