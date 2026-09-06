import { Request, Response } from 'express';
import { Player, Game, BankCatalog, Role, Setting, SubBrand, User, PlayerStats, Product, Transaction } from '../models';
import { AuthRequest } from '../middleware/auth';
import { logAudit, getClientIp } from '../services/AuditService';
import { VendorFactory } from '../services/vendor/VendorFactory';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import { decrypt, isEncrypted } from '../utils/encryption';
import { randomBytes } from 'crypto';
import { sendSuccess, sendError } from '../utils/response';
import { getTenancyScopeOrThrow, withTenancyCreate, withTenancyWhere } from '../tenancy/scope';
import { getSettingValue } from '../services/SettingService';
import { getCache, setCache } from '../services/CacheService';
import {
  generateJokerAccountId,
  getJokerAppIdFromVendorConfig,
  isJokerAccountId,
  qualifyJokerAccountId,
} from '../services/vendor/jokerAccountId';

const resolveOperatorName = (op: any): string | null => {
  if (!op || typeof op !== 'object') return null;

  const rawFullName =
    typeof op.full_name === 'string' && op.full_name.trim().length > 0
      ? op.full_name.trim()
      : null;

  const rawUsername =
    typeof op.username === 'string' && op.username.trim().length > 0
      ? op.username.trim()
      : null;

  if (rawFullName) {
    if (isEncrypted(rawFullName)) {
      const decrypted = decrypt(rawFullName);
      return decrypted !== rawFullName ? decrypted : rawUsername;
    }
    return rawFullName;
  }

  return rawUsername;
};

const extractPhoneNumber = (metadata: any): string | null => {
  if (!metadata) return null;
  const phoneNumber = metadata.phoneNumber || '';
  return phoneNumber.trim() || null;
};

const extractBankKeys = (metadata: any): Set<string> => {
  const keys = new Set<string>();
  if (!metadata) return keys;
  if (Array.isArray(metadata.playerBanks)) {
    for (const pb of metadata.playerBanks) {
      const bankName = (pb?.bankName || '').trim().toLowerCase();
      const acc = (pb?.accountNumber || '').trim();
      if (!bankName || !acc) continue;
      keys.add(bankName + '|' + acc);
    }
  }
  return keys;
};

const extractGameKeys = (metadata: any): Set<string> => {
  const keys = new Set<string>();
  if (!metadata) return keys;
  if (Array.isArray(metadata.gameAccounts)) {
    for (const ga of metadata.gameAccounts) {
      const gameName = (ga?.gameName || '').trim().toLowerCase();
      const id = (ga?.accountId || '').trim().toLowerCase();
      if (!gameName || !id) continue;
      keys.add(gameName + '|' + id);
    }
  }
  return keys;
};

const isVendorConflict = (result: any): boolean => {
  if (!result) return false;
  const code = typeof result.code === 'string' ? result.code : '';
  const status = typeof result.status === 'string' ? result.status : '';
  const msg = typeof result.message === 'string' ? result.message : '';
  const err = typeof result.error === 'string' ? result.error : '';
  if (code.toUpperCase() === 'EXISTS') return true;
  if (status.toLowerCase() === 'exists') return true;
  const hay = (msg + ' ' + err).toLowerCase();
  return hay.includes('exist') || hay.includes('already') || hay.includes('duplicate') || hay.includes('conflict');
};

const randomAlnumUpper = (length: number): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(Math.max(1, length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
};

const generateConflictAccountId = (base: string): string => {
  const digit = String(randomBytes(1)[0] % 10);
  return `${base}${digit}`;
};

const isJokerProviderCode = (providerCode: unknown): boolean => {
  const normalized = Number(providerCode);
  return Number.isFinite(normalized) && VendorFactory.getVendorTypeByCode(normalized) === 'joker';
};

const generateInitialVendorAccountId = (
  providerCode: unknown,
  defaultAccountId: string,
  subBrandCode: unknown,
): string => isJokerProviderCode(providerCode)
  ? (isJokerAccountId(defaultAccountId, subBrandCode)
    ? defaultAccountId.trim().toUpperCase()
    : generateJokerAccountId(subBrandCode))
  : defaultAccountId;

const generateNextVendorAccountId = (
  providerCode: unknown,
  defaultAccountId: string,
  subBrandCode: unknown,
): string => isJokerProviderCode(providerCode)
  ? generateJokerAccountId(subBrandCode)
  : generateConflictAccountId(defaultAccountId);

const getVendorDisplayAccountId = (
  providerCode: unknown,
  accountId: string,
  appId: string,
): string | null => {
  if (!accountId) return null;
  if (isJokerProviderCode(providerCode)) {
    return appId ? qualifyJokerAccountId(accountId, appId) : accountId;
  }
  if (!appId) return null;
  return accountId.includes('.') ? accountId : `${appId}.${accountId}`;
};

const getVendorAccountIdForStorage = (
  providerCode: unknown,
  game: any,
  providerUsername: unknown,
): string => {
  const normalized = typeof providerUsername === 'string' ? providerUsername.trim() : '';
  if (!isJokerProviderCode(providerCode)) return normalized;
  const appId = getJokerAppIdFromVendorConfig(game?.vendor_config);
  return qualifyJokerAccountId(normalized, appId);
};

const qualifyJokerMetadataAccountsForStorage = async (
  metadata: any,
  scope: { tenant_id: number; sub_brand_id: number },
): Promise<any> => {
  const gameAccounts = Array.isArray(metadata?.gameAccounts) ? metadata.gameAccounts : null;
  if (!gameAccounts) return metadata;

  const games = await Game.findAll({
    where: withTenancyWhere(scope),
    include: [{ model: Product, attributes: ['providerCode'], required: false }],
  } as any);
  const gameByName = new Map<string, any>();
  for (const game of games as any[]) {
    const name = String(game?.name || '').trim().toLowerCase();
    if (name) gameByName.set(name, game);
  }

  const normalizedAccounts = gameAccounts.map((gameAccount: any) => {
    if (!gameAccount || typeof gameAccount !== 'object') return gameAccount;
    const gameName = String(gameAccount?.gameName || '').trim().toLowerCase();
    const game = gameByName.get(gameName);
    const providerCode = game?.Product?.providerCode;
    const accountId = typeof gameAccount?.accountId === 'string' ? gameAccount.accountId.trim() : '';
    if (!game || !accountId || !isJokerProviderCode(providerCode)) return gameAccount;

    const storedAccountId = getVendorAccountIdForStorage(providerCode, game, accountId);
    return {
      ...gameAccount,
      accountId: storedAccountId,
      displayAccountId: storedAccountId,
    };
  });

  return { ...metadata, gameAccounts: normalizedAccounts };
};

const validateMetadata = (metadata: any): string | null => {
  if (!metadata) return null;

  if (Array.isArray(metadata.playerBanks)) {
    const seen = new Set<string>();
    for (const pb of metadata.playerBanks) {
      const bankName = (pb?.bankName || '').trim().toLowerCase();
      const acc = (pb?.accountNumber || '').trim();
      if (!bankName || !acc) continue;
      const key = bankName + '|' + acc;
      if (seen.has(key)) {
        return 'P105';
      }
      seen.add(key);
    }
  }

  if (Array.isArray(metadata.gameAccounts)) {
    const seen = new Set<string>();
    for (const ga of metadata.gameAccounts) {
      const gameName = (ga?.gameName || '').trim().toLowerCase();
      const id = (ga?.accountId || '').trim().toLowerCase();
      if (!gameName || !id) continue;
      const key = gameName + '|' + id;
      if (seen.has(key)) {
        return 'P106';
      }
      seen.add(key);
    }
  }

  return null;
};

const checkGlobalPhoneNumberConflict = async (
  phoneNumber: string,
  scope: { tenant_id: number; sub_brand_id: number },
  excludePlayerId?: number
): Promise<string | null> => {
  if (!phoneNumber) return null;

  const players = await Player.findAll({
    attributes: ['id', 'metadata'],
    where: withTenancyWhere(scope),
  });

  for (const p of players) {
    const anyPlayer: any = p as any;
    if (excludePlayerId && anyPlayer.id === excludePlayerId) continue;
    const meta = anyPlayer.metadata;
    if (!meta) continue;

    const otherPhoneNumber = extractPhoneNumber(meta);
    if (otherPhoneNumber && otherPhoneNumber === phoneNumber) {
      return 'P110'; // Phone Number already exists
    }
  }

  return null;
};

const checkGlobalMetadataConflicts = async (
  bankKeys: Set<string>,
  gameKeys: Set<string>,
  scope: { tenant_id: number; sub_brand_id: number },
  excludePlayerId?: number
): Promise<string | null> => {
  if (bankKeys.size === 0 && gameKeys.size === 0) return null;

  const players = await Player.findAll({
    attributes: ['id', 'player_game_id', 'metadata'],
    where: withTenancyWhere(scope),
  });

  const bankKeyArr = Array.from(bankKeys);
  const gameKeyArr = Array.from(gameKeys);

  for (const p of players) {
    const anyPlayer: any = p as any;
    if (excludePlayerId && anyPlayer.id === excludePlayerId) continue;
    const meta = anyPlayer.metadata;
    if (!meta) continue;

    if (bankKeyArr.length > 0) {
      const otherBankKeys = extractBankKeys(meta);
      const conflict = bankKeyArr.some(k => otherBankKeys.has(k));
      if (conflict) {
        return 'P102';
      }
    }

    if (gameKeyArr.length > 0) {
      const otherGameKeys = extractGameKeys(meta);
      const conflict = gameKeyArr.some(k => otherGameKeys.has(k));
      if (conflict) {
        return 'P103';
      }
    }
  }

  return null;
};

const validateMetadataGlobalForCreate = async (
  metadata: any,
  scope: { tenant_id: number; sub_brand_id: number },
): Promise<string | null> => {
  if (!metadata) return null;
  
  // Check Phone Number uniqueness
  const phoneNumber = extractPhoneNumber(metadata);
  if (phoneNumber) {
    const phoneConflict = await checkGlobalPhoneNumberConflict(phoneNumber, scope);
    if (phoneConflict) return phoneConflict;
  }
  
  const bankKeys = extractBankKeys(metadata);
  const gameKeys = extractGameKeys(metadata);
  return checkGlobalMetadataConflicts(bankKeys, gameKeys, scope);
};

const validateMetadataGlobalForUpdate = async (
  newMetadata: any,
  oldMetadata: any,
  scope: { tenant_id: number; sub_brand_id: number },
  playerId: number
): Promise<string | null> => {
  if (!newMetadata) return null;

  // Check Phone Number uniqueness
  const newPhoneNumber = extractPhoneNumber(newMetadata);
  const oldPhoneNumber = extractPhoneNumber(oldMetadata || null);
  
  if (newPhoneNumber && newPhoneNumber !== oldPhoneNumber) {
    const phoneConflict = await checkGlobalPhoneNumberConflict(newPhoneNumber, scope, playerId);
    if (phoneConflict) return phoneConflict;
  }

  const newBankKeys = extractBankKeys(newMetadata);
  const newGameKeys = extractGameKeys(newMetadata);
  const oldBankKeys = extractBankKeys(oldMetadata || null);
  const oldGameKeys = extractGameKeys(oldMetadata || null);

  const diffBankKeys = new Set<string>();
  newBankKeys.forEach(k => {
    if (!oldBankKeys.has(k)) diffBankKeys.add(k);
  });

  const diffGameKeys = new Set<string>();
  newGameKeys.forEach(k => {
    if (!oldGameKeys.has(k)) diffGameKeys.add(k);
  });

  return checkGlobalMetadataConflicts(diffBankKeys, diffGameKeys, scope, playerId);
};

export const sanitizePlayerForResponse = (player: any, permissions: string[]) => {
  const canViewProfit = permissions.includes('view:player_profit');
  const canViewPlayerBanks = permissions.includes('view:player_banks');
  const json = player.toJSON ? player.toJSON() : { ...player };

  if (json.metadata) {
    const { createdByUsername, ...restMeta } = json.metadata;
    json.metadata = restMeta;
  }

  if (!canViewProfit) {
    if (Object.prototype.hasOwnProperty.call(json, 'total_in')) {
      json.total_in = null;
    }
    if (Object.prototype.hasOwnProperty.call(json, 'total_out')) {
      json.total_out = null;
    }
  }

  if (!canViewPlayerBanks && json.metadata && Array.isArray(json.metadata.playerBanks)) {
    json.metadata = {
      ...json.metadata,
      playerBanks: json.metadata.playerBanks.map((pb: any) => ({
        ...pb,
        accountNumber: '****',
      })),
    };
  }

  return json;
};

export const getPlayers = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const players = await Player.findAll({
      where: withTenancyWhere(scope),
      include: [{ model: Game, attributes: ['id', 'name'] }]
    });
    
    const userPermissions = req.user?.permissions || [];
    const sanitizedPlayers = players.map((player: any) => sanitizePlayerForResponse(player, userPermissions));

    sendSuccess(res, 'Code1', sanitizedPlayers);
  } catch (error) {
    sendError(res, 'Code800', 500);
  }
};

