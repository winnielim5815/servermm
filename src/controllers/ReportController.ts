import { Response } from 'express';
import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { Game, GameLog, Player, Product, Role, SubBrand, Transaction, User, UserTenant } from '../models';
import { VendorFactory } from '../services/vendor/VendorFactory';
import { getTenancyScopeOrThrow, withTenancyWhere } from '../tenancy/scope';
import { sendError, sendSuccess } from '../utils/response';
import { getClientIp, logAudit } from '../services/AuditService';
import { getCache, setCache } from '../services/CacheService';
import { getGameLogSyncSummary, syncGameLogsForScope } from '../services/GameLogSyncService';

let reportTransactionsSynced = false;
const ensureReportTransactionsSynced = async () => {
  if (reportTransactionsSynced) return;
  try {
    await Transaction.sync({ alter: true });
  } catch {
  }
  reportTransactionsSynced = true;
};

const toSqlDateTimeInTz8 = (d: Date) => {
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const x = new Date(ms);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  const hh = String(x.getUTCHours()).padStart(2, '0');
  const mm = String(x.getUTCMinutes()).padStart(2, '0');
  const ss = String(x.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
};

const parseDateParamSql = (val: string) => {
  const s = val.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return toSqlDateTimeInTz8(d);
};

const parseDateParam = (val: string) => {
  let s = val.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    s = s.replace(' ', 'T') + '+08:00';
  }
  return new Date(s);
};

