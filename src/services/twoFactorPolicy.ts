import speakeasy from 'speakeasy';

const TOTP_WINDOW = 1;

export const normalizeBase32Secret = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (!normalized || !/^[A-Z2-7]+=*$/.test(normalized)) return null;

  return normalized;
};

export const verifyTotpCode = (secret: unknown, token: unknown): boolean => {
  const normalizedSecret = normalizeBase32Secret(secret);
  const normalizedToken = typeof token === 'string' ? token.trim() : '';

  if (!normalizedSecret || !/^\d{6}$/.test(normalizedToken)) return false;

  return speakeasy.totp.verify({
    secret: normalizedSecret,
    encoding: 'base32',
    token: normalizedToken,
    window: TOTP_WINDOW,
  });
};

export const resolveVerifiedSetupSecret = ({
  setupSecret,
  cachedSecret,
  token,
}: {
  setupSecret: unknown;
  cachedSecret: unknown;
  token: unknown;
}): string | null => {
  const candidates = [setupSecret, cachedSecret]
    .map(normalizeBase32Secret)
    .filter((secret): secret is string => Boolean(secret));

  for (const secret of [...new Set(candidates)]) {
    if (verifyTotpCode(secret, token)) return secret;
  }

  return null;
};

