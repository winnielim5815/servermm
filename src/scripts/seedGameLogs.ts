import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { GameLog, Player } from '../models';
import { ensureGameLogStorage } from '../services/GameLogSyncService';

const TEST_PREFIX = 'TEST-GAMELOG-';

type SeedTarget = {
  game_id: number;
  game_name: string;
  tenant_id: number;
  sub_brand_id: number;
  player_id: number;
  player: string;
  provider: string | null;
  created_test_player?: boolean;
};

const requestedCount = () => {
  const value = Number.parseInt(String(process.env.GAME_LOG_SEED_COUNT ?? '24'), 10);
  return Math.max(1, Math.min(200, Number.isFinite(value) ? value : 24));
};

const loadTarget = async (): Promise<SeedTarget | null> => {
  const requestedGameId = Number.parseInt(String(process.env.GAME_LOG_SEED_GAME_ID ?? ''), 10);
  const requestedPlayerId = Number.parseInt(String(process.env.GAME_LOG_SEED_PLAYER_ID ?? ''), 10);
  const rows = await sequelize.query<SeedTarget>(
    `SELECT
       g.id AS game_id,
       g.name AS game_name,
       g.tenant_id,
       g.sub_brand_id,
       p.id AS player_id,
       p.player_game_id AS player,
       pr.provider
     FROM games g
     INNER JOIN players p
       ON p.tenant_id = g.tenant_id
      AND p.sub_brand_id = g.sub_brand_id
     LEFT JOIN products pr ON pr.id = g.product_id
     WHERE g.status = 'active'
       AND g.use_api = 1
       AND g.tenant_id IS NOT NULL
       AND g.sub_brand_id IS NOT NULL
       AND (:gameId IS NULL OR g.id = :gameId)
       AND (:playerId IS NULL OR p.id = :playerId)
     ORDER BY g.id ASC, p.id ASC
     LIMIT 1`,
    {
      replacements: {
        gameId: Number.isFinite(requestedGameId) && requestedGameId > 0 ? requestedGameId : null,
        playerId: Number.isFinite(requestedPlayerId) && requestedPlayerId > 0 ? requestedPlayerId : null,
      },
      type: QueryTypes.SELECT,
    },
  );
  if (rows[0]) return rows[0];
  if (Number.isFinite(requestedPlayerId) && requestedPlayerId > 0) return null;

  const fallbackGames = await sequelize.query<Omit<SeedTarget, 'player_id' | 'player'>>(
    `SELECT
       g.id AS game_id,
       g.name AS game_name,
       g.tenant_id,
       g.sub_brand_id,
       pr.provider
     FROM games g
     LEFT JOIN products pr ON pr.id = g.product_id
     WHERE g.status = 'active'
       AND g.tenant_id IS NOT NULL
       AND g.sub_brand_id IS NOT NULL
       AND (:gameId IS NULL OR g.id = :gameId)
     ORDER BY g.use_api DESC, g.id ASC
     LIMIT 1`,
    {
      replacements: {
        gameId: Number.isFinite(requestedGameId) && requestedGameId > 0 ? requestedGameId : null,
      },
      type: QueryTypes.SELECT,
    },
  );
  const game = fallbackGames[0];
  if (!game) return null;

  const testUsername = 'TESTGAMELOG';
  const [player, created] = await Player.findOrCreate({
    where: {
      tenant_id: Number(game.tenant_id),
      sub_brand_id: Number(game.sub_brand_id),
      player_game_id: testUsername,
    } as any,
    defaults: {
      tenant_id: Number(game.tenant_id),
      sub_brand_id: Number(game.sub_brand_id),
      player_game_id: testUsername,
      tags: ['game-log-test'],
    } as any,
  });

  return {
    ...game,
    player_id: Number((player as any).id),
    player: String((player as any).player_game_id),
    created_test_player: created,
  };
};

const cleanup = async () => {
  const removed = await GameLog.destroy({
    where: sequelize.where(
      sequelize.col('vendor_transaction_id'),
      'LIKE',
      `${TEST_PREFIX}%`,
    ) as any,
  });
  console.log(`Removed ${removed} seeded game-log row(s).`);
};

