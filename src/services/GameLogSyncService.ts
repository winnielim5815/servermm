import crypto from 'crypto';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import { Game, GameLog, GameLogSyncState, Player, Product } from '../models';
import { VendorFactory } from './vendor/VendorFactory';
import { normalizeVendorGameLogPage } from './gameLogNormalize';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 365;
const OVERLAP_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const MAX_PAGES_PER_RUN = 5000;

type Scope = { tenant_id: number | null; sub_brand_id: number | null };

export type GameLogSyncResult = {
  gameId: number;
  success: boolean;
  skipped?: boolean;
  errorCode?: string;
};

const activeSyncs = new Map<string, Promise<GameLogSyncResult>>();
let scheduler: NodeJS.Timeout | null = null;
let retentionScheduler: NodeJS.Timeout | null = null;
let storageReady: Promise<void> | null = null;

const asDate = (value: any, fallback = new Date()): Date => {
  let normalized = value;
  if (typeof value === 'string') {
    const storedDate = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/);
    if (storedDate) normalized = `${storedDate[1]}T${storedDate[2]}+08:00`;
  }
  const parsed = value instanceof Date ? value : new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const floorMinute = (value: Date) => {
  const copy = new Date(value.getTime());
  copy.setSeconds(0, 0);
  return copy;
};

const ceilMinute = (value: Date) => {
  const floored = floorMinute(value);
  return new Date(floored.getTime() + 60_000);
};

const toVendorMinute = (value: Date) => {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
};

const scopeWhere = (scope: Scope) => ({
  tenant_id: scope.tenant_id,
  sub_brand_id: scope.sub_brand_id,
});

const syncKey = (scope: Scope, gameId: number) => `${scope.tenant_id ?? 'n'}:${scope.sub_brand_id ?? 'n'}:${gameId}`;

const safeErrorMessage = (error: any) => {
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  return (raw || 'Vendor game log sync failed').slice(0, 1000);
};

const ensureTable = async (tableName: string, createTable: () => Promise<unknown>) => {
  try {
    await sequelize.getQueryInterface().describeTable(tableName);
    return;
  } catch (error: any) {
    const code = error?.original?.code ?? error?.parent?.code ?? error?.code;
    if (code !== 'ER_NO_SUCH_TABLE') throw error;
  }

  try {
    await createTable();
  } catch (error: any) {
    // Another application instance may create the table or its indexes between
    // describeTable and sync.
    const code = error?.original?.code ?? error?.parent?.code ?? error?.code;
    if (code !== 'ER_TABLE_EXISTS_ERROR' && code !== 'ER_DUP_KEYNAME') throw error;
  }
};

export const ensureGameLogStorage = async () => {
  if (!storageReady) {
    storageReady = (async () => {
      await ensureTable(GameLog.getTableName() as string, () => GameLog.sync());
      await ensureTable(GameLogSyncState.getTableName() as string, () => GameLogSyncState.sync());
    })().catch((error) => {
      storageReady = null;
      throw error;
    });
  }
  await storageReady;
};

const acquireLease = async (state: GameLogSyncState, owner: string, attemptedAt: Date): Promise<boolean> => {
  const now = new Date();
  const [updated] = await GameLogSyncState.update(
    {
      lease_owner: owner,
      lease_expires_at: new Date(now.getTime() + LEASE_MS),
      status: 'syncing',
      last_attempt_at: attemptedAt,
      last_error_code: null,
      last_error_message: null,
    },
    {
      where: {
        id: state.id,
        [Op.or]: [
          { lease_owner: null },
          { lease_expires_at: null },
          { lease_expires_at: { [Op.lt]: now } },
          { lease_owner: owner },
        ],
      } as any,
    },
  );
  return updated === 1;
};

