import { Request, Response } from 'express';
import { Game, GameAdjustment, Product, Role, SubBrand, Transaction, User, UserTenant } from '../models';
import { logAudit } from '../services/AuditService';
import { AuthRequest } from '../middleware/auth';
import sequelize from '../config/database';
import { decrypt, encrypt, isEncrypted } from '../utils/encryption';
import { VendorFieldDef, getVendorFieldDefsFromKeys, isAllowedVendorFieldKey } from '../vendors/vendorFieldRegistry';
import { sendSuccess, sendError } from '../utils/response';
import { getTenancyScopeOrThrow, withTenancyCreate, withTenancyWhere } from '../tenancy/scope';
import { getCache, invalidateCacheByPrefix, setCache } from '../services/CacheService';
import { Op } from 'sequelize';
import {
  cloneApiConfiguration,
  getInheritedBrandApiConfiguration,
  normalizeApiConfiguration,
  withApiConfigurationForResponse,
} from '../services/gameApiConfigurationPolicy';

const isValidUrl = (url: string): boolean => {
  if (!url) return true; // Allow empty/null URLs
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const normalizeIp = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

const getClientIp = (req: Request): string | null => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0].trim();
    const normalized = normalizeIp(first);
    if (normalized) return normalized;
  }
  const remote = req.socket.remoteAddress || null;
  return normalizeIp(remote);
};

let gameSynced = false;
let productSynced = false;

const ensureGamesSynced = async () => {
  if (!gameSynced) {
    await Game.sync({ alter: true });
    gameSynced = true;
  }
  if (!productSynced) {
    await Product.sync({ alter: true });
    productSynced = true;
  }
};

const normalizeVendorFieldKeys = (raw: any): string[] => {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        raw = JSON.parse(s);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const key =
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object' && typeof (item as any).key === 'string'
          ? String((item as any).key).trim()
          : '';
    if (!key) continue;
    if (!isAllowedVendorFieldKey(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

const maskSecretValue = (value: any): any => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length === 0) return '';
  return '******';
};

const normalizeVendorConfigRaw = (raw: any): Record<string, any> | null => {
  return normalizeApiConfiguration(raw);
};

export const __test__ = {
  normalizeVendorConfigRaw,
};

const validateAndBuildVendorConfig = (
  fields: VendorFieldDef[],
  rawConfig: any,
  mode: 'create' | 'update',
  existingConfig?: Record<string, any> | null,
): { config: Record<string, any>; error?: string } => {
  const base: Record<string, any> =
    mode === 'update' ? (normalizeVendorConfigRaw(existingConfig) ? { ...(normalizeVendorConfigRaw(existingConfig) as any) } : {}) : {};

  const allowedKeys = new Set(fields.map((f) => f.key));

  if (rawConfig === undefined || rawConfig === null) {
    if (mode === 'create' && allowedKeys.size > 0) return { config: {}, error: 'G201' };
    return { config: base };
  }

  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return { config: {}, error: 'G202' };
  }

  for (const key of Object.keys(rawConfig)) {
    if (!allowedKeys.has(key)) {
      return { config: {}, error: 'G203' };
    }
  }

  for (const def of fields) {
    if (!(def.key in rawConfig)) continue;
    const value = (rawConfig as any)[def.key];

    if (value === undefined) continue;
    if (value === null || value === '') {
      return { config: {}, error: 'G204' };
      continue;
    }

    if (def.type === 'number') {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) return { config: {}, error: 'G205' };
      base[def.key] = num;
      continue;
    }

    if (typeof value !== 'string') return { config: {}, error: 'G206' };
    const s = value.trim();
    if (!s) return { config: {}, error: 'G204' };

    if (def.type === 'url' && s && !isValidUrl(s)) return { config: {}, error: 'G207' };

    if (def.secret) {
      base[def.key] = isEncrypted(s) ? s : encrypt(s);
    } else {
      base[def.key] = s;
    }
  }

  if (mode === 'create') {
    for (const def of fields) {
      const v = base[def.key];
      if (v === undefined || v === null || v === '') {
        return { config: {}, error: 'G204' };
      }
    }
  }

  return { config: base };
};

