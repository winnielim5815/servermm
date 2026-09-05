import NodeCache from 'node-cache';

// TTL: 10 minutes
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

export const getCache = (key: string) => {
  return cache.get(key);
};

export const setCache = (key: string, value: any, ttl?: number) => {
  cache.set(key, value, ttl || 600);
};

export const invalidateCache = (key: string) => {
  cache.del(key);
};

export const invalidateCacheByPrefix = (prefixes: string | string[]) => {
  const normalized = Array.isArray(prefixes) ? prefixes : [prefixes];
  const keys = cache.keys().filter((key) => normalized.some((prefix) => key.startsWith(prefix)));
  if (keys.length > 0) cache.del(keys);
};

export const invalidateUserPermissionsCache = (userId: number | string) => {
  const keys = cache.keys();
  const prefixV2 = `user_permissions:v2:${userId}:`;
  const prefixV1 = `user_permissions:${userId}:`;
  keys.forEach((k) => {
    if (k.startsWith(prefixV2) || k.startsWith(prefixV1)) {
      cache.del(k);
    }
  });
};

export const flushCache = () => {
  cache.flushAll();
};

export default cache;