const inspectTargets = async () => {
  const [games, playerScopes] = await Promise.all([
    sequelize.query(
      `SELECT id, name, tenant_id, sub_brand_id, use_api, status
       FROM games
       ORDER BY status = 'active' DESC, use_api DESC, id ASC
       LIMIT 20`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT tenant_id, sub_brand_id, COUNT(*) AS player_count
       FROM players
       GROUP BY tenant_id, sub_brand_id
       ORDER BY player_count DESC
       LIMIT 20`,
      { type: QueryTypes.SELECT },
    ),
  ]);
  console.log(JSON.stringify({ games, playerScopes }, null, 2));
};

const verifySeededRows = async () => {
  const [summary, sample] = await Promise.all([
    sequelize.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(DISTINCT vendor_transaction_id) AS unique_transactions,
         SUM(JSON_VALID(raw_details)) AS valid_detail_rows,
         SUM(ABS(end_balance - (start_balance - amount + result_amount)) < 0.001) AS balanced_rows,
         MIN(occurred_at) AS oldest_at,
         MAX(occurred_at) AS newest_at
       FROM game_logs
       WHERE vendor_transaction_id LIKE :marker`,
      { replacements: { marker: `${TEST_PREFIX}%` }, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT id, tenant_id, sub_brand_id, game_id, player, vendor_transaction_id,
              game_name, amount, result_amount, occurred_at
       FROM game_logs
       WHERE vendor_transaction_id LIKE :marker
       ORDER BY occurred_at DESC, id DESC
       LIMIT 3`,
      { replacements: { marker: `${TEST_PREFIX}%` }, type: QueryTypes.SELECT },
    ),
  ]);
  console.log(JSON.stringify({ summary: summary[0] ?? null, sample }, null, 2));
};

const seed = async () => {
  const target = await loadTarget();
  if (!target) {
    throw new Error(
      'No active API game and player sharing the same tenant/sub-brand were found. '
      + 'Set GAME_LOG_SEED_GAME_ID and GAME_LOG_SEED_PLAYER_ID to choose a target.',
    );
  }

  const count = requestedCount();
  const now = new Date();
  const runId = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const records = Array.from({ length: count }, (_, index) => {
    const amount = 5 + (index % 8) * 2.5;
    const resultAmount = index % 4 === 0 ? amount * 2.2 : index % 4 === 1 ? amount : 0;
    const startBalance = 500 - index * 3;
    const endBalance = startBalance - amount + resultAmount;
    const occurredAt = new Date(now.getTime() - index * 15 * 60 * 1000);
    const vendorTransactionId = `${TEST_PREFIX}${runId}-${String(index + 1).padStart(3, '0')}`;
    const detail = {
      seeded: true,
      runId,
      spin: index + 1,
      symbols: ['TEST-A', 'TEST-K', 'TEST-WILD'],
      linesWon: resultAmount > amount ? [1, 3] : [],
    };

    return {
      tenant_id: Number(target.tenant_id),
      sub_brand_id: Number(target.sub_brand_id),
      player_id: Number(target.player_id),
      game_id: Number(target.game_id),
      player: target.player,
      vendor_transaction_id: vendorTransactionId,
      transaction_ocode: `TX-${vendorTransactionId}`,
      round_id: `ROUND-${runId}-${index + 1}`,
      game_code: 'TEST-SLOT-001',
      vendor_category: index % 9 === 0 ? 'Jackpot' : 'Game',
      game_provider: target.provider || target.game_name,
      game_name: 'Test Fortune Slot',
      game_category: 'Slot',
      description: 'Generated Game Log test data',
      transaction_type: 'TEST',
      currency_code: 'MYR',
      app_id: 'LOCAL-SEED',
      is_special: index % 9 === 0,
      amount,
      free_amount: 0,
      result_amount: resultAmount,
      start_balance: startBalance,
      end_balance: endBalance,
      occurred_at: occurredAt,
      raw_details: JSON.stringify(detail),
      raw_payload: { ...detail, vendorTransactionId },
      first_seen_at: now,
      last_seen_at: now,
    };
  });

  await sequelize.transaction(async (transaction) => {
    await GameLog.bulkCreate(records as any[], { transaction });
  });

  const inserted = await GameLog.count({
    where: {
      tenant_id: target.tenant_id,
      sub_brand_id: target.sub_brand_id,
      game_id: target.game_id,
      vendor_transaction_id: records.map((record) => record.vendor_transaction_id),
    } as any,
  });

  console.log(JSON.stringify({
    inserted,
    marker: `${TEST_PREFIX}${runId}`,
    tenantId: Number(target.tenant_id),
    subBrandId: Number(target.sub_brand_id),
    gameId: Number(target.game_id),
    gameName: target.game_name,
    playerId: Number(target.player_id),
    player: target.player,
    createdTestPlayer: Boolean(target.created_test_player),
    newestAt: records[0]?.occurred_at.toISOString(),
    oldestAt: records[records.length - 1]?.occurred_at.toISOString(),
  }, null, 2));
};

const main = async () => {
  try {
    await sequelize.authenticate();
    await ensureGameLogStorage();
    if (process.argv.includes('--inspect')) await inspectTargets();
    else if (process.argv.includes('--verify')) await verifySeededRows();
    else if (process.argv.includes('--cleanup')) await cleanup();
    else await seed();
  } finally {
    await sequelize.close();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
