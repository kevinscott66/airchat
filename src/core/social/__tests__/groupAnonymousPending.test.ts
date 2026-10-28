import { beginAnonymousPending, anonymousPendingCount, acceptAnonymousAck } from '../groupAnonymousPending';
let mockValues = new Map<string, string | null>();
jest.mock('../../storage/local', () => ({ kvUpdateSecretScoped: jest.fn(async (pid, key, fn) => {
  const scope = `${pid}:${key}`; const old = mockValues.get(scope) ?? null; const next = fn(old);
  if (next === old) return 'unchanged'; mockValues.set(scope, next); return 'written';
}) }));
jest.mock('../../storage/profileScopedKv', () => ({ scopedKvTryGetSecretFor: jest.fn(async (pid, key) => ({ value: mockValues.get(`${pid}:${key}`) ?? null })) }));
beforeEach(() => { mockValues = new Map(); });
it('queues offline until every expected peer ACKs, no timeout claims delivery', async () => {
  await beginAnonymousPending(1, 'g', 'm', ['a', 'b', 'a']);
  expect(await anonymousPendingCount(1, 'm')).toBe(2);
  expect(await acceptAnonymousAck(1, 'g', 'm', 'a')).toBe(false);
  expect(await anonymousPendingCount(1, 'm')).toBe(1);
  expect(await acceptAnonymousAck(1, 'g', 'm', 'b')).toBe(true);
  expect(await anonymousPendingCount(1, 'm')).toBe(0);
  expect(await acceptAnonymousAck(1, 'g', 'm', 'b')).toBe(false);
});
it('forged peer, wrong group, and another profile cannot acknowledge a queued post', async () => {
  await beginAnonymousPending(1, 'g', 'm', ['a']);
  expect(await acceptAnonymousAck(1, 'g', 'm', 'attacker')).toBe(false);
  expect(await acceptAnonymousAck(1, 'other', 'm', 'a')).toBe(false);
  expect(await acceptAnonymousAck(2, 'g', 'm', 'a')).toBe(false);
  expect(await anonymousPendingCount(1, 'm')).toBe(1);
});
it('bounded offline queue refuses new work rather than silently dropping pending ACKs', async () => {
  for (let n = 0; n < 200; n++) await beginAnonymousPending(1, 'g', `m${n}`, ['a']);
  await expect(beginAnonymousPending(1, 'g', 'overflow', ['a'])).rejects.toThrow('Слишком много');
  expect(await anonymousPendingCount(1, 'm0')).toBe(1);
});