const loadAllowedPlayers = async (scope: Scope, usernames: string[]) => {
  const unique = Array.from(new Set(usernames.filter(Boolean)));
  const playerByUsername = new Map<string, number>();
  for (let index = 0; index < unique.length; index += 800) {
    const chunk = unique.slice(index, index + 800);
    const players = await Player.findAll({
      attributes: ['id', 'player_game_id'],
      where: {
        ...scopeWhere(scope),
        player_game_id: { [Op.in]: chunk },
      } as any,
      raw: true,
    } as any);
    for (const player of players as any[]) {
      const username = String(player?.player_game_id ?? '').trim();
      const id = Number(player?.id ?? 0);
      if (username && Number.isFinite(id) && id > 0) playerByUsername.set(username.toUpperCase(), id);
    }
  }
  return playerByUsername;
};

const persistPage = async (
  response: any,
  scope: Scope,
  gameId: number,
  providerLabel: string,
) => {
  const normalized = normalizeVendorGameLogPage(response);
  if (normalized.length === 0) return 0;

  const playerByUsername = await loadAllowedPlayers(scope, normalized.map((row) => row.player));
  const now = new Date();
  const records = normalized.flatMap((row) => {
    const playerId = playerByUsername.get(row.player.toUpperCase());
    if (!playerId || scope.tenant_id == null || scope.sub_brand_id == null) return [];
    return [{
      tenant_id: scope.tenant_id,
      sub_brand_id: scope.sub_brand_id,
      player_id: playerId,
      game_id: gameId,
      player: row.player,
      vendor_transaction_id: row.vendorTransactionId,
      transaction_ocode: row.transactionOCode,
      round_id: row.roundId,
      game_code: row.gameCode,
      vendor_category: row.vendorCategory,
      game_provider: providerLabel,
      game_name: row.gameName,
      game_category: row.gameCategory,
      description: row.description,
      transaction_type: row.transactionType,
      currency_code: row.currencyCode,
      app_id: row.appId,
      is_special: row.isSpecial,
      amount: row.amount,
      free_amount: row.freeAmount,
      result_amount: row.resultAmount,
      start_balance: row.startBalance,
      end_balance: row.endBalance,
      occurred_at: row.occurredAt,
      raw_details: row.rawDetails,
      raw_payload: row.rawPayload,
      first_seen_at: now,
      last_seen_at: now,
    }];
  });

  if (records.length === 0) return 0;
  await GameLog.bulkCreate(records as any[], {
    updateOnDuplicate: [
      'player_id',
      'player',
      'transaction_ocode',
      'round_id',
      'game_code',
      'vendor_category',
      'game_provider',
      'game_name',
      'game_category',
      'description',
      'transaction_type',
      'currency_code',
      'app_id',
      'is_special',
      'amount',
      'free_amount',
      'result_amount',
      'start_balance',
      'end_balance',
      'occurred_at',
      'raw_details',
      'raw_payload',
      'last_seen_at',
    ],
  } as any);
  return records.length;
};

