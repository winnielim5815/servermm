import { randomInt } from 'crypto';

export const JOKER_ACCOUNT_ID_DIGITS = 10;

export const getJokerSubBrandPrefix = (subBrandCode: unknown): string => {
  const normalized = typeof subBrandCode === 'string'
    ? subBrandCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';

  return normalized.length >= 2 ? normalized.slice(0, 2) : 'SB';
};

export const generateJokerAccountId = (subBrandCode: unknown): string => {
  let digits = '';
  for (let index = 0; index < JOKER_ACCOUNT_ID_DIGITS; index++) {
    digits += String(randomInt(0, 10));
  }
  return `${getJokerSubBrandPrefix(subBrandCode)}${digits}`;
};

export const isJokerAccountId = (value: unknown, subBrandCode: unknown): boolean => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const prefix = getJokerSubBrandPrefix(subBrandCode);
  return new RegExp(`^${prefix}\\d{${JOKER_ACCOUNT_ID_DIGITS}}$`).test(normalized);
};

export const getJokerUsernameWithoutAppId = (providerUsername: unknown): string => {
  const normalized = typeof providerUsername === 'string' ? providerUsername.trim() : '';
  if (!normalized.includes('.')) return normalized;

  const parts = normalized.split('.').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
};

export const getJokerAppIdFromVendorConfig = (vendorConfig: unknown): string => {
  let normalizedConfig = vendorConfig;
  if (typeof normalizedConfig === 'string') {
    const value = normalizedConfig.trim();
    if (!value.startsWith('{')) return '';
    try {
      normalizedConfig = JSON.parse(value);
    } catch {
      return '';
    }
  }

  if (!normalizedConfig || typeof normalizedConfig !== 'object' || Array.isArray(normalizedConfig)) return '';
  return String((normalizedConfig as Record<string, unknown>).appId || '').trim();
};

export const qualifyJokerAccountId = (providerUsername: unknown, appId: unknown): string => {
  const normalizedAppId = typeof appId === 'string' ? appId.trim() : '';
  const username = getJokerUsernameWithoutAppId(providerUsername);
  if (!normalizedAppId || !username) throw new Error('JOKER_QUALIFIED_ACCOUNT_ID_REQUIRED');
  return `${normalizedAppId}.${username}`;
};