const toFiniteNumber = (v: any): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toYmdInTz8 = (d: Date) => {
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const x = new Date(ms);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const toYmdHmInTz8 = (d: Date) => {
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const x = new Date(ms);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  const hh = String(x.getUTCHours()).padStart(2, '0');
  const mm = String(x.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
};

const toYmdHmsInTz8 = (d: Date) => {
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const x = new Date(ms);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  const hh = String(x.getUTCHours()).padStart(2, '0');
  const mm = String(x.getUTCMinutes()).padStart(2, '0');
  const ss = String(x.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
};

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 24 * 60 * 60 * 1000);

const sumJokerTurnover = async (service: any, start: Date, end: Date, username: string) => {
  let cursor = new Date(start.getTime());
  let total = 0;
  while (cursor.getTime() <= end.getTime()) {
    const chunkEnd = addDays(cursor, 29);
    const effectiveEnd = chunkEnd.getTime() <= end.getTime() ? chunkEnd : end;
    const startYmd = toYmdInTz8(cursor);
    const endYmd = toYmdInTz8(effectiveEnd);
    const resp = await service.getWinloss(startYmd, endYmd, username);
    const list = Array.isArray(resp?.winloss) ? resp.winloss : [];
    for (const item of list) {
      if (String(item?.Username ?? '') === username) {
        total += toFiniteNumber(item?.Amount);
      }
    }
    cursor = addDays(effectiveEnd, 1);
  }
  return total;
};

const toDisplayDateTimeFromIso = (raw: any) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return toYmdHmsInTz8(d);
};

const toDisplayDateTimeFromStoredTz8 = (raw: any) => {
  if (typeof raw === 'string') {
    const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return toDisplayDateTimeFromIso(raw);
};

const resolveVendorServiceForScope = async (scope: any, gameId: number | null, capability: 'winloss' | 'transactions') => {
  if (gameId) {
    return VendorFactory.getServiceByGame(gameId);
  }
  const candidates = await Game.findAll({
    attributes: ['id'],
    where: withTenancyWhere(scope, { use_api: true, status: 'active' } as any),
    limit: 30,
  } as any);
  for (const c of candidates as any[]) {
    const id = Number(c?.id ?? null);
    if (!Number.isFinite(id) || id <= 0) continue;
    const svc = await VendorFactory.getServiceByGame(id);
    if (!svc) continue;
    if (capability === 'winloss' && typeof (svc as any).getWinloss === 'function') return svc;
    if (capability === 'transactions' && typeof (svc as any).getTransactionsByMinute === 'function') return svc;
  }
  return null;
};

export const getSummaryReportData = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const userPermissions: string[] = req.user?.permissions || [];
    const canViewUsers = userPermissions.includes('action:user_view');
    const canViewProfit = userPermissions.includes('view:player_profit');

    const startRaw = (req.query.startDate as string | undefined) ?? (req.query.start_date as string | undefined) ?? null;
    const endRaw = (req.query.endDate as string | undefined) ?? (req.query.end_date as string | undefined) ?? null;

    const now = new Date();
    const todayKey = toSqlDateTimeInTz8(now).slice(0, 10);
    let startAtSql = `${todayKey} 00:00:00`;
    let endAtSql = `${todayKey} 23:59:59`;

    if (startRaw) {
      const parsed = parseDateParamSql(startRaw);
      if (parsed) startAtSql = parsed;
    }
    if (endRaw) {
      const parsed = parseDateParamSql(endRaw);
      if (parsed) endAtSql = parsed;
    }

    const startDate = parseDateParam(startAtSql);
    const endDate = parseDateParam(endAtSql);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      sendError(res, 'Code314', 400);
      return;
    }

    const cacheKey = [
      'summary_report_v1',
      scope.tenant_id,
      scope.sub_brand_id,
      startDate.toISOString(),
      endDate.toISOString(),
      canViewUsers ? 'u1' : 'u0',
      canViewProfit ? 'p1' : 'p0',
      req.user?.id ?? 0,
    ].join(':');
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=3');
      return sendSuccess(res, 'Code1', cached);
    }

    const sql = `
      SELECT
        DATE(t.created_at) AS dayKey,
        SUM(CASE WHEN t.type = 'DEPOSIT' AND t.status = 'COMPLETED' AND t.amount > 0 THEN 1 ELSE 0 END) AS depositQty,
        SUM(CASE WHEN t.type = 'DEPOSIT' AND t.status = 'COMPLETED' THEN t.amount ELSE 0 END) AS deposit,
        SUM(CASE WHEN t.status = 'COMPLETED' AND t.type IN ('DEPOSIT', 'BONUS') THEN t.bonus ELSE 0 END) AS bonus,
        SUM(CASE WHEN t.type = 'WITHDRAWAL' AND t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS withdrawQty,
        SUM(CASE WHEN t.type = 'WITHDRAWAL' AND t.status = 'COMPLETED' THEN t.amount ELSE 0 END) AS withdraw,
        SUM(CASE WHEN t.type = 'WITHDRAWAL' AND t.status = 'COMPLETED' THEN t.tips ELSE 0 END) AS tips,
        SUM(
          CASE
            WHEN t.status = 'COMPLETED' AND t.type = 'BURN' THEN t.amount
            WHEN t.status = 'COMPLETED' AND t.type IN ('WITHDRAWAL', 'WALVE') THEN t.walve
            ELSE 0
          END
        ) AS waive,
        COUNT(DISTINCT CASE WHEN t.status = 'COMPLETED' THEN p.player_game_id ELSE NULL END) AS playerQty
      FROM transactions t
      LEFT JOIN players p
        ON p.id = t.player_id
        AND p.tenant_id = t.tenant_id
        AND p.sub_brand_id = t.sub_brand_id
      WHERE t.tenant_id = :tenantId
        AND t.sub_brand_id = :subBrandId
        AND t.created_at BETWEEN :startAt AND :endAt
        AND t.type IN ('DEPOSIT', 'BONUS', 'WITHDRAWAL', 'WALVE', 'BURN')
      GROUP BY dayKey
      ORDER BY dayKey ASC
    `;

    const rawRows = (await sequelize.query(sql, {
      replacements: {
        tenantId: scope.tenant_id,
        subBrandId: scope.sub_brand_id,
        startAt: startAtSql,
        endAt: endAtSql,
      },
      type: QueryTypes.SELECT,
    })) as any[];

    const rowMap = new Map<string, any>();
    for (const r of rawRows) {
      const key = String(r?.dayKey ?? '').trim();
      if (!key) continue;
      rowMap.set(key, r);
    }

    const startKey = toYmdInTz8(startDate);
    const endKey = toYmdInTz8(endDate);
    const startCursor = parseDateParam(`${startKey} 00:00:00`);
    const endCursor = parseDateParam(`${endKey} 00:00:00`);
    const from = startCursor.getTime() <= endCursor.getTime() ? startCursor : endCursor;
    const to = startCursor.getTime() <= endCursor.getTime() ? endCursor : startCursor;

    const rows: any[] = [];
    for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d = addDays(d, 1)) {
      const key = toYmdInTz8(d);
      const base = rowMap.get(key) || {};
      const depositQty = Number(base.depositQty ?? 0) || 0;
      const deposit = toFiniteNumber(base.deposit ?? 0);
      const bonus = toFiniteNumber(base.bonus ?? 0);
      const withdrawQty = Number(base.withdrawQty ?? 0) || 0;
      const withdraw = toFiniteNumber(base.withdraw ?? 0);
      const tips = toFiniteNumber(base.tips ?? 0);
      const waive = toFiniteNumber(base.waive ?? 0);
      const playerQty = Number(base.playerQty ?? 0) || 0;

      // Keep Summary balance consistent with SubBrand report balance logic.
      const balance = deposit + bonus - withdraw - tips - waive;
      const bonusPct = deposit ? (bonus / deposit) * 100 : 0;
      const winPct = deposit ? (balance / deposit) * 100 : 0;

      const dd = String(key.slice(8, 10)).padStart(2, '0');
      const mm = String(key.slice(5, 7)).padStart(2, '0');

      rows.push({
        key,
        dateLabel: `${dd}-${mm}`,
        depositQty,
        deposit,
        bonus,
        bonusPct,
        withdrawQty,
        withdraw,
        tips,
        waive,
        balance,
        winPct,
        playerQty,
      });
    }

    let subBrandOptions: any[] = [];
    try {
      const requesterId = req.user?.id;
      const requester: any = requesterId
        ? await User.findByPk(requesterId, { include: [{ model: Role, through: { attributes: [] }, required: false }] } as any)
        : null;
      if (requester) {
        const isSuperAdmin =
          Boolean(req.user?.is_super_admin) ||
          Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'super admin'));
        const isOperator = Boolean(requester?.Roles?.some((r: any) => String(r?.name ?? '').toLowerCase() === 'operator'));

        let sbs: any[] = [];
        if (isSuperAdmin) {
          sbs = await SubBrand.findAll({ order: [['id', 'ASC']] });
        } else if (isOperator) {
          const tid = Number(requester?.tenant_id ?? null);
          if (Number.isFinite(tid) && tid > 0) {
            sbs = await SubBrand.findAll({ where: { tenant_id: tid } as any, order: [['id', 'ASC']] });
          }
        } else {
          const sbid = Number(req.user?.sub_brand_id ?? requester?.sub_brand_id ?? null);
          if (Number.isFinite(sbid) && sbid > 0) {
            sbs = await SubBrand.findAll({ where: { id: sbid } as any, order: [['id', 'ASC']] });
          }
        }

        subBrandOptions = (sbs as any[]).map((sb) => ({
          id: sb.id,
          tenant_id: (sb as any).tenant_id ?? null,
          code: (sb as any).code ?? null,
          name: (sb as any).name ?? null,
          status: (sb as any).status ?? null,
        }));
      }
    } catch {
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      rows,
      subBrandOptions,
    };

    setCache(cacheKey, payload, 3);
    res.setHeader('Cache-Control', 'private, max-age=3');
    return sendSuccess(res, 'Code1', payload);
  } catch (e) {
    sendError(res, 'Code314', 500);
  }
};

