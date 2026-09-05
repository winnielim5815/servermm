import {
  getInheritedBrandApiConfiguration,
  withApiConfigurationForResponse,
} from './gameApiConfigurationPolicy';

describe('Game API configuration policy', () => {
  it('inherits only enabled, valid brand API configuration and clones the object', () => {
    const source = { use_api: true, vendor_config: { operatorCode: 'brand-a' } };
    const inherited = getInheritedBrandApiConfiguration(source);

    expect(inherited).toEqual({
      useApi: true,
      vendorConfig: { operatorCode: 'brand-a' },
    });
    expect(inherited.vendorConfig).not.toBe(source.vendor_config);
  });

  it('creates a non-API game when no usable brand configuration exists', () => {
    expect(getInheritedBrandApiConfiguration(null)).toEqual({
      useApi: false,
      vendorConfig: null,
    });
    expect(getInheritedBrandApiConfiguration({ use_api: false, vendor_config: { ignored: true } })).toEqual({
      useApi: false,
      vendorConfig: null,
    });
  });

  it('omits API configuration from non-superadmin responses', () => {
    const base = { id: 1, name: 'Joker' };

    expect(withApiConfigurationForResponse(base, false, true, { secret: '******' })).toEqual(base);
    expect(withApiConfigurationForResponse(base, true, true, { secret: '******' })).toEqual({
      ...base,
      useApi: true,
      vendorConfig: { secret: '******' },
    });
  });
});