const maskVendorConfigForResponse = (
  fields: VendorFieldDef[],
  config: any,
): Record<string, any> | null => {
  const normalized = normalizeVendorConfigRaw(config);
  if (!normalized) return null;
  const out: Record<string, any> = {};
  for (const def of fields) {
    if (!(def.key in normalized)) continue;
    const v = (normalized as any)[def.key];
    if (def.key === 'signatureKey' && typeof v === 'string') {
      out[def.key] = isEncrypted(v) ? decrypt(v) : v;
      continue;
    }
    out[def.key] = def.secret ? maskSecretValue(v) : v;
  }
  return out;
};

const isSuperAdminRequest = (req: AuthRequest): boolean => Boolean(req.user?.is_super_admin);

const findBrandApiTemplate = async (
  tenantId: number,
  productId: number,
  transaction?: any,
): Promise<any | null> => {
  const candidates = await Game.findAll({
    where: {
      tenant_id: tenantId,
      product_id: productId,
      status: 'active',
      use_api: true,
      vendor_config: { [Op.ne]: null },
    } as any,
    order: [['id', 'ASC']],
    transaction,
  } as any);
  return (candidates as any[]).find((row) => cloneApiConfiguration((row as any).vendor_config) !== null) ?? null;
};

const invalidateGameCachesForTenant = (tenantId: number) => {
  invalidateCacheByPrefix([
    `games_context_v3:${tenantId}:`,
    `game_detail_v2:${tenantId}:`,
  ]);
};

export const getAllGames = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewGames = (userPermissions as string[]).includes('view:games');
    const games = await Game.findAll({
      where: withTenancyWhere(scope, { status: 'active' }),
      order: [['name', 'ASC']]
    });
    const formatted = games.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      status: g.status,
      balance: canViewGames ? Number(g.balance) : null,
      kioskUrl: g.kioskUrl,
      kioskUsername: g.kioskUsername,
      kioskPassword: g.kioskPassword
    }));
    sendSuccess(res, 'Code1', formatted);
  } catch (error) {
    sendError(res, 'Code1000', 500); // Error fetching games
  }
};