export const getSubBrandWinLossReport = async (req: AuthRequest, res: Response) => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const startRaw = (req.query.startDate as string | undefined) ?? (req.query.start_date as string | undefined) ?? null;
    const endRaw = (req.query.endDate as string | undefined) ?? (req.query.end_date as string | undefined) ?? null;
    const tenantIdRaw = (req.query.tenantId as string | undefined) ?? (req.query.tenant_id as string | undefined) ?? null;
    const requesterId = req.user?.id;
    const requester: any = requesterId
      ? await User.findByPk(requesterId, { include: [{ model: Role, through: { attributes: [] }, required: false }] } as any)
      : null;
    const requesterRoles = requester?.Roles || [];
    const isSuperAdmin =
      Boolean(req.user?.is_super_admin) ||
      Boolean(requester?.is_super_admin) ||
      Boolean(requesterRoles?.some?.((r: any) => String(r?.name ?? '').toLowerCase() === 'super admin'));
    const isAgent = Boolean(requesterRoles?.some?.((r: any) => String(r?.name ?? '').toLowerCase() === 'agent'));
    const fallbackTenantId = Number(requester?.tenant_id ?? scope.tenant_id ?? null);
    const managedTenantIds = isAgent && requesterId
      ? (await UserTenant.findAll({ where: { userId: requesterId }, attributes: ['tenantId'] }))
          .map((r: any) => Number(r.tenantId))
          .filter((x: number) => Number.isFinite(x) && x > 0)
      : [];
    if (isAgent && Number.isFinite(fallbackTenantId) && fallbackTenantId > 0 && !managedTenantIds.includes(fallbackTenantId)) {
      managedTenantIds.push(fallbackTenantId);
    }

    const now = new Date();
    const todayKey = toSqlDateTimeInTz8(now).slice(0, 10);
    let startAtSql = `${todayKey} 00:00:00`;
    let endAtSql = `${todayKey} 23:59:59`;
    if (startRaw) {
      const p = parseDateParamSql(startRaw);
      if (p) startAtSql = p;
    }
    if (endRaw) {
      const p = parseDateParamSql(endRaw);
      if (p) endAtSql = p;
    }
    const startDate = parseDateParam(startAtSql);
    const endDate = parseDateParam(endAtSql);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      sendError(res, 'Code314', 400);
      return;
    }

    let effectiveTenantId = scope.tenant_id;
    if (tenantIdRaw && tenantIdRaw.trim().length > 0) {
      const tid = Number(tenantIdRaw);
      if (Number.isFinite(tid) && tid > 0) {
        if (isSuperAdmin) {
          effectiveTenantId = tid;
        } else if (isAgent) {
          if (!managedTenantIds.includes(tid)) {
            sendError(res, 'Code102', 403);
            return;
          }
          effectiveTenantId = tid;
        }
      }
    }

    const cacheKey = [
      'subbrand_winloss_v1',
      effectiveTenantId,
      startDate.toISOString(),
      endDate.toISOString(),
    ].join(':');
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=3');
      return sendSuccess(res, 'Code1', cached);
    }

    const sql = `
      SELECT
        sb.id AS subBrandId,
        sb.name AS subBrandName,
        SUM(CASE WHEN t.type='DEPOSIT' AND t.status='COMPLETED' AND t.amount > 0 THEN 1 ELSE 0 END) AS depositQty,
        SUM(CASE WHEN t.type='DEPOSIT' AND t.status='COMPLETED' THEN t.amount ELSE 0 END) AS deposit,
        SUM(CASE WHEN t.status='COMPLETED' AND t.type IN ('DEPOSIT','BONUS') THEN t.bonus ELSE 0 END) AS bonus,
        SUM(CASE WHEN t.type='WITHDRAWAL' AND t.status='COMPLETED' THEN 1 ELSE 0 END) AS withdrawQty,
        SUM(CASE WHEN t.type='WITHDRAWAL' AND t.status='COMPLETED' THEN t.amount ELSE 0 END) AS withdraw,
        SUM(CASE WHEN t.type='WITHDRAWAL' AND t.status='COMPLETED' THEN t.tips ELSE 0 END) AS tips,
        SUM(
          CASE
            WHEN t.status='COMPLETED' AND t.type='BURN' THEN t.amount
            WHEN t.status='COMPLETED' AND t.type IN ('WITHDRAWAL','WALVE') THEN t.walve
            ELSE 0
          END
        ) AS waive,
        MAX(COALESCE(ba.bankAdjustment, 0)) AS bankAdjustment,
        MAX(COALESCE(ga.gameAdjustment, 0)) AS gameAdjustment,
        COUNT(DISTINCT CASE WHEN t.status='COMPLETED' THEN p.player_game_id ELSE NULL END) AS playerQty
      FROM sub_brands sb
      LEFT JOIN transactions t
        ON t.sub_brand_id = sb.id
        AND t.tenant_id = :tenantId
        AND t.created_at BETWEEN :startAt AND :endAt
        AND t.type IN ('DEPOSIT','BONUS','WITHDRAWAL','WALVE','BURN')
      LEFT JOIN (
        SELECT
          sub_brand_id AS subBrandId,
          SUM(amount) AS bankAdjustment
        FROM transactions
        WHERE tenant_id = :tenantId
          AND created_at BETWEEN :startAt AND :endAt
          AND status = 'COMPLETED'
          AND type = 'ADJUSTMENT'
        GROUP BY sub_brand_id
      ) ba ON ba.subBrandId = sb.id
      LEFT JOIN (
        SELECT
          sub_brand_id AS subBrandId,
          SUM(CASE WHEN type = 'TOPUP' THEN amount ELSE -amount END) AS gameAdjustment
        FROM game_adjustments
        WHERE tenant_id = :tenantId
          AND createdAt BETWEEN :startAt AND :endAt
        GROUP BY sub_brand_id
      ) ga ON ga.subBrandId = sb.id
      LEFT JOIN players p
        ON p.id = t.player_id
        AND p.tenant_id = t.tenant_id
        AND p.sub_brand_id = t.sub_brand_id
      WHERE sb.tenant_id = :tenantId
      GROUP BY sb.id, sb.name
      ORDER BY sb.id ASC
    `;

    const rowsRaw = (await sequelize.query(sql, {
      replacements: {
        tenantId: effectiveTenantId,
        startAt: startAtSql,
        endAt: endAtSql,
      },
      type: QueryTypes.SELECT,
    })) as any[];

    const rows = rowsRaw.map((r) => {
      const deposit = toFiniteNumber((r as any).deposit);
      const withdraw = toFiniteNumber((r as any).withdraw);
      const bonus = toFiniteNumber((r as any).bonus);
      const tips = toFiniteNumber((r as any).tips);
      const waive = toFiniteNumber((r as any).waive);
      const bankAdjustment = toFiniteNumber((r as any).bankAdjustment);
      const gameAdjustment = toFiniteNumber((r as any).gameAdjustment);
      const balance = deposit + bonus - withdraw - tips - waive;
      const netDeposit = deposit - withdraw - bonus + waive;
      const winPct = deposit ? (netDeposit / deposit) * 100 : 0;
      return {
        subBrandId: Number((r as any).subBrandId || 0),
        subBrandName: (r as any).subBrandName || null,
        depositQty: Number((r as any).depositQty || 0),
        deposit,
        bonus,
        withdrawQty: Number((r as any).withdrawQty || 0),
        withdraw,
        tips,
        waive,
        bankAdjustment,
        gameAdjustment,
        balance,
        netDeposit,
        winPct,
        playerQty: Number((r as any).playerQty || 0),
      };
    });

    const totals = rows.reduce(
      (a, r) => {
        a.depositQty += r.depositQty;
        a.deposit += r.deposit;
        a.bonus += r.bonus;
        a.withdrawQty += r.withdrawQty;
        a.withdraw += r.withdraw;
        a.tips += r.tips;
        a.waive += r.waive;
        a.bankAdjustment += r.bankAdjustment;
        a.gameAdjustment += r.gameAdjustment;
        a.balance += r.balance;
        a.playerQty += r.playerQty;
        return a;
      },
      {
        depositQty: 0,
        deposit: 0,
        bonus: 0,
        withdrawQty: 0,
        withdraw: 0,
        tips: 0,
        waive: 0,
        bankAdjustment: 0,
        gameAdjustment: 0,
        balance: 0,
        playerQty: 0,
      },
    );
    const payload = { generatedAt: new Date().toISOString(), rows, totals };
    setCache(cacheKey, payload, 3);
    res.setHeader('Cache-Control', 'private, max-age=3');
    return sendSuccess(res, 'Code1', payload);
  } catch (e) {
    return sendError(res, 'Code9000', 500);
  }
};
const filterRowsByScopePlayers = async (scope: any, rows: any[]) => {
  const usernames = Array.from(
    new Set(
      rows
        .map((r) => (typeof r?.player === 'string' ? r.player.trim() : ''))
        .filter((s) => s.length > 0),
    ),
  );
  if (usernames.length === 0) return rows;

  const allowed = new Set<string>();
  const chunkSize = 800;
  for (let i = 0; i < usernames.length; i += chunkSize) {
    const chunk = usernames.slice(i, i + chunkSize);
    const found = await Player.findAll({
      attributes: ['player_game_id'],
      where: withTenancyWhere(scope, { player_game_id: { [Op.in]: chunk } } as any),
      raw: true,
    } as any);
    for (const f of found as any[]) {
      const u = typeof f?.player_game_id === 'string' ? f.player_game_id.trim() : '';
      if (u) allowed.add(u);
    }
  }

  return rows.filter((r) => {
    const u = typeof r?.player === 'string' ? r.player.trim() : '';
    return u && allowed.has(u);
  });
};