export const getPlayerList = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewProfit = userPermissions.includes('view:player_profit');
    const canViewUsers = userPermissions.includes('action:user_view');

    const startDateRaw = (req.query.startDate as string | undefined) || null;
    const endDateRaw = (req.query.endDate as string | undefined) || null;

    // Helper to parse "yyyy-MM-dd HH:mm:ss" as GMT+8
    const parseDateParam = (val: string) => {
      let s = val.trim();
      // If it looks like "yyyy-MM-dd HH:mm:ss", treat as GMT+8
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        s = s.replace(' ', 'T') + '+08:00';
      }
      return new Date(s);
    };

    const pageRaw = (req.query.page as string) || '1';
    const pageSizeRaw = (req.query.pageSize as string) || '50';
    let page = parseInt(pageRaw, 10);
    let pageSize = parseInt(pageSizeRaw, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 50;
    if (pageSize > 200) pageSize = 200;

    const includeMetaRaw =
      (req.query.includeMeta as string | undefined) ??
      (req.query.include_meta as string | undefined) ??
      null;
    const includeMeta =
      includeMetaRaw == null
        ? true
        : !['0', 'false', 'no'].includes(includeMetaRaw.trim().toLowerCase());

    const searchQuery = (req.query.q as string || '').trim();
    const searchType = (req.query.searchType as string || '').trim();
    const filterOpId = (req.query.operatorId as string || '').trim();
    const filterSource = (req.query.referralSource as string || '').trim();
    const filterTag = (req.query.tags as string || '').trim();

    const normalizeDigits = (val: string) => String(val || '').replace(/\D/g, '');
    const qLower = searchQuery.toLowerCase();
    const qDigits = normalizeDigits(searchQuery);
    const sourceLower = filterSource.toLowerCase();
    const operatorIdNum =
      filterOpId && !Number.isNaN(Number(filterOpId)) ? Number(filterOpId) : null;

    const createdCond: any = {};
    let hasRange = false;
    if (startDateRaw) {
      const d = parseDateParam(startDateRaw);
      if (!Number.isNaN(d.getTime())) {
        createdCond[Op.gte] = d;
        hasRange = true;
      }
    }
    if (endDateRaw) {
      const d = parseDateParam(endDateRaw);
      if (!Number.isNaN(d.getTime())) {
        createdCond[Op.lte] = d;
        hasRange = true;
      }
    }
    const hasTextSearch = searchQuery.length > 0;
    const effectiveSearchType = searchType || 'player_game_id';

    const whereConditions: any[] = [];

    const shouldApplyCreatedAtRange = hasRange && !(hasTextSearch && effectiveSearchType === 'player_game_id');
    if (shouldApplyCreatedAtRange) {
      whereConditions.push({ createdAt: createdCond });
    }

    if (filterTag) {
      whereConditions.push(
        sequelize.where(
          sequelize.fn(
            'JSON_CONTAINS',
            sequelize.col('tags'),
            JSON.stringify(filterTag),
            '$',
          ),
          1,
        ),
      );
    }

    if (operatorIdNum != null) {
      whereConditions.push(
        sequelize.where(
          sequelize.fn(
            'JSON_UNQUOTE',
            sequelize.fn('JSON_EXTRACT', sequelize.col('metadata'), '$.createdByUserId'),
          ),
          String(operatorIdNum),
        ),
      );
    }

    if (filterSource) {
      whereConditions.push(
        sequelize.where(
          sequelize.fn(
            'LOWER',
            sequelize.fn(
              'JSON_UNQUOTE',
              sequelize.fn('JSON_EXTRACT', sequelize.col('metadata'), '$.referralSource'),
            ),
          ),
          sourceLower,
        ),
      );
    }

    if (hasTextSearch && effectiveSearchType === 'player_game_id') {
      whereConditions.push({
        player_game_id: { [Op.like]: `%${searchQuery}%` },
      });
    }

    if (hasTextSearch && effectiveSearchType === 'phone') {
      if (!qDigits) {
        return sendSuccess(res, 'Code1', {
          players: [],
          pagination: { page, pageSize, totalItems: 0, totalPages: 0 },
          ...(includeMeta ? {} : {}),
        });
      }
      whereConditions.push(
        sequelize.where(
          sequelize.fn(
            'JSON_UNQUOTE',
            sequelize.fn('JSON_EXTRACT', sequelize.col('metadata'), '$.phoneNumber'),
          ),
          { [Op.like]: `%${qDigits}%` },
        ),
      );
    }

    if (hasTextSearch && effectiveSearchType === 'full_name') {
      if (!qLower) {
        return sendSuccess(res, 'Code1', {
          players: [],
          pagination: { page, pageSize, totalItems: 0, totalPages: 0 },
          ...(includeMeta ? {} : {}),
        });
      }
      whereConditions.push(
        sequelize.where(
          sequelize.fn(
            'LOWER',
            sequelize.fn(
              'JSON_UNQUOTE',
              sequelize.fn('JSON_EXTRACT', sequelize.col('metadata'), '$.fullName'),
            ),
          ),
          { [Op.like]: `%${qLower}%` },
        ),
      );
    }

    const finalWhere: any =
      whereConditions.length > 0 ? { [Op.and]: whereConditions } : {};

    const needsMetadataScan =
      effectiveSearchType === 'bank_account' || effectiveSearchType === 'game_account';

    const listCacheKey = [
      'pl_list_v2',
      scope.tenant_id,
      scope.sub_brand_id,
      includeMeta ? 'm1' : 'm0',
      canViewProfit ? 'p1' : 'p0',
      canViewUsers ? 'u1' : 'u0',
      req.user?.id ?? 0,
      page,
      pageSize,
      startDateRaw || '',
      endDateRaw || '',
      searchQuery || '',
      effectiveSearchType || '',
      filterOpId || '',
      filterSource || '',
      filterTag || '',
    ].join(':');
    const cached = getCache(listCacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=3');
      return sendSuccess(res, 'Code1', cached);
    }

    const games = await Game.findAll({
      attributes: ['id', 'name', 'icon', 'vendor_config'],
      where: withTenancyWhere(scope, { status: 'active' }),
      include: [{ model: Product, attributes: ['providerCode'], required: false }],
    } as any);

    const [bankCatalog, referralSetting, tagSetting, allOperators] = includeMeta
      ? await Promise.all([
          BankCatalog.findAll(),
          getSettingValue(scope, 'referralSources'),
          getSettingValue(scope, 'tagOptions'),
          canViewUsers
            ? User.findAll({
                attributes: ['id', 'username', 'full_name'],
                where: { tenant_id: scope.tenant_id, status: 'active' } as any,
                order: [['username', 'ASC']],
              } as any)
            : ([] as any[]),
        ])
      : ([[] as any[], null as any, null as any, [] as any[]] as const);

    const sortOrder: any = [['createdAt', 'DESC']];
    const offset = (page - 1) * pageSize;

    let totalItems = 0;
    let pagedPlayersRaw: any[] = [];

    if (!needsMetadataScan) {
      const result = await Player.findAndCountAll({
        where: withTenancyWhere(scope, finalWhere),
        order: sortOrder,
        limit: pageSize,
        offset,
      } as any);
      pagedPlayersRaw = (result.rows as any[]) || [];
      totalItems =
        typeof result.count === 'number' ? result.count : (result.count as any[]).length;
    } else {
      const all = await Player.findAll({
        where: withTenancyWhere(scope, finalWhere),
        order: sortOrder,
      } as any);

      const filtered = (all as any[]).filter((p) => {
        const json = p?.toJSON ? p.toJSON() : p;
        const meta = json?.metadata && typeof json.metadata === 'object' ? json.metadata : {};
        const tags = Array.isArray(json?.tags) ? json.tags : [];

        if (filterTag) {
          if (!tags.includes(filterTag)) return false;
        }

        if (operatorIdNum != null) {
          const createdBy = meta.createdByUserId;
          if (createdBy !== operatorIdNum) return false;
        }

        if (filterSource) {
          const src = String(meta.referralSource || '').toLowerCase();
          if (src !== sourceLower) return false;
        }

        if (!hasTextSearch) return true;
        if (effectiveSearchType === 'bank_account') {
          const banks = Array.isArray(meta.playerBanks) ? meta.playerBanks : [];
          if (!qDigits) return false;
          return banks.some((b: any) => normalizeDigits(b?.accountNumber).includes(qDigits));
        }

        if (effectiveSearchType === 'game_account') {
          const gamesArr = Array.isArray(meta.gameAccounts) ? meta.gameAccounts : [];
          if (!qLower) return false;
          return gamesArr.some((g: any) => String(g?.accountId || '').toLowerCase().includes(qLower));
        }

        return false;
      });

      totalItems = filtered.length;
      const totalPagesTmp = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
      if (page > totalPagesTmp && totalPagesTmp > 0) {
        page = totalPagesTmp;
      }
      const startIndex = (page - 1) * pageSize;
      pagedPlayersRaw = totalItems === 0 ? [] : filtered.slice(startIndex, startIndex + pageSize);
    }

    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
    if (page > totalPages && totalPages > 0) {
      page = totalPages;
    }

    type AggregatedStats = {
      lastDepositDate: string | null;
      lastWithdrawDate: string | null;
      depositCount: number;
      withdrawCount: number;
      totalDeposit: number;
      totalWithdraw: number;
      totalWalve: number;
      totalTips: number;
      totalBonus: number;
    };

    const statsMap = new Map<number, AggregatedStats>();
    const pagedPlayerIds = (pagedPlayersRaw as any[])
      .map((p) => Number(p?.id ?? null))
      .filter((id) => Number.isFinite(id) && id > 0);

    const latestVendorCreditAfter = new Map<string, number>();
    if (pagedPlayerIds.length > 0) {
      try {
        const rows = await Transaction.findAll({
          attributes: ['player_id', 'game_id', 'vendor_credit_after', 'updatedAt', 'createdAt'],
          where: withTenancyWhere(scope, {
            player_id: { [Op.in]: pagedPlayerIds },
            status: { [Op.in]: ['COMPLETED', 'REJECTED'] },
            vendor_credit_after: { [Op.ne]: null },
            game_id: { [Op.ne]: null },
          } as any),
          order: [['updatedAt', 'DESC'], ['createdAt', 'DESC']],
          limit: 5000,
        } as any);

        for (const r of rows as any[]) {
          const pid = Number(r?.player_id ?? null);
          const gid = Number(r?.game_id ?? null);
          if (!Number.isFinite(pid) || pid <= 0) continue;
          if (!Number.isFinite(gid) || gid <= 0) continue;
          const key = `${pid}:${gid}`;
          if (latestVendorCreditAfter.has(key)) continue;
          const raw = (r as any).vendor_credit_after;
          const n = typeof raw === 'number' ? raw : (raw != null ? Number(raw) : NaN);
          if (!Number.isFinite(n)) continue;
          latestVendorCreditAfter.set(key, n);
        }
      } catch {
      }
    }

    if (pagedPlayerIds.length > 0) {
      const statsAgg = await PlayerStats.findAll({
        attributes: [
          'player_id',
          [sequelize.fn('MAX', sequelize.col('last_deposit_at')), 'last_deposit_at'],
          [sequelize.fn('MAX', sequelize.col('last_withdraw_at')), 'last_withdraw_at'],
          [sequelize.fn('SUM', sequelize.col('deposit_count')), 'deposit_count'],
          [sequelize.fn('SUM', sequelize.col('withdraw_count')), 'withdraw_count'],
          [sequelize.fn('SUM', sequelize.col('total_deposit')), 'total_deposit'],
          [sequelize.fn('SUM', sequelize.col('total_withdraw')), 'total_withdraw'],
          [sequelize.fn('SUM', sequelize.col('total_walve')), 'total_walve'],
          [sequelize.fn('SUM', sequelize.col('total_tips')), 'total_tips'],
          [sequelize.fn('SUM', sequelize.col('total_bonus')), 'total_bonus'],
        ],
        where: {
          player_id: { [Op.in]: pagedPlayerIds },
          [Op.or]: [
            { tenant_id: scope.tenant_id, sub_brand_id: scope.sub_brand_id },
            { tenant_id: null, sub_brand_id: null },
          ],
        } as any,
        group: ['player_id'],
        raw: true,
      } as any);

      for (const row of statsAgg as any[]) {
        const playerId = Number(row.player_id ?? null);
        if (!Number.isFinite(playerId) || playerId <= 0) continue;
        const lastDepositAt = row.last_deposit_at ? new Date(row.last_deposit_at) : null;
        const lastWithdrawAt = row.last_withdraw_at ? new Date(row.last_withdraw_at) : null;
        statsMap.set(playerId, {
          lastDepositDate: lastDepositAt && !Number.isNaN(lastDepositAt.getTime()) ? lastDepositAt.toISOString() : null,
          lastWithdrawDate: lastWithdrawAt && !Number.isNaN(lastWithdrawAt.getTime()) ? lastWithdrawAt.toISOString() : null,
          depositCount: Number(row.deposit_count || 0),
          withdrawCount: Number(row.withdraw_count || 0),
          totalDeposit: Number(row.total_deposit || 0),
          totalWithdraw: Number(row.total_withdraw || 0),
          totalWalve: Number(row.total_walve || 0),
          totalTips: Number(row.total_tips || 0),
          totalBonus: Number(row.total_bonus || 0),
        });
      }
    }

    const createdByIdsSet = new Set<number>();
    for (const p of pagedPlayersRaw as any[]) {
      const json = p?.toJSON ? p.toJSON() : p;
      const meta = json?.metadata && typeof json.metadata === 'object' ? json.metadata : {};
      const cid = Number(meta?.createdByUserId ?? null);
      if (Number.isFinite(cid) && cid > 0) createdByIdsSet.add(cid);
    }
    if (req.user?.id) createdByIdsSet.add(Number(req.user.id));

    const operatorIdSet = new Set<number>((allOperators as any[]).map((u: any) => Number(u.id)));
    const extraIds = Array.from(createdByIdsSet).filter((id) => !operatorIdSet.has(id));
    let extraUsers: any[] = [];
    if (extraIds.length > 0) {
      extraUsers = (await User.findAll({
        attributes: ['id', 'username', 'full_name'],
        where: withTenancyWhere(scope, { id: { [Op.in]: extraIds }, status: 'active' } as any),
      } as any)) as any[];
    }

    const createdByUserMap = new Map<number, { full_name: string | null; username: string | null }>();
    for (const u of [...(allOperators as any[]), ...extraUsers]) {
      const name = resolveOperatorName(u);
      if (name) {
        createdByUserMap.set(u.id, { full_name: name, username: u.username || null });
      } else {
        createdByUserMap.set(u.id, {
          full_name:
            typeof u.full_name === 'string' && u.full_name.trim().length > 0 ? u.full_name.trim() : null,
          username: u.username || null,
        });
      }
    }

    const gameAppIdByNameLower = new Map<string, string>();
    const gameProviderCodeByNameLower = new Map<string, number>();
    for (const g of games as any[]) {
      const name = typeof g?.name === 'string' ? g.name.trim() : '';
      if (!name) continue;
      const providerCode = Number((g as any)?.Product?.providerCode);
      if (Number.isFinite(providerCode)) {
        gameProviderCodeByNameLower.set(name.toLowerCase(), providerCode);
      }
      let cfg: any = (g as any).vendor_config;
      if (typeof cfg === 'string') {
        const s = cfg.trim();
        if (s.startsWith('{') || s.startsWith('[')) {
          try {
            cfg = JSON.parse(s);
          } catch {
            cfg = null;
          }
        } else {
          cfg = null;
        }
      }
      const appId = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? String((cfg as any).appId || '').trim() : '';
      if (!appId) continue;
      gameAppIdByNameLower.set(name.toLowerCase(), appId);
    }

    const gameIdByNameLower = new Map<string, number>();
    for (const g of games as any[]) {
      const name = typeof g?.name === 'string' ? g.name.trim() : '';
      const id = Number(g?.id ?? null);
      if (!name) continue;
      if (!Number.isFinite(id) || id <= 0) continue;
      gameIdByNameLower.set(name.toLowerCase(), id);
    }

    const playersPayload = (pagedPlayersRaw as any[]).map((p: any) => {
      const sanitized = sanitizePlayerForResponse(p, userPermissions);
      const json = sanitized?.toJSON ? sanitized.toJSON() : { ...sanitized };

      const metadataRaw = json.metadata || {};
      const createdByUserId = metadataRaw.createdByUserId;
      let createdByFullName: string | null = null;
      if (typeof createdByUserId === 'number' && Number.isFinite(createdByUserId)) {
        const u = createdByUserMap.get(createdByUserId);
        if (u) {
          createdByFullName = u.full_name || u.username || null;
        }
      }
      const metadata = { ...metadataRaw, createdByFullName };
      const gameAccountsRaw = Array.isArray((metadata as any).gameAccounts) ? (metadata as any).gameAccounts : [];
      if (gameAccountsRaw.length > 0) {
        const nextGameAccounts = gameAccountsRaw.map((ga: any) => {
          if (!ga || typeof ga !== 'object') return ga;
          const name = typeof ga.gameName === 'string' ? ga.gameName.trim().toLowerCase() : '';
          const gid = name ? (gameIdByNameLower.get(name) ?? null) : null;
          if (!gid) return ga;
          const key = `${json.id}:${gid}`;
          const val = latestVendorCreditAfter.get(key);
          if (val == null) return ga;
          const walletCredit = (ga as any).walletCredit;
          const current = walletCredit != null ? Number(walletCredit) : NaN;
          if (Number.isFinite(current) && current === val) return ga;
          return { ...ga, walletCredit: val };
        });

        const nextGameAccountsWithDisplay = nextGameAccounts.map((ga: any) => {
          if (!ga || typeof ga !== 'object') return ga;
          const name = typeof ga.gameName === 'string' ? ga.gameName.trim().toLowerCase() : '';
          const appId = name ? (gameAppIdByNameLower.get(name) ?? '') : '';
          const providerCode = name ? gameProviderCodeByNameLower.get(name) : undefined;
          const accountId = typeof ga.accountId === 'string' ? ga.accountId.trim() : '';
          const displayAccountId = getVendorDisplayAccountId(providerCode, accountId, appId);
          if (!displayAccountId) return ga;
          return isJokerProviderCode(providerCode)
            ? { ...ga, accountId: displayAccountId, displayAccountId }
            : { ...ga, displayAccountId };
        });

        (metadata as any).gameAccounts = nextGameAccountsWithDisplay;
      }

      const stats = statsMap.get(json.id) || {
        lastDepositDate: null,
        lastWithdrawDate: null,
        depositCount: 0,
        withdrawCount: 0,
        totalDeposit: 0,
        totalWithdraw: 0,
        totalWalve: 0,
        totalTips: 0,
        totalBonus: 0,
      };

      const netProfit = canViewProfit ? stats.totalDeposit - stats.totalWithdraw : null;

      let tags = json.tags;
      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch (e) {
          tags = [];
        }
      }
      if (!Array.isArray(tags)) tags = [];

      return {
        id: json.id,
        player_game_id: json.player_game_id,
        profile_uuid: (json as any).profile_uuid || null,
        tags,
        metadata,
        netProfit,
        created_at: json.created_at || json.createdAt || null,
        updated_at: json.updated_at || json.updatedAt || null,
        stats: {
          lastDepositDate: stats.lastDepositDate,
          lastWithdrawDate: stats.lastWithdrawDate,
          depositCount: stats.depositCount,
          withdrawCount: stats.withdrawCount,
          totalDeposit: canViewProfit ? stats.totalDeposit : null,
          totalWithdraw: canViewProfit ? stats.totalWithdraw : null,
        },
        bonusStats: {
          totalWalve: canViewProfit ? stats.totalWalve : null,
          totalTips: canViewProfit ? stats.totalTips : null,
          totalBonus: canViewProfit ? stats.totalBonus : null,
        },
      };
    });

    const bankNameOptions = (bankCatalog as any[])
      .map((b) => (b && typeof b.name === 'string' ? b.name : null))
      .filter((name): name is string => !!name && name.trim().length > 0);

    const gameNameOptions = (games as any[])
      .map((g) => (g && typeof g.name === 'string' ? g.name : null))
      .filter((name): name is string => !!name && name.trim().length > 0);

    const gameIconMap: Record<string, string | null> = {};
    for (const g of games as any[]) {
      if (!g || !g.name) continue;
      gameIconMap[g.name] = g.icon || null;
    }

    const bankIconMap: Record<string, string | null> = {};
    for (const bc of bankCatalog as any[]) {
      if (!bc || !bc.name) continue;
      bankIconMap[bc.name] = bc.icon || null;
    }
    
    // Add operator options for frontend filter
    let operatorOptions: any[] = [];
    if (canViewUsers) {
      operatorOptions = (allOperators as any[])
        .map((u) => {
          const name = resolveOperatorName(u);
          return name ? { id: u.id, name } : null;
        })
        .filter(Boolean);
    } else if (req.user) {
       const name = resolveOperatorName(req.user);
       if (name) {
          operatorOptions = [{ id: req.user.id, name }];
       }
    }

    let referralValue = referralSetting as any;
    // Handle double-encoded JSON string for referralSources
    if (typeof referralValue === 'string' && referralValue.startsWith('[')) {
      try {
        referralValue = JSON.parse(referralValue);
      } catch (e) { /* ignore */ }
    }

    const referralSourceOptions = Array.isArray(referralValue)
      ? referralValue.filter(
          (v: any) => typeof v === 'string' && v.trim().length > 0
        )
      : [];

    let tagValue = tagSetting as any;
    // Handle double-encoded JSON string for tagOptions
    if (typeof tagValue === 'string' && tagValue.startsWith('[')) {
      try {
        tagValue = JSON.parse(tagValue);
      } catch (e) { /* ignore */ }
    }

    const tagOptions = Array.isArray(tagValue)
      ? tagValue
          .filter((t: any) => t && typeof t.name === 'string')
          .map((t: any) => ({
            name: t.name,
            color: t.color || '#3B82F6',
          }))
      : [];

    const pagedPlayers = playersPayload;

    let subBrandOptions: any[] = [];
    if (includeMeta) {
      try {
        const requesterId = req.user?.id;
        const requester: any = requesterId
          ? await User.findByPk(requesterId, {
              attributes: ['id', 'username', 'full_name', 'tenant_id', 'sub_brand_id', 'is_super_admin'],
              include: [{ model: Role, through: { attributes: [] }, required: false }],
            } as any)
          : null;

        if (requester) {
          const isSuperAdmin =
            Boolean(req.user?.is_super_admin) ||
            Boolean(requester?.is_super_admin) ||
            Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'super admin'));
          const isOperator = Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'operator'));

          let rows: any[] = [];
          if (isSuperAdmin) {
            rows = await SubBrand.findAll({ order: [['id', 'ASC']] });
          } else if (isOperator) {
            const tid = Number(requester?.tenant_id ?? null);
            if (Number.isFinite(tid) && tid > 0) {
              rows = await SubBrand.findAll({ where: { tenant_id: tid } as any, order: [['id', 'ASC']] });
            }
          } else {
            const sbid = Number(req.user?.sub_brand_id ?? requester?.sub_brand_id ?? null);
            if (Number.isFinite(sbid) && sbid > 0) {
              rows = await SubBrand.findAll({ where: { id: sbid } as any, order: [['id', 'ASC']] });
            }
          }

          subBrandOptions = (rows as any[]).map((sb: any) => ({
            id: sb.id,
            tenant_id: (sb as any).tenant_id ?? null,
            code: (sb as any).code ?? null,
            name: (sb as any).name ?? null,
            status: (sb as any).status ?? null,
          }));
        }
      } catch (e) {
        void e;
      }
    }

    const payload: any = {
      players: pagedPlayers,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    };

    if (includeMeta) {
      payload.bankNameOptions = bankNameOptions;
      payload.gameNameOptions = gameNameOptions;
      payload.gameIconMap = gameIconMap;
      payload.bankIconMap = bankIconMap;
      payload.referralSourceOptions = referralSourceOptions;
      payload.tagOptions = tagOptions;
      payload.operatorOptions = operatorOptions;
      payload.subBrandOptions = subBrandOptions;
    }

    setCache(listCacheKey, payload, 3);
    res.setHeader('Cache-Control', 'private, max-age=3');
    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    sendError(res, 'Code801', 500);
  }
};