export const getGamesContext = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    await ensureGamesSynced();
    const userPermissions = req.user?.permissions || [];
    const canViewGames = (userPermissions as string[]).includes('view:games');
    const isSuperAdmin = isSuperAdminRequest(req);
    const includeMetaRaw =
      (req.query.includeMeta as string | undefined) ??
      (req.query.include_meta as string | undefined) ??
      null;
    const includeMeta =
      includeMetaRaw == null
        ? true
        : !['0', 'false', 'no'].includes(includeMetaRaw.trim().toLowerCase());

    const requesterId = req.user?.id ?? null;
    const baseCacheKey = [
      'games_context_v3',
      scope.tenant_id,
      scope.sub_brand_id,
      includeMeta ? 'm1' : 'm0',
      canViewGames ? 'b1' : 'b0',
      isSuperAdmin ? 'a1' : 'a0',
    ].join(':');
    const cached = getCache(baseCacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=3');
      sendSuccess(res, 'Code1', cached);
      return;
    }

    const [games, products, brandApiRows] = await Promise.all([
      Game.findAll({
        attributes: ['id', 'name', 'icon', 'status', 'balance', 'kioskUrl', 'kioskUsername', 'kioskPassword', 'product_id', 'use_api'],
        where: withTenancyWhere(scope, { status: 'active' }),
        order: [['name', 'ASC']],
      } as any),
      includeMeta
        ? Product.findAll({
            attributes: ['id', 'provider', 'providerCode', 'vendorFields'],
            where: { status: 'active' } as any,
            order: [['provider', 'ASC']],
          } as any)
        : Promise.resolve([] as any[]),
      includeMeta && isSuperAdmin
        ? Game.findAll({
            attributes: ['id', 'product_id', 'vendor_config'],
            where: {
              tenant_id: scope.tenant_id,
              status: 'active',
              use_api: true,
              vendor_config: { [Op.ne]: null },
            } as any,
            order: [['id', 'ASC']],
          } as any)
        : Promise.resolve([] as any[]),
    ]);

    const brandApiByProduct = new Map<number, any>();
    (brandApiRows as any[]).forEach((row: any) => {
      const productId = Number((row as any).product_id ?? null);
      if (!Number.isFinite(productId) || productId <= 0 || brandApiByProduct.has(productId)) return;
      if (cloneApiConfiguration((row as any).vendor_config) === null) return;
      brandApiByProduct.set(productId, row);
    });

    const formattedProducts = includeMeta
      ? (products as any[]).map((p: any) => {
          const base = {
            id: p.id,
            provider: p.provider,
            providerCode: p.providerCode,
          };
          if (!isSuperAdmin) return base;

          const vendorFieldKeys = normalizeVendorFieldKeys(p.vendorFields);
          const vendorFields = getVendorFieldDefsFromKeys(vendorFieldKeys);
          const template = brandApiByProduct.get(Number(p.id)) ?? null;
          return {
            ...base,
            vendorFields: vendorFieldKeys,
            brandApiConfigured: Boolean(template),
            brandUseApi: Boolean(template),
            brandVendorConfig: template
              ? maskVendorConfigForResponse(vendorFields, (template as any).vendor_config)
              : null,
          };
        })
      : [];

    const formattedGames = (games as any[]).map((g: any) => {
      const base = {
        id: g.id,
        name: g.name,
        icon: g.icon,
        status: g.status,
        balance: canViewGames ? Number(g.balance) : null,
        kioskUrl: g.kioskUrl,
        kioskUsername: g.kioskUsername,
        kioskPassword: g.kioskPassword,
        productId: (g as any).product_id || null,
      };
      return isSuperAdmin ? { ...base, useApi: Boolean((g as any).use_api) } : base;
    });

    let subBrands: any[] = [];
    if (includeMeta) {
      try {
        const requester = requesterId
          ? await User.findByPk(requesterId, { include: [{ model: Role, through: { attributes: [] }, required: false }] } as any)
          : null;
        if (requester) {
          const requesterIsSuperAdmin =
            Boolean(req.user?.is_super_admin) ||
            Boolean((requester as any)?.Roles?.some((r: Role) => String((r as any)?.name).toLowerCase() === 'super admin'));
          const isOperator = Boolean((requester as any)?.Roles?.some((r: Role) => String((r as any)?.name).toLowerCase() === 'operator'));
          const isAgent = Boolean((requester as any)?.Roles?.some((r: Role) => String((r as any)?.name).toLowerCase() === 'agent'));
          if (requesterIsSuperAdmin) {
            subBrands = await SubBrand.findAll({ order: [['id', 'ASC']] });
          } else if (isOperator) {
            const tid = Number((requester as any)?.tenant_id ?? null);
            if (Number.isFinite(tid) && tid > 0) {
              subBrands = await SubBrand.findAll({ where: { tenant_id: tid } as any, order: [['id', 'ASC']] });
            }
          } else if (isAgent) {
            const rows = await UserTenant.findAll({ where: { userId: requesterId }, attributes: ['tenantId'] } as any);
            const tenantIds = (rows as any[])
              .map((r: any) => Number((r as any).tenantId))
              .filter((x: number) => Number.isFinite(x) && x > 0);
            const fallbackTenantId = Number((requester as any)?.tenant_id ?? null);
            if (Number.isFinite(fallbackTenantId) && fallbackTenantId > 0 && !tenantIds.includes(fallbackTenantId)) {
              tenantIds.push(fallbackTenantId);
            }
            if (tenantIds.length > 0) {
              subBrands = await SubBrand.findAll({ where: { tenant_id: tenantIds } as any, order: [['id', 'ASC']] } as any);
            }
          }
        }
      } catch {
      }
    }

    const payload: any = {
      generatedAt: new Date().toISOString(),
      games: formattedGames,
    };
    if (includeMeta) {
      payload.products = formattedProducts;
      payload.subBrands = (subBrands as any[]).map((sb: any) => ({
        id: sb.id,
        tenant_id: (sb as any).tenant_id ?? null,
        code: (sb as any).code ?? null,
        name: (sb as any).name ?? null,
        status: (sb as any).status ?? null,
      }));
    }

    setCache(baseCacheKey, payload, includeMeta ? 10 : 3);
    res.setHeader('Cache-Control', 'private, max-age=3');
    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    sendError(res, 'Code1001', 500); // Error fetching games context
  }
};