export const getPlayerWinLossReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await ensureReportTransactionsSynced();
    const scope = getTenancyScopeOrThrow(req);
    const { startDate, endDate, gameId, q, page, pageSize } = req.query as any;

    if (!startDate || !endDate) {
      sendError(res, 'Code9004', 400);
      return;
    }

    const startAtSql = parseDateParamSql(String(startDate));
    const endAtSql = parseDateParamSql(String(endDate));
    if (!startAtSql || !endAtSql) {
      sendError(res, 'Code9004', 400);
      return;
    }

    const start = parseDateParam(startAtSql);
    const end = parseDateParam(endAtSql);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      sendError(res, 'Code9004', 400);
      return;
    }

    const gid = gameId != null && String(gameId).trim().length > 0 ? Number(gameId) : null;
    const normalizedGameId = gid && Number.isFinite(gid) && gid > 0 ? gid : null;

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));
    const offset = (pageNum - 1) * pageSizeNum;

    const query = typeof q === 'string' ? q.trim() : '';
    const cacheKey = [
      'player_winloss_v2',
      scope.tenant_id,
      scope.sub_brand_id,
      start.toISOString(),
      end.toISOString(),
      normalizedGameId ?? '',
      query || '',
      pageNum,
      pageSizeNum,
    ].join(':');
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=3');
      sendSuccess(res, 'Code1', cached);
      return;
    }

    const sqlWhereParts: string[] = [
      't.tenant_id = :tenantId',
      't.sub_brand_id = :subBrandId',
      "t.status = 'COMPLETED'",
      't.player_id IS NOT NULL',
      "t.type IN ('DEPOSIT','BONUS','WITHDRAWAL')",
      't.created_at BETWEEN :startAt AND :endAt',
    ];

    const replacements: any = {
      tenantId: scope.tenant_id,
      subBrandId: scope.sub_brand_id,
      startAt: startAtSql,
      endAt: endAtSql,
      limit: pageSizeNum,
      offset,
    };

    if (normalizedGameId) {
      sqlWhereParts.push('t.game_id = :gameId');
      replacements.gameId = normalizedGameId;
    }

    if (query) {
      const maybeId = Number(query);
      if (Number.isFinite(maybeId) && maybeId > 0) {
        sqlWhereParts.push('t.player_id = :playerId');
        replacements.playerId = maybeId;
      } else {
        sqlWhereParts.push('p.player_game_id LIKE :playerGameLike');
        replacements.playerGameLike = `%${query}%`;
      }
    }

    const sqlJoin = `
      FROM transactions t
      LEFT JOIN players p
        ON p.id = t.player_id
        AND p.tenant_id = t.tenant_id
        AND p.sub_brand_id = t.sub_brand_id
    `;
    const sqlWhere = `WHERE ${sqlWhereParts.join(' AND ')}`;

    const depositTotalExpr = `SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END)`;
    const bonusClaimedExpr = `SUM(CASE WHEN type IN ('DEPOSIT','BONUS') THEN bonus ELSE 0 END)`;
    const withdrawalTotalExpr = `SUM(CASE WHEN type = 'WITHDRAWAL' THEN amount ELSE 0 END)`;
    const depCountExpr = `SUM(CASE WHEN type = 'DEPOSIT' AND amount > 0 THEN 1 ELSE 0 END)`;
    const wdCountExpr = `SUM(CASE WHEN type = 'WITHDRAWAL' THEN 1 ELSE 0 END)`;

    const totalsSql = `
      SELECT
        ${depositTotalExpr} AS total_deposit,
        ${bonusClaimedExpr} AS bonus_claimed,
        ${withdrawalTotalExpr} AS total_withdrawal,
        ${depCountExpr} AS deposit_count,
        ${wdCountExpr} AS withdraw_count
      ${sqlJoin}
      ${sqlWhere}
    `;
    const countSql = `
      SELECT COUNT(*) AS cnt
      FROM (
        SELECT t.player_id
        ${sqlJoin}
        ${sqlWhere}
        GROUP BY t.player_id
      ) x
    `;
    const groupedSql = `
      SELECT
        t.player_id AS player_id,
        MAX(p.player_game_id) AS player_game_id,
        ${depositTotalExpr} AS total_deposit,
        ${bonusClaimedExpr} AS bonus_claimed,
        ${withdrawalTotalExpr} AS total_withdrawal,
        ${depCountExpr} AS deposit_count,
        ${wdCountExpr} AS withdraw_count
      ${sqlJoin}
      ${sqlWhere}
      GROUP BY t.player_id
      ORDER BY t.player_id ASC
      LIMIT :limit OFFSET :offset
    `;

    const [totalItemsRows, grouped, totalsRow] = await Promise.all([
      sequelize.query(countSql, { replacements, type: QueryTypes.SELECT }),
      sequelize.query(groupedSql, { replacements, type: QueryTypes.SELECT }),
      sequelize.query(totalsSql, { replacements, type: QueryTypes.SELECT }),
    ]);

    const totalItemsNum = Array.isArray(totalItemsRows) && totalItemsRows[0] ? Number((totalItemsRows[0] as any).cnt || 0) : 0;
    const totalsRowObj = Array.isArray(totalsRow) && totalsRow[0] ? (totalsRow[0] as any) : {};

    const rows = (grouped as any[]).map((r) => {
      const playerId = Number((r as any)?.player_id ?? null);
      const totalDeposit = toFiniteNumber((r as any)?.total_deposit);
      const bonusClaimed = toFiniteNumber((r as any)?.bonus_claimed);
      const totalWithdrawal = toFiniteNumber((r as any)?.total_withdrawal);
      const totalWinLoss = totalDeposit - totalWithdrawal;
      return {
        player_id: playerId,
        player_game_id: (r as any)?.player_game_id ?? null,
        deposit_count: Number((r as any)?.deposit_count ?? 0) || 0,
        total_deposit: totalDeposit,
        withdraw_count: Number((r as any)?.withdraw_count ?? 0) || 0,
        total_withdrawal: totalWithdrawal,
        total_winloss: totalWinLoss,
        bonus_claimed: bonusClaimed,
        turnover: 0 as number,
      };
    });

    const totalsTotalDeposit = toFiniteNumber(totalsRowObj?.total_deposit);
    const totalsBonusClaimed = toFiniteNumber(totalsRowObj?.bonus_claimed);
    const totalsTotalWithdrawal = toFiniteNumber(totalsRowObj?.total_withdrawal);
    const totals = {
      deposit_count: Number(totalsRowObj?.deposit_count ?? 0) || 0,
      total_deposit: totalsTotalDeposit,
      withdraw_count: Number(totalsRowObj?.withdraw_count ?? 0) || 0,
      total_withdrawal: totalsTotalWithdrawal,
      total_winloss: totalsTotalDeposit - totalsTotalWithdrawal,
      bonus_claimed: totalsBonusClaimed,
      turnover: 0 as number,
    };

    let game: any = null;
    let turnoverSupported = false;
    if (normalizedGameId) {
      const g = await Game.findOne({
        attributes: ['id', 'name'],
        where: withTenancyWhere(scope, { id: normalizedGameId } as any),
      } as any);
      if (g) game = { id: (g as any).id, name: (g as any).name };
    }

    const service = await resolveVendorServiceForScope(scope, normalizedGameId, 'winloss');
    if (service && typeof (service as any).getWinloss === 'function') {
      turnoverSupported = true;
      const usernames = rows.map((r) => String(r.player_game_id ?? '')).filter((s) => s.length > 0);
      const turnoverByUsername = new Map<string, number>();
      const unique = Array.from(new Set(usernames));
      const runQueue = async (items: string[], concurrency: number) => {
        let idx = 0;
        const next = async (u: string) => {
          const perKey = ['turnover_v1', scope.tenant_id, scope.sub_brand_id, normalizedGameId ?? '', start.toISOString(), end.toISOString(), u].join(':');
          const cachedTurnover = getCache(perKey);
          if (typeof cachedTurnover === 'number') {
            turnoverByUsername.set(u, cachedTurnover);
            return;
          }
          try {
            const t = await sumJokerTurnover(service as any, start, end, u);
            turnoverByUsername.set(u, t);
            setCache(perKey, t, 60);
          } catch {
            turnoverByUsername.set(u, 0);
          }
        };
        const worker = async () => {
          for (;;) {
            const i = idx++;
            if (i >= items.length) return;
            const u = items[i];
            if (turnoverByUsername.has(u)) continue;
            await next(u);
          }
        };
        const n = Math.max(1, Math.min(concurrency, items.length));
        await Promise.all(Array.from({ length: n }, () => worker()));
      };
      await runQueue(unique, 5);
      for (const r of rows as any[]) {
        const u = String(r.player_game_id ?? '');
        if (!u) continue;
        r.turnover = turnoverByUsername.get(u) ?? 0;
      }

      const rangeDays = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      const chunks = Math.max(1, Math.ceil(rangeDays / 30));
      const maxPlayersForGrand = 200;
      const maxApiCalls = 300;
      if (totalItemsNum > 0 && totalItemsNum <= maxPlayersForGrand && totalItemsNum * chunks <= maxApiCalls) {
        const allUsersSql = `
          SELECT DISTINCT p.player_game_id AS player_game_id
          ${sqlJoin}
          ${sqlWhere}
          AND p.player_game_id IS NOT NULL
          LIMIT ${maxPlayersForGrand}
        `;
        const allUserRows = await sequelize.query(allUsersSql, { replacements, type: QueryTypes.SELECT });
        const allUsernames = (allUserRows as any[])
          .map((x) => String((x as any)?.player_game_id ?? '').trim())
          .filter((s) => s.length > 0);
        let grandTurnover = 0;
        const seen = new Set<string>();
        for (const u of allUsernames) {
          if (seen.has(u)) continue;
          seen.add(u);
          try {
            const perKey = ['turnover_v1', scope.tenant_id, scope.sub_brand_id, normalizedGameId ?? '', start.toISOString(), end.toISOString(), u].join(':');
            const cachedTurnover = getCache(perKey);
            if (typeof cachedTurnover === 'number') {
              grandTurnover += cachedTurnover;
              continue;
            }
            const v = await sumJokerTurnover(service as any, start, end, u);
            setCache(perKey, v, 60);
            grandTurnover += v;
          } catch {
          }
        }
        (totals as any).turnover = grandTurnover;
      }
    }

    const payload = {
      rows,
      totalItems: totalItemsNum,
      page: pageNum,
      pageSize: pageSizeNum,
      game,
      totals,
      turnoverSupported,
    };
    setCache(cacheKey, payload, 3);
    res.setHeader('Cache-Control', 'private, max-age=3');
    sendSuccess(res, 'Code1', payload);
  } catch (err: any) {
    sendError(res, 'Code9000', 500, { detail: err?.original?.sqlMessage ?? err?.message ?? 'Failed to get report' });
  }
};