export const getPlayerListContext = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewUsers = userPermissions.includes('action:user_view');
    const cacheKey = `plc:${scope.tenant_id}:${scope.sub_brand_id}:${canViewUsers ? 'withUsers' : 'self'}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return sendSuccess(res, 'Code1', cached);
    }

    const [referralSetting, tagSetting, allOperators] = await Promise.all([
      getSettingValue(scope, 'referralSources'),
      getSettingValue(scope, 'tagOptions'),
      canViewUsers
        ? User.findAll({
            attributes: ['id', 'username', 'full_name'],
            where: { tenant_id: scope.tenant_id, status: 'active' } as any,
            order: [['username', 'ASC']],
          } as any)
        : [] as any[],
    ]);

    let operatorOptions: any[] = [];
    if (canViewUsers) {
      operatorOptions = (allOperators as any[])
        .map((u) => {
          const name = resolveOperatorName(u);
          return name ? { id: u.id, name } : null;
        })
        .filter(Boolean);
    } else if (req.user) {
      const name = resolveOperatorName(req.user);
      if (name) {
        operatorOptions = [{ id: req.user.id, name }];
      }
    }

    let referralValue = referralSetting as any;
    if (typeof referralValue === 'string' && referralValue.startsWith('[')) {
      try {
        referralValue = JSON.parse(referralValue);
      } catch (e) {
        void e;
      }
    }
    const referralSourceOptions = Array.isArray(referralValue)
      ? referralValue.filter((v: any) => typeof v === 'string' && v.trim().length > 0)
      : [];

    let tagValue = tagSetting as any;
    if (typeof tagValue === 'string' && tagValue.startsWith('[')) {
      try {
        tagValue = JSON.parse(tagValue);
      } catch (e) {
        void e;
      }
    }
    const tagOptions = Array.isArray(tagValue)
      ? tagValue
          .filter((t: any) => t && typeof t.name === 'string')
          .map((t: any) => ({
            name: t.name,
            color: t.color || '#3B82F6',
          }))
      : [];

    let subBrandOptions: any[] = [];
    try {
      const requesterId = req.user?.id;
      const requester: any = requesterId
        ? await User.findByPk(requesterId, {
            attributes: ['id', 'username', 'full_name', 'tenant_id', 'sub_brand_id', 'is_super_admin'],
            include: [{ model: Role, through: { attributes: [] }, required: false }],
          } as any)
        : null;

      if (requester) {
        const isSuperAdmin =
          Boolean(req.user?.is_super_admin) ||
          Boolean(requester?.is_super_admin) ||
          Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'super admin'));
        const isOperator = Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'operator'));

        let rows: any[] = [];
        if (isSuperAdmin) {
          rows = await SubBrand.findAll({ order: [['id', 'ASC']] });
        } else if (isOperator) {
          const tid = Number(requester?.tenant_id ?? null);
          if (Number.isFinite(tid) && tid > 0) {
            rows = await SubBrand.findAll({ where: { tenant_id: tid } as any, order: [['id', 'ASC']] });
          }
        } else {
          const sbid = Number(req.user?.sub_brand_id ?? requester?.sub_brand_id ?? null);
          if (Number.isFinite(sbid) && sbid > 0) {
            rows = await SubBrand.findAll({ where: { id: sbid } as any, order: [['id', 'ASC']] });
          }
        }

        subBrandOptions = (rows as any[]).map((sb: any) => ({
          id: sb.id,
          tenant_id: (sb as any).tenant_id ?? null,
          code: (sb as any).code ?? null,
          name: (sb as any).name ?? null,
          status: (sb as any).status ?? null,
        }));
      }
    } catch (e) {
      void e;
    }

    const payload = {
      operatorOptions,
      referralSourceOptions,
      tagOptions,
      subBrandOptions,
    };
    setCache(cacheKey, payload, 300);
    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    sendError(res, 'Code822', 500);
  }
};

export const searchPlayers = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const qRaw = (req.query.q as string | undefined) || '';
    const q = qRaw.trim();
    if (!q) {
      sendSuccess(res, 'Code1', []);
      return;
    }

    const limit = 50;

    const include = [{ model: Game, attributes: ['id', 'name'], required: false, where: withTenancyWhere(scope) as any }];

    const exactPlayer = await Player.findOne({
      where: withTenancyWhere(scope, { player_game_id: q }),
      include,
    } as any);

    const playersLike = await Player.findAll({
      where: {
        ...withTenancyWhere(scope, {
          player_game_id: {
            [Op.like]: `%${q}%`,
          },
        }),
      },
      include,
      order: [['id', 'DESC']],
      limit,
    } as any);

    const combined = [...playersLike];
    if (exactPlayer) {
      const exactId = (exactPlayer as any).id ?? exactPlayer.get?.('id');
      const exists = combined.some((p: any) => (p.id ?? p.get?.('id')) === exactId);
      if (!exists) combined.unshift(exactPlayer as any);
    }
    const players = combined.slice(0, limit);

    const userPermissions = req.user?.permissions || [];
    const sanitizedPlayers = players.map((player: any) =>
      sanitizePlayerForResponse(player, userPermissions)
    );

    const activeGames = await Game.findAll({
      attributes: ['name', 'vendor_config'],
      where: withTenancyWhere(scope, { status: 'active' }),
      include: [{ model: Product, attributes: ['providerCode'], required: false }],
    } as any);
    const activeGameNames = new Set(
      (activeGames as any[]).map((g) =>
        String(g.name || '').trim().toLowerCase(),
      ),
    );

    const gameAppIdByNameLower = new Map<string, string>();
    const gameProviderCodeByNameLower = new Map<string, number>();
    for (const g of activeGames as any[]) {
      const name = String(g?.name || '').trim().toLowerCase();
      if (!name) continue;
      const providerCode = Number((g as any)?.Product?.providerCode);
      if (Number.isFinite(providerCode)) {
        gameProviderCodeByNameLower.set(name, providerCode);
      }
      let cfg: any = (g as any).vendor_config;
      if (typeof cfg === 'string') {
        const s = cfg.trim();
        if (s.startsWith('{') || s.startsWith('[')) {
          try {
            cfg = JSON.parse(s);
          } catch {
            cfg = null;
          }
        } else {
          cfg = null;
        }
      }
      const appId = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? String((cfg as any).appId || '').trim() : '';
      if (!appId) continue;
      gameAppIdByNameLower.set(name, appId);
    }

    const payload = sanitizedPlayers.map((p: any) => {
      const json = p.toJSON ? p.toJSON() : { ...p };
      const metadata = json.metadata || {};
      const gameAccountsRaw = Array.isArray(metadata.gameAccounts)
        ? metadata.gameAccounts
        : [];
      const gameAccounts = gameAccountsRaw.filter((ga: any) => {
        const name = String(ga?.gameName || '').trim().toLowerCase();
        if (!name) return false;
        return activeGameNames.has(name);
      }).map((ga: any) => {
        const name = String(ga?.gameName || '').trim().toLowerCase();
        const appId = name ? (gameAppIdByNameLower.get(name) ?? '') : '';
        const providerCode = name ? gameProviderCodeByNameLower.get(name) : undefined;
        const accountId = typeof ga?.accountId === 'string' ? ga.accountId.trim() : '';
        const displayAccountId = getVendorDisplayAccountId(providerCode, accountId, appId);
        if (!displayAccountId) return ga;
        return isJokerProviderCode(providerCode)
          ? { ...ga, accountId: displayAccountId, displayAccountId }
          : { ...ga, displayAccountId };
      });
      return {
        id: json.id,
        player_game_id: json.player_game_id,
        gameAccounts,
      };
    });

    await logAudit(
      req.user?.id ?? null,
      'PLAYER_SEARCH',
      { q, limit },
      { count: payload.length },
      getClientIp(req) || null
    );

    sendSuccess(res, 'Code1', payload);
  } catch (error: any) {
    sendError(res, 'Code802', 500);
  }
};

const generateNextPlayerId = async (scope: { tenant_id: number; sub_brand_id: number }): Promise<string> => {
  const sb = await SubBrand.findOne({ where: { id: scope.sub_brand_id, tenant_id: scope.tenant_id } as any } as any);
  const rawPrefix = typeof (sb as any)?.code === 'string' ? String((sb as any).code).trim() : '';
  const cleanedPrefix = rawPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = cleanedPrefix.length > 0 ? cleanedPrefix : `SB${scope.sub_brand_id}`;

  const random6 = () => {
    const value = randomBytes(4).readUInt32BE(0) % 999999;
    return String(value + 1).padStart(6, '0');
  };

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${prefix}${random6()}`;
    const exists = await Player.findOne({
      where: withTenancyWhere(scope, { player_game_id: candidate }),
      attributes: ['id'],
    } as any);
    if (!exists) return candidate;
  }

  throw new Error('FAILED_TO_GENERATE_UNIQUE_PLAYER_ID');
};

