import speakeasy from 'speakeasy';
import {
  normalizeBase32Secret,
  resolveVerifiedSetupSecret,
  verifyTotpCode,
} from './twoFactorPolicy';

const generateSecretAndToken = (time?: number) => {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const token = speakeasy.totp({
    secret,
    encoding: 'base32',
    ...(time === undefined ? {} : { time }),
  });

  return { secret, token };
};

describe('twoFactorPolicy', () => {
  it('normalizes a base32 setup secret', () => {
    expect(normalizeBase32Secret(' abcd 2345 ')).toBe('ABCD2345');
    expect(normalizeBase32Secret('not-valid-0')).toBeNull();
  });

  it('uses the QR setup secret when the process cache contains a stale secret', () => {
    const displayed = generateSecretAndToken();
    let stale = generateSecretAndToken();

    while (stale.token === displayed.token) stale = generateSecretAndToken();

    expect(resolveVerifiedSetupSecret({
      setupSecret: displayed.secret,
      cachedSecret: stale.secret,
      token: displayed.token,
    })).toBe(displayed.secret);
  });

  it('falls back to the cached secret for older clients', () => {
    const cached = generateSecretAndToken();

    expect(resolveVerifiedSetupSecret({
      setupSecret: null,
      cachedSecret: cached.secret,
      token: cached.token,
    })).toBe(cached.secret);
  });

  it('allows one 30-second time step of clock drift', () => {
    const nowSeconds = 1_800_000_000;
    const previousStep = generateSecretAndToken(nowSeconds - 30);
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);

    try {
      expect(verifyTotpCode(previousStep.secret, previousStep.token)).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('rejects invalid codes for every candidate secret', () => {
    const displayed = speakeasy.generateSecret({ length: 20 }).base32;
    const cached = speakeasy.generateSecret({ length: 20 }).base32;

    expect(resolveVerifiedSetupSecret({
      setupSecret: displayed,
      cachedSecret: cached,
      token: 'invalid',
    })).toBeNull();
  });
});

