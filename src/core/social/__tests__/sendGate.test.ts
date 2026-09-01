/**
 * «Дойдёт ли» перед служебной отправкой (v4.32.320).
 *
 * Служебные конверты — профиль, просьба не отмечать время последнего входа —
 * запоминают у себя «этому уже сообщено» и на это полагаются. sendMessage
 * возвращает null и при постановке в очередь отправки, и при отказе, поэтому
 * спрашивать надо до отправки, а не разбирать ответ после.
 */
let mockBlocked = new Set<string>();
let mockLimitReached = new Set<string>();
let mockReadyResolved = false;

jest.mock('../../security/rateLimiter', () => ({
  rateLimiter: {
    whenReady: async (): Promise<void> => {
      mockReadyResolved = true;
    },
    isBlocked: (k: string): boolean => {
      if (!mockReadyResolved) throw new Error('спросили до whenReady');
      return mockBlocked.has(k);
    },
    messageLimitReached: (k: string): boolean => mockLimitReached.has(k),
  },
}));

import { canReachPeer } from '../sendGate';

const PEER = 'A'.repeat(43);

beforeEach(() => {
  mockBlocked = new Set();
  mockLimitReached = new Set();
  mockReadyResolved = false;
});

it('обычный собеседник — дойдёт', async () => {
  await expect(canReachPeer(PEER)).resolves.toBe(true);
});

it('заблокированный — нет', async () => {
  mockBlocked.add(PEER);
  await expect(canReachPeer(PEER)).resolves.toBe(false);
});

it('выбранный часовой лимит — тоже нет, но это временно', async () => {
  mockLimitReached.add(PEER);
  await expect(canReachPeer(PEER)).resolves.toBe(false);
  mockLimitReached.delete(PEER);
  await expect(canReachPeer(PEER)).resolves.toBe(true);
});

it('блок-лист спрашивается только после того, как он поднят с диска', async () => {
  // Мок бросает, если спросить раньше: на первых секундах после запуска
  // isBlocked отвечает «не заблокирован» кому угодно (v4.32.317).
  await expect(canReachPeer(PEER)).resolves.toBe(true);
  expect(mockReadyResolved).toBe(true);
});