export const getNextPlayerId = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const nextId = await generateNextPlayerId(scope);
    sendSuccess(res, 'Code1', { nextPlayerId: nextId });
  } catch (error) {
    sendError(res, 'Code803', 500);
  }
};

export const retryCreateGameAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const includeVendorRaw = Boolean((req as any)?.user?.is_super_admin);
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      sendError(res, 'Code804', 400);
      return;
    }

    const gameNameRaw = (req.body?.gameName as string | undefined) || '';
    const gameName = gameNameRaw.trim();
    if (!gameName) {
      sendError(res, 'Code805', 400);
      return;
    }

    const player = await Player.findOne({ where: withTenancyWhere(scope, { id: playerId }) } as any);
    if (!player) {
      sendError(res, 'Code806', 404);
      return;
    }

    const existingMeta: any = (player as any).metadata || {};
    const existingAccounts: any[] = Array.isArray(existingMeta.gameAccounts) ? existingMeta.gameAccounts : [];
    const existing = existingAccounts.find((ga) => String(ga?.gameName || '').trim().toLowerCase() === gameName.toLowerCase());
    const existingAttemptedIds: string[] = Array.isArray(existing?.attemptedIds) ? existing.attemptedIds.map((s: any) => String(s)) : [];
    const game = await Game.findOne({
      where: withTenancyWhere(scope, { name: gameName, status: 'active', use_api: true }),
      include: [{ model: Product, attributes: ['providerCode'], required: false }],
    } as any);
    if (!game) {
      sendError(res, 'Code807', 400);
      return;
    }

    const providerCode = (game as any)?.Product?.providerCode;
    if (existing && String(existing.accountId || '').trim() && (existing.provisioningStatus || 'CREATED') === 'CREATED') {
      const storedAccountId = getVendorAccountIdForStorage(providerCode, game, existing.accountId);
      const normalizedExisting = isJokerProviderCode(providerCode)
        ? { ...existing, accountId: storedAccountId, displayAccountId: storedAccountId }
        : existing;
      if (storedAccountId !== String(existing.accountId).trim()) {
        (player as any).metadata = {
          ...existingMeta,
          gameAccounts: existingAccounts.map((gameAccount) => gameAccount === existing ? normalizedExisting : gameAccount),
        };
        await player.save();
      }
      sendSuccess(res, 'Code1', { gameAccount: normalizedExisting, idempotent: true });
      return;
    }

    const vendor = await VendorFactory.getServiceByProviderCode(providerCode, (game as any).id);
    if (!vendor) {
      sendError(res, 'Code808', 400);
      return;
    }

    const baseAccountId = String((player as any).player_game_id || '').trim();
    const jokerSubBrandCode = isJokerProviderCode(providerCode)
      ? String((await SubBrand.findOne({
        where: { id: scope.sub_brand_id, tenant_id: scope.tenant_id } as any,
        attributes: ['code'],
      } as any) as any)?.code || '')
      : '';
    const attemptedIds: string[] = [];
    const candidates = new Set<string>();
    let finalAccountId = generateInitialVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
    let result: any = null;
    let created = false;

    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate =
        attempt === 0 ? finalAccountId : (() => {
          let next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
          let guard = 0;
          while (candidates.has(next) && guard < 10) {
            next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
            guard++;
          }
          return next;
        })();
      candidates.add(candidate);
      attemptedIds.push(candidate);
      result = await vendor.createPlayer(candidate);
      if (result?.success) {
        if (!isVendorConflict(result)) {
          finalAccountId = candidate;
          created = true;
          break;
        }
        const previouslyAttempted = existingAttemptedIds.some((id) => String(id).trim().toLowerCase() === String(candidate).trim().toLowerCase());
        if (previouslyAttempted) {
          finalAccountId = candidate;
          created = true;
          break;
        }
        continue;
      }
      break;
    }

    if (!created) {
      if (isVendorConflict(result)) {
        const nextAccounts = existingAccounts
          .filter((ga) => String(ga?.gameName || '').trim().toLowerCase() !== gameName.toLowerCase())
          .concat({
            gameName,
            accountId: '',
            password: undefined,
            provisioningStatus: 'SKIPPED_CONFLICT',
            attemptedIds,
          });
        (player as any).metadata = { ...existingMeta, gameAccounts: nextAccounts };
        await player.save();
        await logAudit(
          req.user?.id ?? null,
          'VENDOR_RETRY_CREATE_SKIPPED_CONFLICT',
          { playerId, gameName },
          { attemptedIds, vendorRaw: (result as any)?.raw },
          getClientIp(req) || null
        );
        sendError(res, 'Code809', 409, { attemptedIds, vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined });
        return;
      }
      const nextAccounts = existingAccounts
        .filter((ga) => String(ga?.gameName || '').trim().toLowerCase() !== gameName.toLowerCase())
        .concat({
          gameName,
          accountId: '',
          password: undefined,
          provisioningStatus: 'PENDING_RETRY',
          attemptedIds,
          error: result?.error || 'PV001',
        });
      (player as any).metadata = { ...existingMeta, gameAccounts: nextAccounts };
      await player.save();
      await logAudit(
        req.user?.id ?? null,
        'VENDOR_RETRY_CREATE_FAILED',
        { playerId, gameName },
        { error: result?.error || 'PV001', attemptedIds, vendorRaw: (result as any)?.raw },
        getClientIp(req) || null
      );
      sendError(res, 'Code809', 400, { detail: result?.error || 'PV001', attemptedIds, vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined });
      return;
    }

    const rawProviderUsername =
      (result as any)?.raw?.data?.Data?.Username ||
      (result as any)?.raw?.data?.Username ||
      finalAccountId;
    const providerUsername = getVendorAccountIdForStorage(providerCode, game, rawProviderUsername);
    const displayAccountId = isJokerProviderCode(providerCode)
      ? providerUsername
      : undefined;
    const FIXED_PASSWORD = 'Abcd12345';
    const pwdResult = await vendor.setPlayerPassword(providerUsername, FIXED_PASSWORD);
    const password = pwdResult.success ? FIXED_PASSWORD : undefined;

    const nextAccounts = existingAccounts
      .filter((ga) => String(ga?.gameName || '').trim().toLowerCase() !== gameName.toLowerCase())
      .concat({
        gameName,
        accountId: providerUsername,
        displayAccountId,
        password,
        provisioningStatus: 'CREATED',
        attemptedIds,
      });
    (player as any).metadata = { ...existingMeta, gameAccounts: nextAccounts };
    await player.save();

    await logAudit(
      req.user?.id ?? null,
      'VENDOR_RETRY_CREATE_SUCCESS',
      { playerId, gameName, accountId: providerUsername },
      { passwordSet: pwdResult.success, attemptedIds, vendorRaw: (result as any)?.raw, vendorPasswordRaw: (pwdResult as any)?.raw },
      getClientIp(req) || null
    );

    sendSuccess(res, 'Code1', {
      gameAccount: { gameName, accountId: providerUsername, displayAccountId, password, provisioningStatus: 'CREATED', attemptedIds },
      idempotent: false,
      passwordSet: pwdResult.success,
      vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined,
      vendorPasswordRaw: includeVendorRaw ? (pwdResult as any)?.raw : undefined,
      message: pwdResult.success ? 'OK' : (pwdResult.error || pwdResult.message || 'Password set failed'),
    });
  } catch (error: any) {
    sendError(res, 'Code810', 500);
  }
};