export const getPlayerGameLogReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const { startDate, endDate, gameId, username, page, pageSize, refresh } = req.query as any;
    if (!startDate || !endDate) {
      sendError(res, 'Code9004', 400);
      return;
    }

    const start = parseDateParam(String(startDate));
    const end = parseDateParam(String(endDate));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      sendError(res, 'Code9004', 400);
      return;
    }
    if (end.getTime() - start.getTime() > 30 * 24 * 60 * 60 * 1000) {
      sendError(res, 'Code9004', 400, { detail: 'player_game_log_range_exceeds_30d' });
      return;
    }

    const gid = gameId != null && String(gameId).trim().length > 0 ? Number(gameId) : null;
    const normalizedGameId = gid && Number.isFinite(gid) && gid > 0 ? gid : null;
    const uname = typeof username === 'string' ? username.trim() : '';
    const pageNumber = Math.max(1, Number.parseInt(String(page ?? '1'), 10) || 1);
    const pageSizeNumber = Math.max(1, Math.min(200, Number.parseInt(String(pageSize ?? '50'), 10) || 50));

    if (normalizedGameId) {
      const selectedGame = await Game.findOne({
        attributes: ['id'],
        where: withTenancyWhere(scope, { id: normalizedGameId } as any),
        raw: true,
      } as any);
      if (!selectedGame) {
        sendError(res, 'Code9004', 400);
        return;
      }
    }

    const shouldRefresh = String(refresh ?? 'true').trim().toLowerCase() !== 'false';
    let manualSyncFailed = false;
    if (shouldRefresh) {
      try {
        const results = await syncGameLogsForScope(scope, normalizedGameId);
        manualSyncFailed = results.some((result) => !result.success);
      } catch {
        manualSyncFailed = true;
      }
    }

    const where: any = withTenancyWhere(scope, {
      occurred_at: { [Op.between]: [start, end] },
    } as any);
    if (normalizedGameId) where.game_id = normalizedGameId;
    if (uname) where.player = uname;

    const [result, totalsRow, syncSummary] = await Promise.all([
      GameLog.findAndCountAll({
        where,
        attributes: [
          'id',
          'player',
          'game_id',
          'vendor_transaction_id',
          'round_id',
          'game_code',
          'game_provider',
          'game_name',
          'game_category',
          'start_balance',
          'end_balance',
          'amount',
          'result_amount',
          'occurred_at',
        ],
        order: [['occurred_at', 'DESC'], ['id', 'DESC']],
        offset: (pageNumber - 1) * pageSizeNumber,
        limit: pageSizeNumber,
        raw: true,
      } as any),
      GameLog.findOne({
        where,
        attributes: [
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('start_balance')), 0), 'start_balance'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('end_balance')), 0), 'end_balance'],
          [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'bet'],
          [
            sequelize.fn(
              'COALESCE',
              sequelize.literal('SUM(`result_amount` - `amount`)'),
              0,
            ),
            'win_lose',
          ],
        ],
        raw: true,
      } as any),
      getGameLogSyncSummary(scope, normalizedGameId),
    ]);

    const totalItems = Number(result.count ?? 0) || 0;
    const rows = (result.rows as any[]).map((row) => ({
      id: String(row.id),
      player: String(row.player ?? ''),
      game_id: row.game_id != null ? Number(row.game_id) : null,
      ocode: row.vendor_transaction_id ?? null,
      round_id: row.round_id ?? null,
      game_code: row.game_code ?? null,
      game_provider: row.game_provider ?? null,
      game_name: row.game_name ?? null,
      game_category: row.game_category ?? null,
      start_time: toDisplayDateTimeFromStoredTz8(row.occurred_at),
      end_time: toDisplayDateTimeFromStoredTz8(row.occurred_at),
      start_balance: toFiniteNumber(row.start_balance),
      end_balance: toFiniteNumber(row.end_balance),
      bet: toFiniteNumber(row.amount),
      win_lose: toFiniteNumber(row.result_amount) - toFiniteNumber(row.amount),
    }));
    const totalsRaw = (totalsRow as any) || {};
    const sync = manualSyncFailed
      ? { ...syncSummary, status: 'stale', errorCode: syncSummary.errorCode || 'vendor_sync_failed' }
      : syncSummary;

    await logAudit(
      req.user?.id ?? null,
      'GAME_LOG_QUERY_RESULT',
      null,
      {
        source: 'database',
        username: uname || null,
        rows: rows.length,
        totalItems,
        page: pageNumber,
        pageSize: pageSizeNumber,
        syncStatus: sync.status,
        dataThrough: sync.dataThrough,
      },
      getClientIp(req),
      { tenant_id: (scope as any)?.tenant_id ?? null, sub_brand_id: (scope as any)?.sub_brand_id ?? null },
    );

    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, 'Code1', {
      username: uname || null,
      rows,
      page: pageNumber,
      pageSize: pageSizeNumber,
      totalItems,
      hasMore: pageNumber * pageSizeNumber < totalItems,
      totals: {
        start_balance: toFiniteNumber(totalsRaw.start_balance),
        end_balance: toFiniteNumber(totalsRaw.end_balance),
        bet: toFiniteNumber(totalsRaw.bet),
        win_lose: toFiniteNumber(totalsRaw.win_lose),
      },
      sync,
    });
  } catch (err: any) {
    sendError(res, 'Code9000', 500, { detail: err?.original?.sqlMessage ?? err?.message ?? 'Failed to get report' });
  }
};

export const getPlayerGameLogHistoryUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = getTenancyScopeOrThrow(req);
    const { gameId, ocode, language } = req.query as any;
    const o = typeof ocode === 'string' ? ocode.trim() : '';
    if (!o) {
      sendError(res, 'Code9004', 400);
      return;
    }

    const gid = gameId != null && String(gameId).trim().length > 0 ? Number(gameId) : null;
    const normalizedGameId = gid && Number.isFinite(gid) && gid > 0 ? gid : null;
    const svc = await resolveVendorServiceForScope(scope, normalizedGameId, 'transactions');
    if (!svc || typeof (svc as any).getHistoryUrl !== 'function') {
      sendError(res, 'Code9004', 400, { detail: 'Game Log Is Expired' });
      return;
    }

    const lang = typeof language === 'string' && language.trim().length > 0 ? language.trim() : 'en';
    const urlCacheKey = ['game_log_url_v1', scope.tenant_id, scope.sub_brand_id, normalizedGameId ?? '', lang, o].join(':');
    const cachedUrl = getCache(urlCacheKey);
    if (cachedUrl && typeof cachedUrl === 'string') {
      res.setHeader('Cache-Control', 'private, max-age=60');
      sendSuccess(res, 'Code1', { url: cachedUrl });
      return;
    }

    await logAudit(
      req.user?.id ?? null,
      'GAME_LOG_HISTORY_URL',
      null,
      {
        gameId: normalizedGameId,
        ocode: o,
        language: lang,
      },
      getClientIp(req),
      { tenant_id: (scope as any)?.tenant_id ?? null, sub_brand_id: (scope as any)?.sub_brand_id ?? null },
    );

    const resp = await (svc as any).getHistoryUrl(o, lang);
    if (!resp?.success) {
      sendError(res, 'Code9000', 500, { detail: resp?.error || resp?.message || 'Failed to get history url' });
      return;
    }
    const url = typeof resp?.url === 'string' ? resp.url : '';
    if (url) {
      setCache(urlCacheKey, url, 60);
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    sendSuccess(res, 'Code1', { url: url || null });
  } catch (err: any) {
    sendError(res, 'Code9000', 500, { detail: err?.original?.sqlMessage ?? err?.message ?? 'Failed to get history url' });
  }
};
