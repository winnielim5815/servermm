import {
  generateJokerAccountId,
  getJokerDisplayAccountId,
  getJokerSubBrandPrefix,
} from './jokerAccountId';

describe('Joker account ID', () => {
  it('uses the first two normalized Subbrand characters and ten digits', () => {
    expect(getJokerSubBrandPrefix(' ab-123 ')).toBe('AB');

    for (let index = 0; index < 20; index++) {
      expect(generateJokerAccountId('ab-123')).toMatch(/^AB\d{10}$/);
    }
  });

  it('uses a stable two-character fallback for invalid legacy codes', () => {
    expect(getJokerSubBrandPrefix('')).toBe('SB');
    expect(getJokerSubBrandPrefix('x')).toBe('SB');
    expect(generateJokerAccountId(null)).toMatch(/^SB\d{10}$/);
  });

  it('hides the provider app id from the displayed Joker account ID', () => {
    expect(getJokerDisplayAccountId('APPID.AB1234567890')).toBe('AB1234567890');
    expect(getJokerDisplayAccountId('AB1234567890')).toBe('AB1234567890');
  });
});