export const getGameById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewGames = (userPermissions as string[]).includes('view:games');
    const isSuperAdmin = isSuperAdminRequest(req);
    const idRaw = req.params.id;
    const id = idRaw != null ? Number(idRaw) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      sendError(res, 'Code1008', 404);
      return;
    }

    const cacheKey = [
      'game_detail_v2',
      scope.tenant_id,
      scope.sub_brand_id,
      id,
      canViewGames ? 'b1' : 'b0',
      isSuperAdmin ? 'a1' : 'a0',
    ].join(':');
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=10');
      sendSuccess(res, 'Code1', cached);
      return;
    }

    const game = await Game.findOne({ where: withTenancyWhere(scope, { id }) } as any);
    if (!game) {
      sendError(res, 'Code1008', 404);
      return;
    }

    const productId = (game as any).product_id ? Number((game as any).product_id) : null;
    const product = isSuperAdmin && productId ? await Product.findByPk(productId) : null;
    const vendorFieldKeys = product ? normalizeVendorFieldKeys((product as any).vendorFields) : [];
    const vendorFields = getVendorFieldDefsFromKeys(vendorFieldKeys);
    const brandTemplate = isSuperAdmin && productId
      ? await findBrandApiTemplate(scope.tenant_id, productId)
      : null;
    const apiConfigSource = brandTemplate ?? game;
    const apiUseApi = Boolean((apiConfigSource as any).use_api);
    const maskedVendorConfig = product && apiUseApi
      ? maskVendorConfigForResponse(vendorFields, (apiConfigSource as any).vendor_config)
      : null;

    const payload = withApiConfigurationForResponse({
      id: game.id,
      name: game.name,
      icon: game.icon,
      status: game.status,
      balance: canViewGames ? Number((game as any).balance) : null,
      kioskUrl: (game as any).kioskUrl,
      kioskUsername: (game as any).kioskUsername,
      kioskPassword: (game as any).kioskPassword,
      productId: productId || null,
    }, isSuperAdmin, apiUseApi, maskedVendorConfig);

    setCache(cacheKey, payload, 10);
    res.setHeader('Cache-Control', 'private, max-age=10');
    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    sendError(res, 'Code1000', 500);
  }
};

