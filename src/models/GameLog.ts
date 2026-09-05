import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class GameLog extends Model {
  public id!: string;
  public tenant_id!: number;
  public sub_brand_id!: number;
  public player_id!: number;
  public game_id!: number;
  public player!: string;
  public vendor_transaction_id!: string;
  public transaction_ocode!: string | null;
  public round_id!: string | null;
  public game_code!: string | null;
  public vendor_category!: string;
  public game_provider!: string | null;
  public game_name!: string | null;
  public game_category!: string | null;
  public description!: string | null;
  public transaction_type!: string | null;
  public currency_code!: string | null;
  public app_id!: string | null;
  public is_special!: boolean;
  public amount!: number;
  public free_amount!: number;
  public result_amount!: number;
  public start_balance!: number;
  public end_balance!: number;
  public occurred_at!: Date;
  public raw_details!: string | null;
  public raw_payload!: any;
  public first_seen_at!: Date;
  public last_seen_at!: Date;
}

GameLog.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    tenant_id: { type: DataTypes.INTEGER, allowNull: false },
    sub_brand_id: { type: DataTypes.INTEGER, allowNull: false },
    player_id: { type: DataTypes.INTEGER, allowNull: false },
    game_id: { type: DataTypes.INTEGER, allowNull: false },
    player: { type: DataTypes.STRING(255), allowNull: false },
    vendor_transaction_id: { type: DataTypes.STRING(191), allowNull: false },
    transaction_ocode: { type: DataTypes.STRING(191), allowNull: true },
    round_id: { type: DataTypes.STRING(191), allowNull: true },
    game_code: { type: DataTypes.STRING(191), allowNull: true },
    vendor_category: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'Game' },
    game_provider: { type: DataTypes.STRING(255), allowNull: true },
    game_name: { type: DataTypes.STRING(255), allowNull: true },
    game_category: { type: DataTypes.STRING(128), allowNull: true },
    description: { type: DataTypes.STRING(255), allowNull: true },
    transaction_type: { type: DataTypes.STRING(128), allowNull: true },
    currency_code: { type: DataTypes.STRING(32), allowNull: true },
    app_id: { type: DataTypes.STRING(128), allowNull: true },
    is_special: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    free_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    result_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    start_balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    end_balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    occurred_at: { type: DataTypes.DATE(3), allowNull: false },
    raw_details: { type: DataTypes.TEXT('medium'), allowNull: true },
    raw_payload: { type: DataTypes.JSON, allowNull: true },
    first_seen_at: { type: DataTypes.DATE(3), allowNull: false },
    last_seen_at: { type: DataTypes.DATE(3), allowNull: false },
  },
  {
    sequelize,
    modelName: 'GameLog',
    tableName: 'game_logs',
    timestamps: false,
    indexes: [
      {
        name: 'uq_game_logs_scope_ocode',
        unique: true,
        fields: ['tenant_id', 'sub_brand_id', 'game_id', 'vendor_transaction_id'],
      },
      { name: 'idx_game_logs_scope_time', fields: ['tenant_id', 'sub_brand_id', 'occurred_at'] },
      { name: 'idx_game_logs_scope_game_time', fields: ['tenant_id', 'sub_brand_id', 'game_id', 'occurred_at'] },
      { name: 'idx_game_logs_scope_player_time', fields: ['tenant_id', 'sub_brand_id', 'player', 'occurred_at'] },
      { name: 'idx_game_logs_retention', fields: ['occurred_at'] },
    ],
  },
);

export default GameLog;
