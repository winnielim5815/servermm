import {
  generateJokerAccountId,
  getJokerAppIdFromVendorConfig,
  getJokerSubBrandPrefix,
  getJokerUsernameWithoutAppId,
  isJokerAccountId,
  normalizeJokerAppId,
  qualifyJokerAccountId,
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

  it('recognizes only the requested Subbrand prefix plus ten digits', () => {
    expect(isJokerAccountId('AB1234567890', 'ABCDE')).toBe(true);
    expect(isJokerAccountId('abcde123456', 'ABCDE')).toBe(false);
    expect(isJokerAccountId('AC1234567890', 'ABCDE')).toBe(false);
  });

  it('extracts the unqualified username only for API normalization', () => {
    expect(getJokerUsernameWithoutAppId('APPID.AB1234567890')).toBe('AB1234567890');
    expect(getJokerUsernameWithoutAppId('FVNM.FVNM.SP3602436765')).toBe('SP3602436765');
    expect(getJokerUsernameWithoutAppId('AB1234567890')).toBe('AB1234567890');
  });

  it('always qualifies the stored account with the configured app id', () => {
    expect(getJokerAppIdFromVendorConfig({ appId: 'APPID' })).toBe('APPID');
    expect(getJokerAppIdFromVendorConfig('{"appId":"APPID"}')).toBe('APPID');
    expect(qualifyJokerAccountId('AB1234567890', 'APPID')).toBe('APPID.AB1234567890');
    expect(qualifyJokerAccountId('OLD.AB1234567890', 'APPID')).toBe('APPID.AB1234567890');
    expect(() => qualifyJokerAccountId('AB1234567890', '')).toThrow('JOKER_QUALIFIED_ACCOUNT_ID_REQUIRED');
  });

  it('removes repeated app id prefixes from configuration and provider responses', () => {
    expect(normalizeJokerAppId('FVNM.FVNM')).toBe('FVNM');
    expect(getJokerAppIdFromVendorConfig({ appId: 'FVNM.FVNM' })).toBe('FVNM');
    expect(qualifyJokerAccountId('FVNM.FVNM.SP3602436765', 'FVNM')).toBe('FVNM.SP3602436765');
    expect(qualifyJokerAccountId('FVNM.SP3602436765', 'FVNM.FVNM')).toBe('FVNM.SP3602436765');
  });
});