export const createGame = async (req: AuthRequest, res: Response): Promise<void> => {
  let transaction: any = null;
  try {
    const scope = getTenancyScopeOrThrow(req);
    await ensureGamesSynced();
    transaction = await sequelize.transaction();
    const isSuperAdmin = isSuperAdminRequest(req);
    const { balance, kioskUrl, kioskUsername, kioskPassword } = req.body;
    const productId = req.body?.productId !== undefined ? Number(req.body.productId) : null;
    
    if (productId === null || Number.isNaN(productId)) {
      await transaction.rollback();
      sendError(res, 'Code1002', 400); // Invalid product ID
      return;
    }

    // Validate kioskUrl if provided
    if (kioskUrl && !isValidUrl(kioskUrl)) {
      await transaction.rollback();
      sendError(res, 'Code1003', 400); // Invalid URL
      return;
    }

    const resolvedProduct = await Product.findByPk(productId, { transaction } as any);
    if (!resolvedProduct || resolvedProduct.status !== 'active') {
      await transaction.rollback();
      sendError(res, 'Code1004', 400); // Product not found or inactive
      return;
    }

    const trimmedName = String(resolvedProduct.provider).trim();
    const derivedIcon = resolvedProduct.icon || null;

    const existing = await Game.findOne({
      where: withTenancyWhere(scope, { name: trimmedName }),
      transaction,
      lock: transaction.LOCK.UPDATE,
    } as any);

    if (existing && existing.status !== 'inactive') {
      await transaction.rollback();
      sendError(res, 'Code1006', 400); // Game already exists
      return;
    }

    const brandTemplate = await findBrandApiTemplate(scope.tenant_id, resolvedProduct.id, transaction);
    const inherited = getInheritedBrandApiConfiguration(brandTemplate);
    const inheritedConfig = inherited.vendorConfig;
    let useApi = inherited.useApi;
    let storedVendorConfig: Record<string, any> | null = inheritedConfig;
    let maskedVendorConfig: Record<string, any> | null = null;

    // API fields from non-superadmins are intentionally ignored; the brand template is authoritative.
    if (isSuperAdmin) {
      const requestedUseApi = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'useApi')
        ? Boolean(req.body?.useApi)
        : useApi;
      useApi = requestedUseApi;
      if (!useApi) {
        storedVendorConfig = null;
      }
    }

    if (isSuperAdmin && useApi) {
      const vendorFields = getVendorFieldDefsFromKeys(normalizeVendorFieldKeys(resolvedProduct.vendorFields));
      const built = validateAndBuildVendorConfig(
        vendorFields,
        req.body?.vendorConfig,
        inheritedConfig ? 'update' : 'create',
        inheritedConfig,
      );
      if (built.error) {
        await transaction.rollback();
        sendError(res, 'Code1005', 400, { detail: built.error }); // Built error
        return;
      }
      storedVendorConfig = built.config;
      maskedVendorConfig = maskVendorConfigForResponse(vendorFields, storedVendorConfig);
    }

    let game: any;
    let original: Record<string, any> | null = null;
    let auditAction = 'GAME_CREATE';
    if (existing) {
      original = existing.toJSON();
      auditAction = 'GAME_RESTORE';
      (existing as any).product_id = resolvedProduct.id;
      existing.name = trimmedName;
      existing.icon = derivedIcon;
      (existing as any).use_api = useApi;
      (existing as any).vendor_config = storedVendorConfig;
      if (balance !== undefined && balance !== null) (existing as any).balance = balance;
      if (kioskUrl !== undefined) (existing as any).kioskUrl = kioskUrl;
      if (kioskUsername !== undefined) (existing as any).kioskUsername = kioskUsername;
      if (kioskPassword !== undefined) (existing as any).kioskPassword = kioskPassword;
      existing.status = 'active';
      await existing.save({ transaction });
      game = existing;
    } else {
      game = await Game.create(withTenancyCreate(scope, {
        name: trimmedName,
        balance: balance ?? 0,
        icon: derivedIcon,
        kioskUrl,
        kioskUsername,
        kioskPassword,
        product_id: resolvedProduct.id,
        vendor_config: storedVendorConfig,
        use_api: useApi,
        status: 'active',
      }), { transaction } as any);
    }

    if (isSuperAdmin) {
      await Game.update(
        { use_api: useApi, vendor_config: useApi ? storedVendorConfig : null } as any,
        {
          where: { tenant_id: scope.tenant_id, product_id: resolvedProduct.id } as any,
          transaction,
        },
      );
    }

    await transaction.commit();
    invalidateGameCachesForTenant(scope.tenant_id);

    await logAudit(
      req.user?.id || null,
      auditAction,
      original,
      {
        id: game.id,
        name: game.name,
        balance: Number(game.balance),
        icon: game.icon,
        status: game.status,
        kioskUrl: game.kioskUrl,
        kioskUsername: game.kioskUsername,
        kioskPassword: game.kioskPassword,
        productId: (game as any).product_id || null,
      },
      getClientIp(req) || undefined,
    );

    const payload = withApiConfigurationForResponse({
      id: game.id,
      name: game.name,
      balance: Number(game.balance),
      icon: game.icon,
      status: game.status,
      kioskUrl: game.kioskUrl,
      kioskUsername: game.kioskUsername,
      kioskPassword: game.kioskPassword,
      productId: (game as any).product_id || null,
    }, isSuperAdmin, useApi, maskedVendorConfig);
    sendSuccess(res, existing ? 'Code1' : 'Code1007', payload, undefined, existing ? 200 : 201);
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error creating game:', error);
    sendError(res, 'Code1007', 500); // Error creating game
  }
};

