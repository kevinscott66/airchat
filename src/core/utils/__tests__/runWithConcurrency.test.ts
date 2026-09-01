import { runWithConcurrency } from '../runWithConcurrency';

describe('runWithConcurrency', () => {
  it('preserves order of results', async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await runWithConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, 5 - n));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('returns empty for empty input', async () => {
    expect(await runWithConcurrency([], 3, async (x) => x)).toEqual([]);
  });
});
