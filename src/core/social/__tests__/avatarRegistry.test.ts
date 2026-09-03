/**
 * Реестр лиц: снимок профиля должен быть виден везде, где рисуется кружок.
 *
 * Проверяется именно то, чего не было до v4.32.565: фото контакта находится и
 * по его открытому ключу, и по did (лента знает автора только по did), а своё
 * фото находится по своему ключу — притом что контактом сам себе никто не
 * приходится.
 */
import { didFromPubB64 } from '../../identity/did';

const PEER_PUB = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const mockMyPubBytes = new Uint8Array(32).fill(3);
const MY_PUB = Buffer.from(mockMyPubBytes).toString('base64');

let mockContacts: { peerPublicKey: string; avatarCid?: string }[] = [];
let mockContactsCb: (() => void) | null = null;
let mockOwnUri: string | null = null;

jest.mock('../contacts', () => ({
  listContacts: jest.fn(async () => mockContacts),
  subscribeContactsChanged: jest.fn((cb: () => void) => {
    mockContactsCb = cb;
    return () => { mockContactsCb = null; };
  }),
}));
jest.mock('../../identity/ownAvatar', () => ({
  ownAvatarUri: jest.fn(async () => mockOwnUri),
}));
jest.mock('../../crypto/keyManager', () => ({
  loadKeyPair: jest.fn(async () => ({ publicKey: mockMyPubBytes, secretKey: new Uint8Array(64) })),
}));

import { avatarSourceFor, refreshAvatarTable, startAvatarRegistry, stopAvatarRegistry, subscribeAvatarsChanged } from '../avatarRegistry';

beforeEach(() => {
  mockContacts = [];
  mockOwnUri = null;
  stopAvatarRegistry();
});

test('фото контакта находится и по ключу, и по did', async () => {
  mockContacts = [{ peerPublicKey: PEER_PUB, avatarCid: 'nb:peer-photo' }];
  await refreshAvatarTable();
  expect(avatarSourceFor(PEER_PUB)).toEqual({ cid: 'nb:peer-photo', uri: null });
  const did = didFromPubB64(PEER_PUB);
  expect(did).toBeTruthy();
  expect(avatarSourceFor(did)).toEqual({ cid: 'nb:peer-photo', uri: null });
});

test('контакт без фото в таблицу не попадает — рисуется буква', async () => {
  mockContacts = [{ peerPublicKey: PEER_PUB }];
  await refreshAvatarTable();
  expect(avatarSourceFor(PEER_PUB)).toBeNull();
});

test('своё фото находится по своему ключу, хотя контактом себе никто не является', async () => {
  mockOwnUri = 'file:///avatars/me.jpg';
  await refreshAvatarTable();
  expect(avatarSourceFor(MY_PUB)).toEqual({ cid: null, uri: 'file:///avatars/me.jpg' });
});

test('своё фото выигрывает у карточки, приехавшей на собственный ключ', async () => {
  mockContacts = [{ peerPublicKey: MY_PUB, avatarCid: 'nb:stale' }];
  mockOwnUri = 'file:///avatars/me.jpg';
  await refreshAvatarTable();
  expect(avatarSourceFor(MY_PUB)?.uri).toBe('file:///avatars/me.jpg');
});

test('изменение контактов перечитывает таблицу', async () => {
  startAvatarRegistry();
  await refreshAvatarTable();
  mockContacts = [{ peerPublicKey: PEER_PUB, avatarCid: 'nb:fresh' }];
  mockContactsCb?.();
  await refreshAvatarTable();
  expect(avatarSourceFor(PEER_PUB)?.cid).toBe('nb:fresh');
});

test('изменение, пришедшее во время чтения, не теряется', async () => {
  // Первое чтение видит пустой список; список меняется, пока оно идёт.
  const first = refreshAvatarTable();
  mockContacts = [{ peerPublicKey: PEER_PUB, avatarCid: 'nb:midflight' }];
  const second = refreshAvatarTable();
  await Promise.all([first, second]);
  expect(avatarSourceFor(PEER_PUB)?.cid).toBe('nb:midflight');
});

test('подписчиков зовут на каждое обновление', async () => {
  const seen = jest.fn();
  const off = subscribeAvatarsChanged(seen);
  await refreshAvatarTable();
  expect(seen).toHaveBeenCalledTimes(1);
  off();
  await refreshAvatarTable();
  expect(seen).toHaveBeenCalledTimes(1);
});

test('остановка забывает чужие снимки — смена аккаунта', async () => {
  mockContacts = [{ peerPublicKey: PEER_PUB, avatarCid: 'nb:peer-photo' }];
  await refreshAvatarTable();
  stopAvatarRegistry();
  expect(avatarSourceFor(PEER_PUB)).toBeNull();
});