const runGameSyncInternal = async (game: Game, scope: Scope): Promise<GameLogSyncResult> => {
  const gameId = Number((game as any).id);
  const service = await VendorFactory.getServiceByGame(gameId);
  if (!service || typeof (service as any).getTransactionsByMinute !== 'function') {
    return { gameId, success: true, skipped: true };
  }

  const now = new Date();
  const [state] = await GameLogSyncState.findOrCreate({
    where: { ...scopeWhere(scope), game_id: gameId } as any,
    defaults: {
      ...scopeWhere(scope),
      game_id: gameId,
      collection_started_at: now,
      cursor_at: now,
      status: 'idle',
    } as any,
  });

  const owner = crypto.randomUUID();
  const acquired = await acquireLease(state, owner, now);
  if (!acquired) return { gameId, success: true, skipped: true };

  try {
    await state.reload();
    const productId = Number((game as any).product_id ?? 0);
    const product = productId > 0 ? await Product.findByPk(productId as any) : null;
    const providerLabel = String((product as any)?.provider ?? (game as any).name ?? 'Vendor');
    const collectionStart = asDate((state as any).collection_started_at, now);
    const targetEnd = ceilMinute(now);

    let windowStart = (state as any).window_start_at
      ? asDate((state as any).window_start_at)
      : new Date(Math.max(collectionStart.getTime(), asDate((state as any).cursor_at, now).getTime() - OVERLAP_MS));
    windowStart = floorMinute(windowStart);
    let savedWindowEnd = (state as any).window_end_at ? asDate((state as any).window_end_at) : null;
    let nextId = String((state as any).next_id ?? '').trim();
    let pages = 0;

    while (windowStart.getTime() < targetEnd.getTime()) {
      const windowEnd = savedWindowEnd ?? new Date(Math.min(windowStart.getTime() + MAX_WINDOW_MS, targetEnd.getTime()));
      await GameLogSyncState.update(
        {
          window_start_at: windowStart,
          window_end_at: windowEnd,
          next_id: nextId || null,
          lease_expires_at: new Date(Date.now() + LEASE_MS),
        },
        { where: { id: state.id, lease_owner: owner } as any },
      );

      for (;;) {
        if (pages >= MAX_PAGES_PER_RUN) throw new Error('Vendor pagination safety limit reached');
        const response = await (service as any).getTransactionsByMinute(
          toVendorMinute(windowStart),
          toVendorMinute(windowEnd),
          { nextId },
        );
        if (!response?.success) {
          throw new Error(response?.error || response?.message || 'Vendor rejected game log sync');
        }

        await persistPage(response, scope, gameId, providerLabel);
        pages += 1;
        nextId = response?.nextId ? String(response.nextId) : '';
        await GameLogSyncState.update(
          {
            next_id: nextId || null,
            lease_expires_at: new Date(Date.now() + LEASE_MS),
          },
          { where: { id: state.id, lease_owner: owner } as any },
        );
        if (!nextId) break;
      }

      await GameLogSyncState.update(
        {
          cursor_at: windowEnd,
          window_start_at: null,
          window_end_at: null,
          next_id: null,
        },
        { where: { id: state.id, lease_owner: owner } as any },
      );
      windowStart = windowEnd;
      savedWindowEnd = null;
    }

    await GameLogSyncState.update(
      {
        cursor_at: targetEnd,
        status: 'idle',
        last_success_at: new Date(),
        last_error_code: null,
        last_error_message: null,
        lease_owner: null,
        lease_expires_at: null,
      },
      { where: { id: state.id, lease_owner: owner } as any },
    );
    return { gameId, success: true };
  } catch (error: any) {
    await GameLogSyncState.update(
      {
        status: 'stale',
        last_error_code: 'vendor_sync_failed',
        last_error_message: safeErrorMessage(error),
        lease_owner: null,
        lease_expires_at: null,
      },
      { where: { id: state.id, lease_owner: owner } as any },
    );
    return { gameId, success: false, errorCode: 'vendor_sync_failed' };
  }
};

const runGameSync = (game: Game, scope: Scope) => {
  const gameId = Number((game as any).id);
  const key = syncKey(scope, gameId);
  const existing = activeSyncs.get(key);
  if (existing) return existing;
  const pending = runGameSyncInternal(game, scope).finally(() => activeSyncs.delete(key));
  activeSyncs.set(key, pending);
  return pending;
};

const loadSyncableGames = async (scope?: Scope, gameId?: number | null) => {
  const where: any = { use_api: true, status: 'active' };
  if (scope) Object.assign(where, scopeWhere(scope));
  if (gameId) where.id = gameId;
  return Game.findAll({ where, order: [['id', 'ASC']] } as any);
};

const runWithConcurrency = async (games: Game[], concurrency = 3) => {
  const results: GameLogSyncResult[] = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= games.length) return;
      const game = games[index] as any;
      const scope: Scope = {
        tenant_id: game.tenant_id == null ? null : Number(game.tenant_id),
        sub_brand_id: game.sub_brand_id == null ? null : Number(game.sub_brand_id),
      };
      if (scope.tenant_id == null || scope.sub_brand_id == null) {
        results.push({ gameId: Number(game.id), success: true, skipped: true });
        continue;
      }
      results.push(await runGameSync(game, scope));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, games.length || 1)) }, () => worker()));
  return results;
};