export const recreateGameAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const includeVendorRaw = Boolean((req as any)?.user?.is_super_admin);
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      sendError(res, 'Code804', 400);
      return;
    }

    const gameNameRaw = (req.body?.gameName as string | undefined) || '';
    const gameName = gameNameRaw.trim();
    if (!gameName) {
      sendError(res, 'Code805', 400);
      return;
    }

    const player = await Player.findOne({ where: withTenancyWhere(scope, { id: playerId }) } as any);
    if (!player) {
      sendError(res, 'Code806', 404);
      return;
    }

    const existingMeta: any = (player as any).metadata || {};
    const existingAccounts: any[] = Array.isArray(existingMeta.gameAccounts) ? existingMeta.gameAccounts : [];
    const existing = existingAccounts.find((ga) => String(ga?.gameName || '').trim().toLowerCase() === gameName.toLowerCase());
    let previousAccountId = typeof existing?.accountId === 'string' ? existing.accountId.trim() : '';
    const previousAttemptedIds: string[] = Array.isArray(existing?.attemptedIds) ? existing.attemptedIds.map((s: any) => String(s)) : [];

    const game = await Game.findOne({
      where: withTenancyWhere(scope, { name: gameName, status: 'active', use_api: true }),
      include: [{ model: Product, attributes: ['providerCode'], required: false }],
    } as any);
    if (!game) {
      sendError(res, 'Code807', 400);
      return;
    }

    const providerCode = (game as any)?.Product?.providerCode;
    if (previousAccountId && isJokerProviderCode(providerCode)) {
      previousAccountId = getVendorAccountIdForStorage(providerCode, game, previousAccountId);
    }
    const vendor = await VendorFactory.getServiceByProviderCode(providerCode, (game as any).id);
    if (!vendor) {
      sendError(res, 'Code808', 400);
      return;
    }

    let disabledOk: boolean | null = null;
    if (previousAccountId) {
      try {
        const r = await vendor.setPlayerStatus(previousAccountId, 'Suspend');
        disabledOk = Boolean(r?.success);
      } catch {
        disabledOk = false;
      }
    }

    const baseAccountId = String((player as any).player_game_id || '').trim();
    const jokerSubBrandCode = isJokerProviderCode(providerCode)
      ? String((await SubBrand.findOne({
        where: { id: scope.sub_brand_id, tenant_id: scope.tenant_id } as any,
        attributes: ['code'],
      } as any) as any)?.code || '')
      : '';
    const attemptedIds: string[] = [];
    const candidates = new Set<string>();
    for (const id of previousAttemptedIds) candidates.add(String(id || '').trim());
    if (previousAccountId) candidates.add(previousAccountId);

    let finalAccountId = isJokerProviderCode(providerCode)
      ? generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode)
      : generateInitialVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
    let result: any = null;
    let created = false;

    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate =
        attempt === 0 ? finalAccountId : (() => {
          let next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
          let guard = 0;
          while (candidates.has(next) && guard < 20) {
            next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
            guard++;
          }
          return next;
        })();
      if (candidates.has(candidate)) continue;
      candidates.add(candidate);
      attemptedIds.push(candidate);
      result = await vendor.createPlayer(candidate);
      if (result?.success && !isVendorConflict(result)) {
        finalAccountId = candidate;
        created = true;
        break;
      }
      if (isVendorConflict(result)) continue;
      break;
    }

    if (!created) {
      await logAudit(
        req.user?.id ?? null,
        'VENDOR_RECREATE_FAILED',
        { playerId, gameName, previousAccountId },
        { disabledOk, attemptedIds, error: result?.error || result?.message, vendorRaw: (result as any)?.raw },
        getClientIp(req) || null
      );
      sendError(res, 'Code809', 400, { detail: result?.error || result?.message || 'PV001', attemptedIds, vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined });
      return;
    }

    const rawProviderUsername =
      (result as any)?.raw?.data?.Data?.Username ||
      (result as any)?.raw?.data?.Username ||
      finalAccountId;
    const providerUsername = getVendorAccountIdForStorage(providerCode, game, rawProviderUsername);
    const displayAccountId = isJokerProviderCode(providerCode)
      ? providerUsername
      : undefined;
    const FIXED_PASSWORD = 'Abcd12345';
    const pwdResult = await vendor.setPlayerPassword(providerUsername, FIXED_PASSWORD);
    const password = pwdResult.success ? FIXED_PASSWORD : undefined;

    const nextAccounts = existingAccounts
      .filter((ga) => String(ga?.gameName || '').trim().toLowerCase() !== gameName.toLowerCase())
      .concat({
        gameName,
        accountId: providerUsername,
        displayAccountId,
        password,
        provisioningStatus: 'CREATED',
        attemptedIds: (previousAccountId ? [previousAccountId].concat(previousAttemptedIds, attemptedIds) : previousAttemptedIds.concat(attemptedIds)).filter(Boolean),
      });
    (player as any).metadata = { ...existingMeta, gameAccounts: nextAccounts };
    await player.save();

    await logAudit(
      req.user?.id ?? null,
      'VENDOR_RECREATE_SUCCESS',
      { playerId, gameName, previousAccountId, accountId: providerUsername },
      { disabledOk, passwordSet: pwdResult.success, attemptedIds, vendorRaw: (result as any)?.raw, vendorPasswordRaw: (pwdResult as any)?.raw },
      getClientIp(req) || null
    );

    sendSuccess(res, 'Code1', {
      gameAccount: { gameName, accountId: providerUsername, displayAccountId, password, provisioningStatus: 'CREATED', attemptedIds },
      previousAccountId: previousAccountId || null,
      disabledOk,
      passwordSet: pwdResult.success,
      vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined,
      vendorPasswordRaw: includeVendorRaw ? (pwdResult as any)?.raw : undefined,
      message: pwdResult.success ? 'OK' : (pwdResult.error || pwdResult.message || 'Password set failed'),
    });
  } catch (error: any) {
    sendError(res, 'Code810', 500);
  }
};