export const deleteGame = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const { id } = req.params;
    const game = await Game.findOne({ where: withTenancyWhere(scope, { id: Number(id) }) } as any);
    
    if (!game) {
      sendError(res, 'Code1008', 404); // Game not found
      return;
    }

    if (game.status === 'inactive') {
      sendSuccess(res, 'Code1009'); // Game already inactive
      return;
    }

    const original = {
      id: game.id,
      name: game.name,
      balance: Number(game.balance),
      icon: game.icon,
      status: game.status,
      kioskUrl: game.kioskUrl,
      kioskUsername: game.kioskUsername,
      kioskPassword: game.kioskPassword,
    };

    game.status = 'inactive';
    await game.save();
    invalidateGameCachesForTenant(scope.tenant_id);

    await logAudit(
      req.user?.id || null,
      'GAME_DELETE',
      original,
      {
        id: game.id,
        name: game.name,
        balance: Number(game.balance),
        icon: game.icon,
        status: game.status,
        kioskUrl: game.kioskUrl,
        kioskUsername: game.kioskUsername,
        kioskPassword: game.kioskPassword,
      },
      getClientIp(req) || undefined,
    );

    sendSuccess(res, 'Code1010'); // Game updated (deleted)
  } catch (error) {
    sendError(res, 'Code1011', 500); // Error updating game (deleting)
  }
};

