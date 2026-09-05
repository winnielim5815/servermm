import { AuditLog, User } from '../models';
import { isEncrypted, encrypt } from '../utils/encryption';
import { Request } from 'express';

const MASK_KEYS = new Set([
  'password',
  'password_hash',
  'account_number',
  'accountNumber',
  'account_number_last_4',
  'api_key',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'jwt_id',
  'jti',
  'cvv',
  'pin',
  'reason',
  'full_name',
  'fullName',
  'last_login_ip',
  'ip_address',
  'remark',
  'staff_note',
  'game_account_id',
  'device_id',
  'deviceId',
  'device_name',
  'deviceName',
  'user_agent',
  'userAgent',
  'ip',
  'vendor_config',
  'vendorConfig',
  'use_api',
  'useApi',
]);

const API_CONFIGURATION_KEYS = new Set(['vendor_config', 'vendorConfig', 'use_api', 'useApi']);

const maskApiConfiguration = (data: any): any => {
  if (Array.isArray(data)) return data.map((item) => maskApiConfiguration(item));
  if (!data || typeof data !== 'object') return data;
  const masked: any = { ...data };
  for (const key of Object.keys(masked)) {
    if (API_CONFIGURATION_KEYS.has(key)) {
      masked[key] = '***MASKED***';
    } else {
      masked[key] = maskApiConfiguration(masked[key]);
    }
  }
  return masked;
};

export const maskApiConfigurationInAuditPayload = (value: any): any => {
  if (typeof value !== 'string') return maskApiConfiguration(value);
  try {
    return JSON.stringify(maskApiConfiguration(JSON.parse(value)));
  } catch {
    return value;
  }
};

const maskSensitive = (data: any): any => {
  if (!data) return data;
  
  if (Array.isArray(data)) {
    return data.map(item => maskSensitive(item));
  }
  
  if (typeof data === 'object') {
    const masked: any = { ...data };
    for (const key of Object.keys(masked)) {
      if (MASK_KEYS.has(key)) {
        masked[key] = '***MASKED***';
      } else if (typeof masked[key] === 'object' && masked[key] !== null) {
        masked[key] = maskSensitive(masked[key]);
      }
    }
    return masked;
  }
  
  return data;
};

export const normalizeIp = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  let value = String(ip).trim();
  if (value.includes(',')) {
    value = value.split(',')[0].trim();
  }
  if (value.startsWith('::ffff:')) {
    return value.substring(7);
  }
  if (value === '::1') return '127.0.0.1';
  // Strip port if present (e.g., "203.0.113.1:52345")
  const colonIdx = value.indexOf(':');
  if (colonIdx > -1 && value.indexOf('.') > -1) {
    value = value.slice(0, colonIdx);
  }
  return value;
};

export const getClientIp = (req: Request): string | null => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) {
    const n = normalizeIp(cf.trim());
    if (n) return n;
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0].trim();
    const normalized = normalizeIp(first);
    if (normalized) return normalized;
  }
  const remote = (req.socket?.remoteAddress as string | undefined) || null;
  return normalizeIp(remote);
};

const safePlainObject = (value: any, seen = new WeakSet()): any => {
  if (value == null) return null;
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => safePlainObject(v, seen));
  }

  if (typeof (value as any).toJSON === 'function') {
    try {
      const json = (value as any).toJSON();
      return safePlainObject(json, seen);
    } catch {
      // fall through
    }
  }

  const out: any = {};
  for (const key of Object.keys(value)) {
    const v = (value as any)[key];
    out[key] = safePlainObject(v, seen);
  }
  return out;
};

const safeSerialize = (value: any): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    const plain = safePlainObject(value);
    return JSON.stringify(plain);
  } catch {
    try {
      return JSON.stringify('[Unserializable]');
    } catch {
      return String(value);
    }
  }
};

export const logAudit = async (
  userId: number | null,
  action: string,
  originalData: any = null,
  newData: any = null,
  ipAddress: string | null = null,
  scope?: { tenant_id?: number | null; sub_brand_id?: number | null } | null
) => {
  try {
    const maskedOriginal = maskSensitive(
      typeof originalData === 'object' && originalData !== null && typeof (originalData as any).toJSON === 'function'
        ? (originalData as any).toJSON()
        : originalData,
    );
    const maskedNew = maskSensitive(
      typeof newData === 'object' && newData !== null && typeof (newData as any).toJSON === 'function'
        ? (newData as any).toJSON()
        : newData,
    );

    const serializedOriginal = safeSerialize(maskedOriginal);
    const serializedNew = safeSerialize(maskedNew);

    const encryptedIp =
      ipAddress && !isEncrypted(ipAddress) ? encrypt(ipAddress) : ipAddress;

    let tenant_id: number | null = scope && scope.tenant_id != null ? Number(scope.tenant_id) : null;
    let sub_brand_id: number | null = scope && scope.sub_brand_id != null ? Number(scope.sub_brand_id) : null;
    if ((!tenant_id || !sub_brand_id) && userId) {
      try {
        const u = await User.findByPk(userId, { attributes: ['id', 'tenant_id', 'sub_brand_id'] } as any);
        if (u) {
          tenant_id = Number((u as any).tenant_id) || null;
          sub_brand_id = Number((u as any).sub_brand_id) || null;
        }
      } catch {
      }
    }

    await AuditLog.create({
      userId,
      action,
      original_data: serializedOriginal,
      new_data: serializedNew,
      ip_address: encryptedIp || null,
      tenant_id: tenant_id || null,
      sub_brand_id: sub_brand_id || null,
    });
  } catch (error) {
  }
};