export const syncActiveGameAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      sendError(res, 'Code816', 400);
      return;
    }

    const player = await Player.findOne({ where: withTenancyWhere(scope, { id: playerId }) } as any);
    if (!player) {
      sendError(res, 'Code817', 404);
      return;
    }

    const originalExistingMeta: any = (player as any).metadata || {};
    const existingMeta: any = await qualifyJokerMetadataAccountsForStorage(originalExistingMeta, scope);
    const existingAccounts: any[] = Array.isArray(existingMeta.gameAccounts) ? existingMeta.gameAccounts : [];
    if (JSON.stringify(existingMeta) !== JSON.stringify(originalExistingMeta)) {
      (player as any).metadata = existingMeta;
      await player.save();
    }

    const normalizeGameName = (s: any) => String(s || '').trim().toLowerCase();
    const existingGameNames = new Set<string>(existingAccounts.map((ga) => normalizeGameName(ga?.gameName)).filter(Boolean));
    const existingHasAccountId = new Set<string>();
    for (const ga of existingAccounts) {
      const key = normalizeGameName(ga?.gameName);
      if (!key) continue;
      const acc = typeof ga?.accountId === 'string' ? ga.accountId.trim() : '';
      if (acc) existingHasAccountId.add(key);
    }

    const [activeApiGames, activeNonApiGames] = await Promise.all([
      Game.findAll({
        where: withTenancyWhere(scope, { status: 'active', use_api: true }),
        include: [{ model: Product, attributes: ['providerCode'], required: false }],
      } as any),
      Game.findAll({
        where: withTenancyWhere(scope, { status: 'active', use_api: false }),
      } as any),
    ]);

    const baseAccountId = String((player as any).player_game_id || '').trim();
    const hasJokerGame = (activeApiGames as any[]).some((game) =>
      isJokerProviderCode((game as any)?.Product?.providerCode),
    );
    const jokerSubBrandCode = hasJokerGame
      ? String((await SubBrand.findOne({
        where: { id: scope.sub_brand_id, tenant_id: scope.tenant_id } as any,
        attributes: ['code'],
      } as any) as any)?.code || '')
      : '';
    const FIXED_PASSWORD = 'Abcd12345';
    const includeVendorRaw = Boolean((req as any)?.user?.is_super_admin);
    const refreshWalletCredit =
      typeof (req.query as any)?.refreshWalletCredit === 'string'
        ? String((req.query as any).refreshWalletCredit).toLowerCase() !== 'false'
        : typeof (req.body as any)?.refreshWalletCredit === 'boolean'
          ? Boolean((req.body as any).refreshWalletCredit)
          : true;

    const results: any[] = [];
    const newAccounts: any[] = [];

    const normalizeUsernameCandidates = (raw: any): string[] => {
      const v = String(raw || '').trim();
      if (!v) return [];
      if (!v.includes('.')) return [v];
      const parts = v.split('.').filter(Boolean);
      const last = parts.length > 0 ? parts[parts.length - 1] : '';
      return last && last !== v ? [v, last] : [v];
    };

    const processGame = async (game: any, useApi: boolean) => {
      const gameName = String(game?.name || '').trim();
      const key = normalizeGameName(gameName);
      if (!key) return;

      if (existingGameNames.has(key) && (!useApi || existingHasAccountId.has(key))) {
        results.push({ gameName, use_api: useApi, action: 'SKIP_EXISTS' });
        return;
      }

      if (!useApi) {
        newAccounts.push({
          gameName,
          accountId: '',
          password: undefined,
          provisioningStatus: 'NON_API',
        });
        results.push({ gameName, use_api: false, action: 'NON_API_ADDED' });
        existingGameNames.add(key);
        return;
      }

      const providerCode = (game as any)?.Product?.providerCode;
      const vendor = typeof providerCode === 'number'
        ? await VendorFactory.getServiceByProviderCode(providerCode, (game as any).id)
        : null;

      if (!vendor) {
        newAccounts.push({
          gameName,
          accountId: '',
          password: undefined,
          provisioningStatus: 'PENDING_RETRY',
          error: 'PV013',
        });
        results.push({ gameName, use_api: true, action: 'PENDING_RETRY', message: 'Vendor service not available' });
        existingGameNames.add(key);
        return;
      }

      const attemptedIds: string[] = [];
      const candidates = new Set<string>();
      let finalAccountId = generateInitialVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
      let result: any = null;
      let created = false;

      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate =
          attempt === 0 ? finalAccountId : (() => {
            let next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
            let guard = 0;
            while (candidates.has(next) && guard < 10) {
              next = generateNextVendorAccountId(providerCode, baseAccountId, jokerSubBrandCode);
              guard++;
            }
            return next;
          })();
        candidates.add(candidate);
        attemptedIds.push(candidate);
        result = await vendor.createPlayer(candidate);
        if (result?.success && !isVendorConflict(result)) {
          finalAccountId = candidate;
          created = true;
          break;
        }
        if (isVendorConflict(result)) continue;
        break;
      }

      if (!created) {
        if (isVendorConflict(result)) {
          newAccounts.push({
            gameName,
            accountId: '',
            password: undefined,
            provisioningStatus: 'SKIPPED_CONFLICT',
            attemptedIds,
          });
          results.push({ gameName, use_api: true, action: 'SKIPPED_CONFLICT', attemptedIds, vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined });
          existingGameNames.add(key);
          return;
        }

        newAccounts.push({
          gameName,
          accountId: '',
          password: undefined,
          provisioningStatus: 'PENDING_RETRY',
          attemptedIds,
          error: result?.error || 'PV001',
        });
        results.push({ gameName, use_api: true, action: 'PENDING_RETRY', attemptedIds, message: result?.error || 'PV001', vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined });
        existingGameNames.add(key);
        return;
      }

      const rawProviderUsername =
        (result as any)?.raw?.data?.Data?.Username ||
        (result as any)?.raw?.data?.Username ||
        finalAccountId;
      const providerUsername = getVendorAccountIdForStorage(providerCode, game, rawProviderUsername);
      const displayAccountId = isJokerProviderCode(providerCode)
        ? providerUsername
        : undefined;
      const createdNow =
        (result as any)?.status === 'Created' ||
        (result as any)?.code === 'CREATED' ||
        (result as any)?.raw?.data?.Status === 'Created' ||
        (result as any)?.raw?.data?.Data?.Status === 'Created';
      const pwdResult = createdNow ? await vendor.setPlayerPassword(providerUsername, FIXED_PASSWORD) : { success: false } as any;
      const password = createdNow && pwdResult.success ? FIXED_PASSWORD : undefined;

      newAccounts.push({
        gameName,
        accountId: providerUsername,
        displayAccountId,
        password,
        provisioningStatus: 'CREATED',
        attemptedIds,
      });
      results.push({ gameName, use_api: true, action: 'CREATED', accountId: providerUsername, displayAccountId, attemptedIds, passwordSet: pwdResult.success, vendorRaw: includeVendorRaw ? (result as any)?.raw : undefined, vendorPasswordRaw: includeVendorRaw ? (pwdResult as any)?.raw : undefined });
      existingGameNames.add(key);
    };

    for (const g of activeApiGames as any[]) {
      await processGame(g, true);
    }
    for (const g of activeNonApiGames as any[]) {
      await processGame(g, false);
    }

    const activeApiByNameLower = new Map<string, any>();
    for (const g of activeApiGames as any[]) {
      const name = String(g?.name || '').trim();
      if (!name) continue;
      activeApiByNameLower.set(name.toLowerCase(), g);
    }

    const vendorByGameId = new Map<number, any>();
    const getVendorForGame = async (game: any) => {
      const gid = Number(game?.id ?? null);
      if (!Number.isFinite(gid) || gid <= 0) return null;
      if (vendorByGameId.has(gid)) return vendorByGameId.get(gid);
      const providerCode = (game as any)?.Product?.providerCode;
      const vendor =
        typeof providerCode === 'number'
          ? await VendorFactory.getServiceByProviderCode(providerCode, gid)
          : null;
      vendorByGameId.set(gid, vendor);
      return vendor;
    };

    const runPool = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
      const results: R[] = new Array(items.length) as any;
      let cursor = 0;
      const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          results[idx] = await fn(items[idx]);
        }
      });
      await Promise.all(workers);
      return results;
    };

    const baseAccounts = existingAccounts.concat(newAccounts);
    let walletChanged = false;
    const walletRefreshResults: any[] = [];
    let nextAccounts = baseAccounts.map((ga) => (ga && typeof ga === 'object' ? { ...ga } : ga));

    if (refreshWalletCredit && nextAccounts.length > 0) {
      const entries = nextAccounts
        .map((ga, index) => ({ ga, index }))
        .filter(({ ga }) => ga && typeof ga === 'object');

      await runPool(entries, 3, async ({ ga, index }) => {
        const gameName = String((ga as any)?.gameName || '').trim().toLowerCase();
        const game = gameName ? activeApiByNameLower.get(gameName) : null;
        const accountId = String((ga as any)?.accountId || '').trim();
        if (!game || !accountId) {
          return null as any;
        }
        const vendor = await getVendorForGame(game);
        if (!vendor) {
          walletRefreshResults.push({ gameName: (ga as any)?.gameName, ok: false, message: 'Vendor service not available' });
          return null as any;
        }

        const candidates = normalizeUsernameCandidates(accountId);
        for (const candidate of candidates) {
          const bal = await vendor.getBalance(candidate);
          if (bal?.success && typeof bal.credit === 'number' && Number.isFinite(bal.credit)) {
            const prev = (nextAccounts[index] as any)?.walletCredit;
            const next = Number(bal.credit);
            if (prev == null || Number(prev) !== next) walletChanged = true;
            (nextAccounts[index] as any).walletCredit = next;
            walletRefreshResults.push({ gameName: (ga as any)?.gameName, ok: true, credit: next });
            return null as any;
          }
        }

        walletRefreshResults.push({ gameName: (ga as any)?.gameName, ok: false, message: 'Balance fetch failed' });
        return null as any;
      });
    }

    const addedAccounts = newAccounts.length;
    const updated = addedAccounts > 0 || walletChanged;
    if (updated) {
      (player as any).metadata = {
        ...existingMeta,
        gameAccounts: nextAccounts,
      };
      await player.save();
    }

    await logAudit(
      req.user?.id ?? null,
      'PLAYER_SYNC_ACTIVE_GAME_ACCOUNTS',
      { playerId },
      { added: addedAccounts, refreshWalletCredit, walletRefreshResults, results },
      getClientIp(req) || null,
    );

    sendSuccess(res, 'Code1', {
      updated,
      results,
      refreshWalletCredit,
      walletRefreshResults,
      gameAccounts: updated ? (player as any).metadata?.gameAccounts || [] : existingAccounts,
    });
  } catch (error: any) {
    sendError(res, 'Code810', 500);
  }
};