export const syncGameLogsForScope = async (scope: Scope, gameId?: number | null) => {
  await ensureGameLogStorage();
  const games = await loadSyncableGames(scope, gameId);
  return runWithConcurrency(games);
};

export const syncAllGameLogs = async () => {
  await ensureGameLogStorage();
  const games = await loadSyncableGames();
  return runWithConcurrency(games);
};

export const getGameLogSyncSummary = async (scope: Scope, gameId?: number | null) => {
  const activeGames = await loadSyncableGames(scope, gameId);
  const activeGameIds = activeGames
    .map((game) => Number((game as any).id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const where: any = {
    ...scopeWhere(scope),
    game_id: { [Op.in]: activeGameIds },
  };
  const states = await GameLogSyncState.findAll({ where, raw: true } as any) as any[];
  if (states.length === 0) {
    return {
      status: 'stale',
      collectionStartedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      dataThrough: null,
      errorCode: 'game_log_sync_not_started',
    };
  }

  const maximumDate = (field: string) => states.reduce<Date | null>((latest, state) => {
    if (!state?.[field]) return latest;
    const date = asDate(state[field]);
    return !latest || date.getTime() > latest.getTime() ? date : latest;
  }, null);
  const minimumDate = (field: string) => states.reduce<Date | null>((earliest, state) => {
    if (!state?.[field]) return earliest;
    const date = asDate(state[field]);
    return !earliest || date.getTime() < earliest.getTime() ? date : earliest;
  }, null);

  const oldestSuccess = minimumDate('last_success_at');
  const isStale =
    states.some((state) => state.status !== 'idle' || !state.last_success_at) ||
    !oldestSuccess ||
    Date.now() - oldestSuccess.getTime() > BACKGROUND_INTERVAL_MS + 5 * 60 * 1000;
  const rawDataThrough = minimumDate('cursor_at');
  const dataThrough = rawDataThrough
    ? new Date(Math.min(rawDataThrough.getTime(), Date.now()))
    : null;
  return {
    status: states.some((state) => state.status === 'syncing') ? 'syncing' : isStale ? 'stale' : 'fresh',
    collectionStartedAt: maximumDate('collection_started_at')?.toISOString() ?? null,
    lastAttemptAt: maximumDate('last_attempt_at')?.toISOString() ?? null,
    lastSuccessAt: oldestSuccess?.toISOString() ?? null,
    dataThrough: dataThrough?.toISOString() ?? null,
    errorCode: isStale ? String(states.find((state) => state.last_error_code)?.last_error_code || 'game_log_sync_stale') : null,
  };
};

export const purgeExpiredGameLogs = async () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return GameLog.destroy({ where: { occurred_at: { [Op.lt]: cutoff } } as any });
};

export const startGameLogSyncScheduler = () => {
  if (scheduler) return;
  void syncAllGameLogs().catch((error) => console.error('Game log initial sync failed:', safeErrorMessage(error)));
  void purgeExpiredGameLogs().catch((error) => console.error('Game log retention cleanup failed:', safeErrorMessage(error)));
  scheduler = setInterval(() => {
    void syncAllGameLogs().catch((error) => console.error('Game log scheduled sync failed:', safeErrorMessage(error)));
  }, BACKGROUND_INTERVAL_MS);
  retentionScheduler = setInterval(() => {
    void purgeExpiredGameLogs().catch((error) => console.error('Game log retention cleanup failed:', safeErrorMessage(error)));
  }, RETENTION_INTERVAL_MS);
  scheduler.unref?.();
  retentionScheduler.unref?.();
};

export const stopGameLogSyncScheduler = () => {
  if (scheduler) clearInterval(scheduler);
  if (retentionScheduler) clearInterval(retentionScheduler);
  scheduler = null;
  retentionScheduler = null;
};
