import { isValidUsername, normalizeUsername } from '../username';

describe('account username', () => {
  it('normalizes @ and case', () => {
    expect(normalizeUsername(' @DobroPalm_ ')).toBe('dobropalm_');
  });

  it('accepts only the canonical username alphabet', () => {
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('имя')).toBe(false);
    expect(isValidUsername('name-with-dash')).toBe(false);
  });
});