export const createPlayer = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const { player_game_id, game_id, tags, metadata } = req.body;
    const userPermissions = req.user?.permissions || [];
    
    // Player ID remains independent from vendor account IDs: <SubBrand.code><6 digits>
    const sb = await SubBrand.findOne({ where: { id: scope.sub_brand_id, tenant_id: scope.tenant_id } as any } as any);
    const rawPrefix = typeof (sb as any)?.code === 'string' ? String((sb as any).code).trim() : '';
    const cleanedPrefix = rawPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prefix = cleanedPrefix.length > 0 ? cleanedPrefix : `SB${scope.sub_brand_id}`;
    const pattern = new RegExp(`^${prefix}[0-9]{6}$`);

    let finalPlayerId: string;
    if (typeof player_game_id === 'string' && player_game_id.trim().length > 0 && pattern.test(player_game_id.trim().toUpperCase())) {
      finalPlayerId = player_game_id.trim().toUpperCase();
    } else {
      finalPlayerId = await generateNextPlayerId(scope);
    }
    
    // Check if player already exists (same ID)
    const existingPlayer = await Player.findOne({ 
      where: { 
        ...withTenancyWhere(scope, {
          player_game_id: finalPlayerId,
          game_id: game_id || null,
        }),
      } 
    });
    if (existingPlayer) {
      sendError(res, 'Code813', 400);
      return;
    }
    
    const validationError = validateMetadata(metadata);
    if (validationError) {
      sendError(res, validationError === 'P105' ? 'Code619' : 'Code620', 400); // Duplicate Bank or Game
      return;
    }
    const globalError = await validateMetadataGlobalForCreate(metadata, scope);
    if (globalError) {
      const codeMap: Record<string, string> = { 'P102': 'Code621', 'P103': 'Code622', 'P110': 'Code623' };
      sendError(res, codeMap[globalError] || 'Code624', 400); // Global conflict
      return;
    }
    const canEditPlayerBanks = userPermissions.includes('action:player_banks_edit');

    let baseMetadata = metadata || {};
    if (!canEditPlayerBanks && baseMetadata && typeof baseMetadata === 'object' && Array.isArray((baseMetadata as any).playerBanks)) {
      const cloned = { ...(baseMetadata as any) };
      delete cloned.playerBanks;
      baseMetadata = cloned;
    }

    const enrichedMetadata = {
      ...baseMetadata,
      createdByUserId: req.user?.id,
    };

    // ─────────────────────────────────────────────
    // 第一步：先调用供应商API创建玩家（必须全部成功）
    // ─────────────────────────────────────────────
    
    // 1. 获取所有active游戏（包含use_api和非use_api）
    const allActiveApiGames = await Game.findAll({
      where: {
        ...withTenancyWhere(scope, {
          status: 'active',
          use_api: true,
        }),
      },
      include: [{ model: Product, attributes: ['providerCode'], required: false }]
    });

    // 获取所有active但use_api=false的游戏（非API游戏）
    const allActiveNonApiGames = await Game.findAll({
      where: {
        ...withTenancyWhere(scope, {
          status: 'active',
          use_api: false,
        }),
      }
    });

    // 合并所有active游戏
    const allActiveGames = [...allActiveApiGames, ...allActiveNonApiGames];

    // 2. 从metadata获取gameAccounts（仅作为“账号名覆写”的参考，严格在当前scope内匹配）
    const gameAccounts = Array.isArray(enrichedMetadata?.gameAccounts) ? enrichedMetadata.gameAccounts : [];

    // 3. 构建需要创建的游戏列表（仅使用“当前 sub brand 下的游戏”，避免跨 sub brand 混淆）
    const gamesToCreate: Array<{ gameName: string; accountId: string; game: any }> = [];
    const gameById = new Map<number, any>();
    const gameByName = new Map<string, any>();
    for (const g of allActiveGames) {
      gameById.set(Number(g.id), g);
      const key = String(g.name || '').trim().toLowerCase();
      if (key) gameByName.set(key, g);
    }

    // 3.1 先处理metadata中携带的条目：优先用 gameId 精确匹配；否则用 name 在当前scope匹配
    for (const ga of gameAccounts) {
      const rawId = (ga as any).gameId ?? (ga as any).game_id ?? null;
      const gameIdNum = rawId != null ? Number(rawId) : null;
      let scopedGame: any | null = null;
      if (Number.isFinite(gameIdNum) && gameById.has(Number(gameIdNum))) {
        scopedGame = gameById.get(Number(gameIdNum));
      } else if (ga && typeof ga.gameName === 'string') {
        const key = ga.gameName.trim().toLowerCase();
        scopedGame = gameByName.get(key) || null;
      }
      if (!scopedGame) continue; // 忽略跨scope或无法识别的项
      const accountId = typeof ga.accountId === 'string' && ga.accountId.trim().length > 0 ? ga.accountId.trim() : String(finalPlayerId);
      if (!gamesToCreate.some((x) => Number(x.game?.id) === Number(scopedGame.id))) {
        gamesToCreate.push({
          gameName: scopedGame.name,
          accountId,
          game: scopedGame,
        });
      }
    }

    // 然后检查是否有遗漏的active API游戏（需要调用供应商API）
    for (const game of allActiveApiGames) {
      const alreadyIncluded = gamesToCreate.some(g => Number(g.game?.id) === Number(game.id));
      if (!alreadyIncluded) {
        gamesToCreate.push({
          gameName: game.name,
          accountId: finalPlayerId,
          game
        });
      }
    }

    // 最后添加所有active非API游戏（创建空账号，不需要API调用）
    for (const game of allActiveNonApiGames) {
      const alreadyIncluded = gamesToCreate.some(g => Number(g.game?.id) === Number(game.id));
      if (!alreadyIncluded) {
        gamesToCreate.push({
          gameName: game.name,
          accountId: '',  // 非API游戏，账号ID为空，需要手动填写
          game
        });
      }
    }

    const vendorResults: Array<{
      gameName: string;
      accountId: string;
      success: boolean;
      error?: string;
      passwordSet?: boolean;
      password?: string;
      displayAccountId?: string;
      provisioningStatus: 'CREATED' | 'NON_API' | 'SKIPPED_CONFLICT' | 'PENDING_RETRY';
      attemptedIds?: string[];
    }> = [];

    for (const { gameName, accountId, game } of gamesToCreate) {
      // 非API游戏（use_api=false），直接添加空账号不调用API
      if (!game.use_api) {
        vendorResults.push({
          gameName: gameName,
          accountId: '',
          success: true,  // 标记为成功，但不调用API
          passwordSet: false,
          password: undefined,
          provisioningStatus: 'NON_API',
        });
        continue;
      }

      try {
        const providerCode = (game as any)?.Product?.providerCode;
        // 获取供应商服务
        const vendor = await VendorFactory.getServiceByProviderCode(
          providerCode,
          game.id
        );

        if (!vendor) {
          vendorResults.push({
            gameName: gameName,
            accountId: accountId,
            success: false,
            error: 'Vendor service not available',
            passwordSet: false,
            password: undefined,
            provisioningStatus: 'PENDING_RETRY',
          });
          continue;
        }

        const baseAccountId = String(finalPlayerId || '').trim();
        const attemptedIds: string[] = [];
        const candidates = new Set<string>();
        const requestedAccountId = String(accountId || baseAccountId).trim() || baseAccountId;
        const initialAccountId = isJokerProviderCode(providerCode) ? baseAccountId : requestedAccountId;
        let finalAccountId = generateInitialVendorAccountId(providerCode, initialAccountId, rawPrefix);
        let result: any = null;
        let created = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate =
            attempt === 0 ? finalAccountId : (() => {
              let next = generateNextVendorAccountId(providerCode, baseAccountId, rawPrefix);
              let guard = 0;
              while (candidates.has(next) && guard < 10) {
                next = generateNextVendorAccountId(providerCode, baseAccountId, rawPrefix);
                guard++;
              }
              return next;
            })();
          candidates.add(candidate);
          attemptedIds.push(candidate);
          result = await vendor.createPlayer(candidate);
          if (result?.success && !isVendorConflict(result)) {
            finalAccountId = candidate;
            created = true;
            break;
          }
          if (isVendorConflict(result)) {
            continue;
          }
          break;
        }

        if (!created) {
          if (isVendorConflict(result)) {
            vendorResults.push({
              gameName: gameName,
              accountId: '',
              success: false,
              error: 'PV006',
              passwordSet: false,
              password: undefined,
              provisioningStatus: 'SKIPPED_CONFLICT',
              attemptedIds,
            });
            continue;
          }
          vendorResults.push({
            gameName: gameName,
            accountId: '',
            success: false,
            error: result?.error || 'PV001',
            passwordSet: false,
            password: undefined,
            provisioningStatus: 'PENDING_RETRY',
            attemptedIds,
          });
          continue;
        }

        // 如果创建成功，设置固定密码
        let passwordSet = false;
        let gamePassword: string | undefined;
        let passwordRaw: any = undefined;
        const rawProviderUsername =
          (result as any)?.raw?.data?.Data?.Username ||
          (result as any)?.raw?.data?.Username ||
          finalAccountId;
        const providerUsername = getVendorAccountIdForStorage(providerCode, game, rawProviderUsername);
        const displayAccountId = isJokerProviderCode(providerCode)
          ? providerUsername
          : undefined;
        if (result?.success) {
          const FIXED_PASSWORD = 'Abcd12345';
          const pwdResult = await vendor.setPlayerPassword(providerUsername, FIXED_PASSWORD);
          passwordSet = pwdResult.success;
          passwordRaw = (pwdResult as any)?.raw;
          if (pwdResult.success) {
            gamePassword = FIXED_PASSWORD;
          }
        }

        vendorResults.push({
          gameName: gameName,
          accountId: providerUsername,
          displayAccountId,
          success: true,
          error: undefined,
          passwordSet,
          password: gamePassword,
          provisioningStatus: 'CREATED',
          attemptedIds,
        });

        // 记录审计日志
        await logAudit(
          req.user?.id ?? null,
          'VENDOR_CREATE_PLAYER',
          { gameId: game.id, gameName: gameName, username: providerUsername },
          { success: true, status: result?.status, message: result?.message, vendorRaw: (result as any)?.raw, vendorPasswordRaw: passwordRaw },
          getClientIp(req) || null
        );

      } catch (err: any) {
        vendorResults.push({
          gameName: gameName,
          accountId: accountId,
          success: false,
          error: err.message || 'PV001',
          passwordSet: false,
          password: undefined,
          provisioningStatus: 'PENDING_RETRY',
        });
      }
    }

    const hardFailedResults = vendorResults.filter((r) => !r.success && r.provisioningStatus === 'PENDING_RETRY');
    if (hardFailedResults.length > 0) {
      await logAudit(
        req.user?.id ?? null,
        'VENDOR_CREATE_FAILED',
        { playerId: finalPlayerId, reason: 'Hard vendor failure' },
        { failedGames: hardFailedResults },
        getClientIp(req) || null
      );
    }

    const skippedConflictResults = vendorResults.filter((r) => r.provisioningStatus === 'SKIPPED_CONFLICT');
    if (skippedConflictResults.length > 0) {
      await logAudit(
        req.user?.id ?? null,
        'VENDOR_CREATE_SKIPPED_CONFLICT',
        { playerId: finalPlayerId, reason: 'Conflict exhausted' },
        { skipped: skippedConflictResults },
        getClientIp(req) || null
      );
    }

    const createdGameAccounts = vendorResults.map((r) => ({
      gameName: r.gameName,
      accountId: r.accountId,
      displayAccountId: r.displayAccountId,
      password: r.password,
      provisioningStatus: r.provisioningStatus,
      attemptedIds: r.attemptedIds,
      error: r.success ? undefined : r.error,
    }));

    const finalMetadata = {
      ...enrichedMetadata,
      gameAccounts: createdGameAccounts
    };

    // ─────────────────────────────────────────────
    // 第二步：无论供应商成功失败，都创建本地player
    // ─────────────────────────────────────────────
    const player = await Player.create(
      withTenancyCreate(scope, {
        player_game_id: finalPlayerId,
        game_id: game_id || null,
        tags: tags || [],
        metadata: finalMetadata,
        total_in: 0,
        total_out: 0,
      }),
    );

    await logAudit(req.user?.id, 'PLAYER_CREATE', null, player.toJSON(), req.ip);

    const responsePayload = sanitizePlayerForResponse(player, userPermissions);
    sendSuccess(res, 'Code1', {
      ...responsePayload,
      vendorCreated: vendorResults.some((r) => r.success && r.provisioningStatus === 'CREATED'),
      gamePasswords: createdGameAccounts
        .filter((r: any) => r.password)
        .map((r: any) => ({
          gameName: r.gameName,
          username: r.displayAccountId || r.accountId,
          password: r.password,
        })),
      vendorResults: vendorResults.map((r) => ({
        gameName: r.gameName,
        success: r.success,
        passwordSet: r.passwordSet,
        error: r.success ? undefined : r.error,
        provisioningStatus: r.provisioningStatus,
        attemptedIds: r.attemptedIds,
      })),
      vendorCreatePending: vendorResults.some((r) => r.provisioningStatus === 'PENDING_RETRY'),
      vendorCreateSkippedConflict: vendorResults.some((r) => r.provisioningStatus === 'SKIPPED_CONFLICT'),
    }, undefined, 201);
  } catch (error) {
    sendError(res, 'Code810', 500);
  }
};

