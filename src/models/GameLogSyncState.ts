import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class GameLogSyncState extends Model {
  public id!: number;
  public tenant_id!: number;
  public sub_brand_id!: number;
  public game_id!: number;
  public collection_started_at!: Date;
  public cursor_at!: Date;
  public window_start_at!: Date | null;
  public window_end_at!: Date | null;
  public next_id!: string | null;
  public status!: 'idle' | 'syncing' | 'stale';
  public last_attempt_at!: Date | null;
  public last_success_at!: Date | null;
  public last_error_code!: string | null;
  public last_error_message!: string | null;
  public lease_owner!: string | null;
  public lease_expires_at!: Date | null;
}

GameLogSyncState.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tenant_id: { type: DataTypes.INTEGER, allowNull: false },
    sub_brand_id: { type: DataTypes.INTEGER, allowNull: false },
    game_id: { type: DataTypes.INTEGER, allowNull: false },
    collection_started_at: { type: DataTypes.DATE(3), allowNull: false },
    cursor_at: { type: DataTypes.DATE(3), allowNull: false },
    window_start_at: { type: DataTypes.DATE(3), allowNull: true },
    window_end_at: { type: DataTypes.DATE(3), allowNull: true },
    next_id: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'idle' },
    last_attempt_at: { type: DataTypes.DATE(3), allowNull: true },
    last_success_at: { type: DataTypes.DATE(3), allowNull: true },
    last_error_code: { type: DataTypes.STRING(64), allowNull: true },
    last_error_message: { type: DataTypes.STRING(1000), allowNull: true },
    lease_owner: { type: DataTypes.STRING(64), allowNull: true },
    lease_expires_at: { type: DataTypes.DATE(3), allowNull: true },
  },
  {
    sequelize,
    modelName: 'GameLogSyncState',
    tableName: 'game_log_sync_states',
    timestamps: false,
    indexes: [
      {
        name: 'uq_game_log_sync_scope_game',
        unique: true,
        fields: ['tenant_id', 'sub_brand_id', 'game_id'],
      },
      { name: 'idx_game_log_sync_lease', fields: ['lease_expires_at'] },
    ],
  },
);

export default GameLogSyncState;