export const update = async (req: AuthRequest, res: Response): Promise<void> => {
  let transaction: any = null;
  try {
    const scope = getTenancyScopeOrThrow(req);
    await ensureGamesSynced();
    transaction = await sequelize.transaction();
    const isSuperAdmin = isSuperAdminRequest(req);
    const { id } = req.params;
    const { kioskUrl, kioskUsername, kioskPassword } = req.body;
    const nextProductIdRaw = req.body?.productId;
    const nextVendorConfigRaw = req.body?.vendorConfig;
    const nextUseApiRaw = req.body?.useApi;
    
    const game = await Game.findOne({
      where: withTenancyWhere(scope, { id: Number(id) }),
      transaction,
      lock: transaction.LOCK.UPDATE,
    } as any);
    if (!game) {
      await transaction.rollback();
      sendError(res, 'Code1008', 404); // Game not found
      return;
    }

    // Validate kioskUrl if provided
    if (kioskUrl !== undefined && kioskUrl !== null && kioskUrl !== '' && !isValidUrl(kioskUrl)) {
      await transaction.rollback();
      sendError(res, 'Code1003', 400); // Invalid URL
      return;
    }

    const original = game.toJSON();
    const currentProductId = (game as any).product_id ? Number((game as any).product_id) : null;
    const nextProductId = nextProductIdRaw === undefined
      ? currentProductId
      : nextProductIdRaw === null
        ? null
        : Number(nextProductIdRaw);
    if (nextProductId !== null && (!Number.isFinite(nextProductId) || nextProductId <= 0)) {
      await transaction.rollback();
      sendError(res, 'Code1004', 400);
      return;
    }
    const productIdChanged = nextProductId !== currentProductId;
    const product = nextProductId
      ? await Product.findByPk(nextProductId, { transaction } as any)
      : null;
    if (nextProductId && (!product || product.status !== 'active')) {
      await transaction.rollback();
      sendError(res, 'Code1004', 400);
      return;
    }
    
    // Update all provided fields (including empty strings to clear values)
    if (kioskUrl !== undefined) {
      game.kioskUrl = kioskUrl;
    }
    if (kioskUsername !== undefined) {
      game.kioskUsername = kioskUsername;
    }
    if (kioskPassword !== undefined) {
      game.kioskPassword = kioskPassword;
    }

    let useApi = Boolean((game as any).use_api);
    let storedVendorConfig = cloneApiConfiguration((game as any).vendor_config);
    let maskedVendorConfig: Record<string, any> | null = null;

    if (nextProductId === null) {
      useApi = false;
      storedVendorConfig = null;
      (game as any).product_id = null;
    } else {
      (game as any).product_id = nextProductId;
      game.name = String((product as any).provider).trim();
      game.icon = (product as any).icon || null;

      if (isSuperAdmin) {
        const brandTemplate = await findBrandApiTemplate(scope.tenant_id, nextProductId, transaction);
        const brandConfig = brandTemplate ? cloneApiConfiguration((brandTemplate as any).vendor_config) : null;
        const existingConfig = brandConfig ?? (!productIdChanged ? storedVendorConfig : null);
        useApi = nextUseApiRaw !== undefined
          ? Boolean(nextUseApiRaw)
          : Boolean(brandTemplate || (!productIdChanged && (game as any).use_api));

        if (useApi) {
          const vendorFields = getVendorFieldDefsFromKeys(normalizeVendorFieldKeys((product as any).vendorFields));
          const built = validateAndBuildVendorConfig(
            vendorFields,
            nextVendorConfigRaw,
            existingConfig ? 'update' : 'create',
            existingConfig,
          );
          if (built.error) {
            await transaction.rollback();
            sendError(res, 'Code1005', 400, { detail: built.error });
            return;
          }
          storedVendorConfig = built.config;
          maskedVendorConfig = maskVendorConfigForResponse(vendorFields, built.config);
        } else {
          storedVendorConfig = null;
        }
      } else if (productIdChanged) {
        // Non-superadmins may change operational game data, but API settings always come from the brand.
        const brandTemplate = await findBrandApiTemplate(scope.tenant_id, nextProductId, transaction);
        const inherited = getInheritedBrandApiConfiguration(brandTemplate);
        useApi = inherited.useApi;
        storedVendorConfig = inherited.vendorConfig;
      }
    }

    (game as any).use_api = useApi;
    (game as any).vendor_config = useApi ? storedVendorConfig : null;
    await game.save({ transaction });

    if (isSuperAdmin && nextProductId !== null) {
      await Game.update(
        { use_api: useApi, vendor_config: useApi ? storedVendorConfig : null } as any,
        {
          where: { tenant_id: scope.tenant_id, product_id: nextProductId } as any,
          transaction,
        },
      );
    }

    await transaction.commit();
    invalidateGameCachesForTenant(scope.tenant_id);

    await logAudit(
      req.user?.id || null,
      'GAME_UPDATE',
      original,
      game.toJSON(),
      getClientIp(req) || undefined,
    );

    const payload = withApiConfigurationForResponse({
      id: game.id,
      name: game.name,
      icon: game.icon,
      status: game.status,
      balance: Number(game.balance),
      kioskUrl: game.kioskUrl,
      kioskUsername: game.kioskUsername,
      kioskPassword: game.kioskPassword,
      productId: (game as any).product_id || null,
    }, isSuperAdmin, useApi, maskedVendorConfig);
    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error updating game:', error);
    sendError(res, 'Code1011', 500); // Error updating game
  }
};