export const updatePlayer = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const scope = getTenancyScopeOrThrow(req);
        const { id } = req.params;
    const { player_game_id, game_id, tags, metadata } = req.body;
    const userPermissions = req.user?.permissions || [];
    const playerId = Number(id);

    if (!Number.isInteger(playerId) || playerId <= 0) {
      sendError(res, 'Code811', 400);
      return;
    }

    const player = await Player.findOne({ where: withTenancyWhere(scope, { id: playerId }) } as any);
    if (!player) {
        sendError(res, 'Code812', 404);
        return;
    }

    const originalData = player.toJSON();

    const canEditPlayerBanks = userPermissions.includes('action:player_banks_edit');
    let incomingMetadata = metadata;
    if (incomingMetadata && !canEditPlayerBanks && typeof incomingMetadata === 'object' && Array.isArray((incomingMetadata as any).playerBanks)) {
      const cloned = { ...(incomingMetadata as any) };
      delete cloned.playerBanks;
      incomingMetadata = cloned;
    }
    // Merge metadata to avoid wiping fields (e.g., gameAccounts) when client omits them
    let effectiveMetadata = incomingMetadata
      ? { ...(originalData.metadata || {}), ...(incomingMetadata as any) }
      : undefined;

    if (effectiveMetadata) {
      effectiveMetadata = await qualifyJokerMetadataAccountsForStorage(effectiveMetadata, scope);
    }

    if (effectiveMetadata) {
      const validationError = validateMetadata(effectiveMetadata);
      if (validationError) {
        sendError(res, validationError === 'P105' ? 'Code619' : 'Code620', 400); // Validation error
        return;
      }
      const globalError = await validateMetadataGlobalForUpdate(
        effectiveMetadata,
        originalData.metadata,
        scope,
        player.id
      );
      if (globalError) {
        const codeMap: Record<string, string> = { 'P102': 'Code621', 'P103': 'Code622', 'P110': 'Code623' };
        sendError(res, codeMap[globalError] || 'Code624', 400); // Global error
        return;
      }
    }
    
    if (player_game_id) player.player_game_id = player_game_id;
    if (tags) player.tags = tags;
    if (effectiveMetadata) player.metadata = effectiveMetadata;

        await player.save();

        await logAudit(req.user?.id, 'PLAYER_UPDATE', originalData, player.toJSON(), req.ip);

        const responsePayload = sanitizePlayerForResponse(player, userPermissions);

        sendSuccess(res, 'Code1', responsePayload);
    } catch (error) {
        sendError(res, 'Code818', 500);
    }
};

export const deletePlayer = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const scope = getTenancyScopeOrThrow(req);
        const { id } = req.params;
        const playerId = Number(id);

        if (!Number.isInteger(playerId) || playerId <= 0) {
          sendError(res, 'Code816', 400);
          return;
        }

        const player = await Player.findOne({ where: withTenancyWhere(scope, { id: playerId }) } as any);
        if (!player) {
            sendError(res, 'Code817', 404);
            return;
        }

        const originalData = player.toJSON();
        await player.destroy();

        await logAudit(req.user?.id, 'PLAYER_DELETE', originalData, null, req.ip);

        sendSuccess(res, 'Code1');
    } catch (error) {
        sendError(res, 'Code819', 500);
    }
};

export const getPlayerStatistics = async (req: AuthRequest, res: Response) => {
    try {
        const scope = getTenancyScopeOrThrow(req);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(now.getDate() - 30);

        // Get all players for statistics
        const [allPlayers, allStats] = await Promise.all([
            Player.findAll({
                attributes: ['id', 'player_game_id', 'metadata', 'createdAt'],
                where: withTenancyWhere(scope),
            }),
            PlayerStats.findAll({ where: withTenancyWhere(scope) } as any) as any
        ]);

        // Create stats map for player activity
        const statsMap = new Map<number, any>();
        for (const row of allStats) {
            const playerId = row.player_id;
            if (!playerId) continue;

            const lastDepositAt = row.last_deposit_at ? new Date(row.last_deposit_at) : null;
            const lastWithdrawAt = row.last_withdraw_at ? new Date(row.last_withdraw_at) : null;
            
            // Get the most recent activity date
            let lastActivity = null;
            if (lastDepositAt && lastWithdrawAt) {
                lastActivity = lastDepositAt > lastWithdrawAt ? lastDepositAt : lastWithdrawAt;
            } else if (lastDepositAt) {
                lastActivity = lastDepositAt;
            } else if (lastWithdrawAt) {
                lastActivity = lastWithdrawAt;
            }

            statsMap.set(playerId, {
                lastActivity,
                depositCount: Number(row.deposit_count || 0),
                withdrawCount: Number(row.withdraw_count || 0),
                totalDeposit: Number(row.total_deposit || 0),
                totalWithdraw: Number(row.total_withdraw || 0),
            });
        }

        // Calculate statistics
        const totalPlayers = allPlayers.length;
        
        // Monthly new players
        const monthlyNewPlayers = allPlayers.filter(player => {
            const createdAt = new Date(player.get('createdAt') as string || player.get('created_at') as string);
            return createdAt >= monthStart && createdAt <= now;
        }).length;

        // Today new players
        const todayNewPlayers = allPlayers.filter(player => {
            const createdAt = new Date(player.get('createdAt') as string || player.get('created_at') as string);
            return createdAt >= todayStart && createdAt <= todayEnd;
        }).length;

        // Today active players (with activity today)
        const todayActivePlayers = Array.from(statsMap.values()).filter(stats => 
            stats.lastActivity && stats.lastActivity >= todayStart && stats.lastActivity <= todayEnd
        ).length;

        // Weekly active players
        const weeklyActivePlayers = Array.from(statsMap.values()).filter(stats => 
            stats.lastActivity && stats.lastActivity >= weekStart && stats.lastActivity <= now
        ).length;

        // 30 days inactive players
        const inactive30DaysPlayers = Array.from(statsMap.values()).filter(stats => 
            !stats.lastActivity || stats.lastActivity < thirtyDaysAgo
        ).length;

        // Calculate retention rates
        const calculateRetention = (days: number) => {
            const cutoffDate = new Date(now);
            cutoffDate.setDate(now.getDate() - days);
            
            const playersInCohort = allPlayers.filter(player => {
                const createdAt = new Date(player.get('createdAt') as string || player.get('created_at') as string);
                return createdAt <= cutoffDate;
            });

            if (playersInCohort.length === 0) return 0;

            const activePlayers = playersInCohort.filter(player => {
                const stats = statsMap.get(player.id);
                return stats && stats.lastActivity && stats.lastActivity >= cutoffDate;
            }).length;

            return Math.round((activePlayers / playersInCohort.length) * 100);
        };

        const retention1Day = calculateRetention(1);
        const retention7Days = calculateRetention(7);
        const retention30Days = calculateRetention(30);

        // Calculate referral source distribution
        const referralSourceMap = new Map<string, number>();
        for (const player of allPlayers) {
            const metadata = player.metadata || {};
            const source = metadata.referralSource || 'Unknown';
            referralSourceMap.set(source, (referralSourceMap.get(source) || 0) + 1);
        }

        const referralSourceDistribution = Array.from(referralSourceMap.entries())
            .map(([source, count]) => ({
                source,
                count,
                percentage: Math.round((count / totalPlayers) * 100)
            }))
            .sort((a, b) => b.count - a.count);

        // Calculate daily trend data for the past 7 days
        const dailyTrendData = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(now.getDate() - i);
            const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
            
            // Format date as MM-DD with current month
            const currentDate = new Date();
            const isCurrentMonth = date.getMonth() === currentDate.getMonth() && date.getFullYear() === currentDate.getFullYear();
            const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            
            // Count new players for this day
            const newAdditions = allPlayers.filter(player => {
                const createdAt = new Date(player.get('createdAt') as string || player.get('created_at') as string);
                return createdAt >= dayStart && createdAt <= dayEnd;
            }).length;
            
            // Count active players for this day (players with activity on this day)
            const activeUsers = Array.from(statsMap.values()).filter(stats => 
                stats.lastActivity && stats.lastActivity >= dayStart && stats.lastActivity <= dayEnd
            ).length;
            
            dailyTrendData.push({
                date: dateStr,
                newAdditions,
                activeUsers,
                isCurrentMonth
            });
        }

        sendSuccess(res, 'Code1', {
            totalPlayers,
            monthlyNewPlayers,
            todayNewPlayers,
            todayActivePlayers,
            weeklyActivePlayers,
            inactive30DaysPlayers,
            retention1Day,
            retention7Days,
            retention30Days,
            referralSourceDistribution,
            dailyTrendData
        });

    } catch (error) {
        sendError(res, 'Code815', 500);
    }
};

export const getPlayerReferralStats = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions = req.user?.permissions || [];
    const canViewProfit = userPermissions.includes('view:player_profit');

    const idRaw = req.params.id;
    const referrerId = Number(idRaw);
    if (!Number.isInteger(referrerId) || referrerId <= 0) {
      sendError(res, 'Code820', 400);
      return;
    }

    const allPlayers = await Player.findAll({
      attributes: ['id', 'player_game_id', 'metadata', 'createdAt'],
      where: withTenancyWhere(scope),
      order: [['id', 'DESC']],
    } as any);

    const referredPlayers = (allPlayers as any[]).filter((p) => {
      const meta = p?.metadata && typeof p.metadata === 'object' ? p.metadata : {};
      return meta.referrerId === referrerId;
    });

    const referredIds = referredPlayers
      .map((p) => Number(p?.id ?? null))
      .filter((v) => Number.isFinite(v) && v > 0);

    const totalsMap = new Map<number, { totalDeposit: number; totalWithdraw: number }>();
    if (referredIds.length > 0) {
      const rows = await PlayerStats.findAll({
        attributes: [
          'player_id',
          [sequelize.fn('SUM', sequelize.col('total_deposit')), 'total_deposit'],
          [sequelize.fn('SUM', sequelize.col('total_withdraw')), 'total_withdraw'],
        ],
        where: withTenancyWhere(scope, { player_id: { [Op.in]: referredIds } }),
        group: ['player_id'],
        raw: true,
      } as any);
      for (const row of rows as any[]) {
        const pid = Number(row.player_id ?? null);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        totalsMap.set(pid, {
          totalDeposit: Number(row.total_deposit || 0),
          totalWithdraw: Number(row.total_withdraw || 0),
        });
      }
    }

    const payload = referredPlayers.map((p: any) => {
      const pid = Number(p?.id ?? null);
      const createdRaw = p?.createdAt ?? p?.created_at ?? null;
      const joinedAt =
        createdRaw instanceof Date
          ? createdRaw.toISOString()
          : typeof createdRaw === 'string'
            ? createdRaw
            : null;
      const totals = totalsMap.get(pid) || { totalDeposit: 0, totalWithdraw: 0 };
      return {
        playerId: pid,
        player_game_id: String(p?.player_game_id || ''),
        joinedAt,
        totalDeposit: canViewProfit ? totals.totalDeposit : null,
        totalWithdraw: canViewProfit ? totals.totalWithdraw : null,
      };
    });

    sendSuccess(res, 'Code1', payload);
  } catch (error) {
    sendError(res, 'Code821', 500);
  }
};
