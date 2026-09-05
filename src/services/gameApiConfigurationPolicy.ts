export type ApiConfiguration = Record<string, any>;

export const normalizeApiConfiguration = (raw: any): ApiConfiguration | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!(value.startsWith('{') || value.startsWith('['))) return null;
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as ApiConfiguration;
};

export const cloneApiConfiguration = (raw: any): ApiConfiguration | null => {
  const normalized = normalizeApiConfiguration(raw);
  return normalized ? { ...normalized } : null;
};

export const getInheritedBrandApiConfiguration = (template: any | null) => {
  const vendorConfig = template && Boolean(template.use_api)
    ? cloneApiConfiguration(template.vendor_config)
    : null;
  return {
    useApi: Boolean(vendorConfig),
    vendorConfig,
  };
};

export const withApiConfigurationForResponse = (
  payload: Record<string, any>,
  isSuperAdmin: boolean,
  useApi: boolean,
  vendorConfig: ApiConfiguration | null,
) => {
  if (!isSuperAdmin) return payload;
  return { ...payload, useApi, vendorConfig };
};