export const adjustBalance = async (req: AuthRequest, res: Response): Promise<void> => {
  const t = await sequelize.transaction();
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canAdjust = (userPermissions as string[]).includes('action:game_adjust_balance');

    if (!canAdjust) {
      await t.rollback();
      sendError(res, 'Code1012', 403);
      return;
    }

    const { id } = req.params;
    const { amount, type, reason } = req.body;
    const clientIp = getClientIp(req);
    const operatorId = req.user?.id;

    const game = await Game.findOne({
      where: withTenancyWhere(scope, { id: Number(id) }),
      transaction: t,
      lock: t.LOCK.UPDATE,
    } as any);
    if (!game) {
      await t.rollback();
      sendError(res, 'Code1008', 404); // Game not found
      return;
    }

    const beforeBalance = Number(game.balance);
    let afterBalance = beforeBalance;
    const adjustmentAmount = Number(amount);
    const reservedRow = (await Transaction.findOne({
      attributes: [[sequelize.fn('SUM', sequelize.literal('amount + bonus')), 'reserved']],
      where: withTenancyWhere(scope, { status: 'PENDING', type: 'DEPOSIT', game_id: (game as any).id }),
      raw: true,
      transaction: t,
    } as any)) as any;
    const reserved = reservedRow?.reserved != null ? Number(reservedRow.reserved) : 0;
    const available = beforeBalance - (Number.isFinite(reserved) ? reserved : 0);

    if (type === 'TOPUP') {
      afterBalance += adjustmentAmount;
    } else if (type === 'OUT') {
      if (available < adjustmentAmount) {
        await t.rollback();
        sendError(res, 'Code1014', 400); // Insufficient balance for OUT
        return;
      }
      afterBalance -= adjustmentAmount;
      if (afterBalance < reserved) {
        await t.rollback();
        sendError(res, 'Code1014', 400);
        return;
      }
    } else {
      await t.rollback();
      sendError(res, 'Code1013', 400);
      return;
    }

    game.balance = afterBalance;
    await game.save({ transaction: t });

    const operatorName =
      (req.user && (req.user.full_name || req.user.username)) || 'Unknown';

    await GameAdjustment.create(
      withTenancyCreate(scope, {
        game_id: game.id,
        operator_id: operatorId,
        amount: adjustmentAmount,
        type,
        reason,
        operator: operatorName,
        game_balance_after: afterBalance,
        ip_address: clientIp,
      }),
      { transaction: t } as any,
    );

    await t.commit();
    await logAudit(req.user?.id || null, 'GAME_ADJUST', { id: game.id, beforeBalance, afterBalance, amount: adjustmentAmount, type, reason }, { id: game.id, balance: afterBalance, kioskUrl: game.kioskUrl, kioskUsername: game.kioskUsername, kioskPassword: game.kioskPassword }, clientIp || undefined);
    sendSuccess(res, 'Code1', { id: game.id, name: game.name, icon: game.icon, status: game.status, balance: Number(game.balance), kioskUrl: game.kioskUrl, kioskUsername: game.kioskUsername, kioskPassword: game.kioskPassword });
  } catch (error) {
    await t.rollback();
    console.error('Error adjusting game balance:', error);
    sendError(res, 'Code1015', 500);
  }
};

export const getGameAdjustments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewSensitive = (userPermissions as string[]).includes('view:sensitive_logs');
    const adjustments = await GameAdjustment.findAll({
      where: withTenancyWhere(scope) as any,
      order: [['createdAt', 'DESC']]
    });

    const formatted = adjustments.map((a: any) => {
      const amount = a.amount != null ? Number(a.amount) : 0;
      const afterBalance =
        a.game_balance_after != null ? Number(a.game_balance_after) : null;

      let beforeBalance: number | null = null;
      if (afterBalance != null && !Number.isNaN(amount)) {
        if (a.type === 'TOPUP') {
          beforeBalance = afterBalance - amount;
        } else if (a.type === 'OUT') {
          beforeBalance = afterBalance + amount;
        }
      }

      return {
        id: a.id,
        gameId: a.game_id,
        amount,
        type: a.type,
        reason: canViewSensitive ? a.reason : null,
        operator: a.operator,
        ip: canViewSensitive ? (a.ip_address || null) : null,
        beforeBalance,
        afterBalance,
        date: a.createdAt,
      };
    });

    sendSuccess(res, 'Code1', formatted);
  } catch (error) {
    console.error('Error fetching game adjustments:', error);
    sendError(res, 'Code1016', 500);
  }
};
