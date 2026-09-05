import User from './User';
import Permission from './Permission';
import UserPermission from './UserPermission';
import Role from './Role';
import RolePermission from './RolePermission';
import UserRole from './UserRole';
import BankAccount from './BankAccount';
import Player from './Player';
import Transaction from './Transaction';
import AuditLog from './AuditLog';
import Game from './Game';
import GameAdjustment from './GameAdjustment';
import BankCatalog from './BankCatalog';
import Setting from './Setting';
import PlayerStats from './PlayerStats';
import UserSession from './UserSession';
import UserDeviceLock from './UserDeviceLock';
import LandingPage from './LandingPage';
import LandingPageVisit from './LandingPageVisit';
import LandingPageEvent from './LandingPageEvent';
import Product from './Product';
import Tenant from './Tenant';
import SubBrand from './SubBrand';
import UserTenant from './UserTenant';
import GameLog from './GameLog';
import GameLogSyncState from './GameLogSyncState';

// User - Permission (Direct Many-to-Many - Deprecated but kept for compatibility if needed)
User.belongsToMany(Permission, { through: UserPermission, foreignKey: 'userId', otherKey: 'permissionId' });
Permission.belongsToMany(User, { through: UserPermission, foreignKey: 'permissionId', otherKey: 'userId' });

// Role - Permission (Many-to-Many)
Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'roleId', otherKey: 'permissionId' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permissionId', otherKey: 'roleId' });

// User - Role (Many-to-Many)
User.belongsToMany(Role, { through: UserRole, foreignKey: 'userId', otherKey: 'roleId' });
Role.belongsToMany(User, { through: UserRole, foreignKey: 'roleId', otherKey: 'userId' });

// Tenant - Role (One-to-Many)
Tenant.hasMany(Role, { foreignKey: 'tenant_id' });
Role.belongsTo(Tenant, { foreignKey: 'tenant_id' });

// Player - Game (Many-to-One)
Player.belongsTo(Game, { foreignKey: 'game_id' });
Game.hasMany(Player, { foreignKey: 'game_id' });

// Player - PlayerStats (One-to-Many)
Player.hasMany(PlayerStats, { foreignKey: 'player_id' });
PlayerStats.belongsTo(Player, { foreignKey: 'player_id' });

// Transaction relationships
Transaction.belongsTo(Player, { foreignKey: 'player_id', onDelete: 'SET NULL' });
Transaction.belongsTo(BankAccount, { foreignKey: 'bank_account_id' });
Transaction.belongsTo(User, { foreignKey: 'operator_id', as: 'operator' });
Transaction.belongsTo(Game, { foreignKey: 'game_id' });
Game.hasMany(Transaction, { foreignKey: 'game_id' });

// Locally persisted vendor game history
GameLog.belongsTo(Player, { foreignKey: 'player_id' });
Player.hasMany(GameLog, { foreignKey: 'player_id' });
GameLog.belongsTo(Game, { foreignKey: 'game_id' });
Game.hasMany(GameLog, { foreignKey: 'game_id' });
GameLogSyncState.belongsTo(Game, { foreignKey: 'game_id' });
Game.hasOne(GameLogSyncState, { foreignKey: 'game_id' });

// AuditLog - User (One-to-Many)
User.hasMany(AuditLog, { foreignKey: 'userId' });
AuditLog.belongsTo(User, { foreignKey: 'userId', onDelete: 'SET NULL' });

// Game - GameAdjustment (One-to-Many)
Game.hasMany(GameAdjustment, { foreignKey: 'game_id' });
GameAdjustment.belongsTo(Game, { foreignKey: 'game_id' });

// Game - Product (Many-to-One)
Game.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(Game, { foreignKey: 'product_id' });

// User - UserSession (One-to-Many)
User.hasMany(UserSession, { foreignKey: 'user_id' });
UserSession.belongsTo(User, { foreignKey: 'user_id' });

// User - UserDeviceLock (One-to-Many)
User.hasMany(UserDeviceLock, { foreignKey: 'user_id', as: 'deviceLocks' });
UserDeviceLock.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
UserDeviceLock.belongsTo(User, { foreignKey: 'locked_by', as: 'lockedBy' });

// LandingPage - User (Many-to-One)
LandingPage.belongsTo(User, { foreignKey: 'operator_id', as: 'operator', onDelete: 'SET NULL' });
LandingPageVisit.belongsTo(LandingPage, { foreignKey: 'landing_page_id', onDelete: 'CASCADE' });
LandingPageEvent.belongsTo(LandingPage, { foreignKey: 'landing_page_id', onDelete: 'CASCADE' });

// Tenant - SubBrand (One-to-Many)
Tenant.hasMany(SubBrand, { foreignKey: 'tenant_id' });
SubBrand.belongsTo(Tenant, { foreignKey: 'tenant_id' });

Tenant.belongsTo(User, { foreignKey: 'created_by', as: 'createdBy', constraints: false });
Tenant.belongsTo(User, { foreignKey: 'updated_by', as: 'updatedBy', constraints: false });
SubBrand.belongsTo(User, { foreignKey: 'created_by', as: 'createdBy', constraints: false });
SubBrand.belongsTo(User, { foreignKey: 'updated_by', as: 'updatedBy', constraints: false });

// User - Tenant/SubBrand (Many-to-One)
User.belongsTo(Tenant, { foreignKey: 'tenant_id' });
User.belongsTo(SubBrand, { foreignKey: 'sub_brand_id' });
SubBrand.hasMany(User, { foreignKey: 'sub_brand_id' });

// User - Managed Tenants (Many-to-Many)
User.belongsToMany(Tenant, { through: UserTenant, foreignKey: 'userId', otherKey: 'tenantId', as: 'ManagedTenants' });
Tenant.belongsToMany(User, { through: UserTenant, foreignKey: 'tenantId', otherKey: 'userId', as: 'TenantAgents' });

export {
  User,
  Permission,
  UserPermission,
  Role,
  RolePermission,
  UserRole,
  BankAccount,
  Player,
  Transaction,
  AuditLog,
  Game,
  GameAdjustment,
  BankCatalog,
  Setting,
  PlayerStats,
  UserSession,
  UserDeviceLock,
  LandingPage,
  LandingPageVisit,
  LandingPageEvent,
  Product,
  Tenant,
  SubBrand,
  UserTenant,
  GameLog,
  GameLogSyncState,
};
