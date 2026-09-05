import sequelize from '../config/database';
import { User, Permission, Role, Setting, Tenant, SubBrand, UserRole, UserTenant } from '../models';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GLOBAL_ROLE_SPECS, SYSTEM_ROLE_NAMES, TENANT_DEFAULT_ROLE_SPECS } from '../constants/systemRoles';
import { Op, QueryTypes } from 'sequelize';

dotenv.config();

const generateApiKey = () => crypto.randomBytes(32).toString('hex');

// Permission definitions
const PERMISSIONS = [
  // --- Routes ---
  { slug: 'route:dashboard', description: 'Access Dashboard' },
  { slug: 'view:dashboard_financials', description: 'View Dashboard Financials' },
  { slug: 'route:transactions', description: 'Access Transactions' },
  { slug: 'route:transaction_history', description: 'Access Transaction History' },
  { slug: 'route:banks', description: 'Access Banks' },
  { slug: 'route:players', description: 'Access Players' },
  { slug: 'route:audit', description: 'Access Audit Logs' },
  { slug: 'route:reports', description: 'Access Reports' },
  { slug: 'route:reports:summary', description: 'Access Summary Report' },
  { slug: 'route:reports:player_winloss', description: 'Access Player Win/Loss Report' },
  { slug: 'route:reports:game_log', description: 'Access Game Log Report' },
  { slug: 'route:reports:kiosk', description: 'Access Games Kiosk Report' },
  { slug: 'route:users', description: 'Access User Management' },
  { slug: 'route:settings', description: 'Access Settings' },
  { slug: 'route:marketing', description: 'Access Marketing' },
  { slug: 'route:reports:subbrand_winloss', description: 'Access Subbrand Win/Loss Report' },

  // --- Views ---
  { slug: 'view:bank_balance', description: 'View Bank Balances' },
  { slug: 'view:bank_full_account', description: 'View Full Account #' },
  { slug: 'view:player_profit', description: 'View Player Profit' },
  { slug: 'view:sensitive_logs', description: 'View Sensitive Logs' },
  { slug: 'view:player_banks', description: 'View Player Bank Accounts' },
  { slug: 'view:system_settings', description: 'View System Settings' },
  { slug: 'view:games', description: 'View Game List' },
  { slug: 'action:game_operational', description: 'Game Operational' },
  { slug: 'action:game_adjust_balance', description: 'Adjust Game Balance' },
  { slug: 'view:bank_catalog', description: 'View Bank Catalog' },
  { slug: 'view:player_metadata', description: 'View Player Metadata' },
  { slug: 'view:audit_logs', description: 'View all users audit logs' },
  { slug: 'view:device_sessions', description: 'View device sessions for own account' },

  // --- Actions ---
  { slug: 'action:deposit_create', description: 'Create Deposit' },
  { slug: 'action:bonus_create', description: 'Create Bonus' },
  { slug: 'action:withdrawal_create', description: 'Create Withdrawal' },
  { slug: 'action:burn_create', description: 'Create Walve' },
  { slug: 'action:transaction_edit', description: 'Edit Transaction' },
  { slug: 'action:bank_create', description: 'Create Bank' },
  { slug: 'action:bank_edit', description: 'Edit Bank' },
  { slug: 'action:bank_delete', description: 'Delete Bank' },
  { slug: 'action:bank_adjust', description: 'Adjust Balance' },
  { slug: 'action:player_create', description: 'Create Player' },
  { slug: 'action:player_edit', description: 'Edit Player' },
  { slug: 'action:player_banks_edit', description: 'Edit Player Bank Accounts' },
  { slug: 'action:user_view', description: 'View Users' },
  { slug: 'action:user_create', description: 'Create Users' },
  { slug: 'action:user_edit', description: 'Edit Users' },
  { slug: 'action:user_delete', description: 'Delete Users' },
  { slug: 'action:user_api_manage', description: 'Rotate User API Keys' },
  { slug: 'action:role_view', description: 'View Roles' },
  { slug: 'action:role_manage', description: 'Manage Roles' },
  { slug: 'action:settings_manage', description: 'Manage Settings' },
  { slug: 'action:device_session_revoke', description: 'Revoke device sessions for own account' },
  { slug: 'action:device_fingerprint_lock', description: 'Lock device fingerprint for an account' },
  { slug: 'action:security_manage', description: 'Manage Security Settings (2FA, etc.)' },
  { slug: 'action:marketing_manage', description: 'Manage Marketing Landing Pages' },
];

async function initDb() {
  console.log('========================================');
  console.log('🔧 Database Initialization Started');
  console.log('========================================');
  console.log(`Database: ${process.env.DB_NAME}`);
  console.log(`Host: ${process.env.DB_SOCKET_PATH || process.env.DB_HOST}`);
  console.log('========================================\n');

  try {
    // Test database connection
    console.log('⏳ Testing database connection...');
    await sequelize.authenticate();
    console.log('✅ Database connected successfully.\n');

    try {
      const dbName = (process.env.DB_NAME || (sequelize as any)?.config?.database || '').trim();
      if (dbName) {
        const roleTenantColumnRows = (await sequelize.query(
          `
          SELECT COUNT(*) AS cnt
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = :db
            AND TABLE_NAME = 'roles'
            AND COLUMN_NAME = 'tenant_id'
          `,
          { replacements: { db: dbName }, type: QueryTypes.SELECT },
        )) as any[];

        const tenantsTableRows = (await sequelize.query(
          `
          SELECT COUNT(*) AS cnt
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = :db
            AND TABLE_NAME = 'tenants'
          `,
          { replacements: { db: dbName }, type: QueryTypes.SELECT },
        )) as any[];

        const hasRoleTenantId = Number(roleTenantColumnRows?.[0]?.cnt ?? 0) > 0;
        const hasTenantsTable = Number(tenantsTableRows?.[0]?.cnt ?? 0) > 0;

        if (hasRoleTenantId && hasTenantsTable) {
          await sequelize.query(`
            UPDATE roles r
            LEFT JOIN tenants t ON t.id = r.tenant_id
            SET r.tenant_id = NULL
            WHERE r.tenant_id IS NOT NULL
              AND t.id IS NULL
          `);
        }
      }
    } catch (e) {
      void e;
    }

    // Sync models (create tables)
    console.log('⏳ Syncing database tables...');
    await sequelize.sync({ alter: true });
    console.log('✅ Database tables synced.\n');

    let defaultTenant: any = null;
    let defaultSubBrand: any = null;

    // Initialize default tenant
    const defaultTenantPrefix = (process.env.TENANT || process.env.INIT_TENANT_PREFIX || '').trim().toUpperCase();
    const defaultTenantName = (process.env.TENANT || process.env.INIT_TENANT_NAME || '').trim();

    if (defaultTenantPrefix && defaultTenantName) {
      const [tenant] = await Tenant.findOrCreate({
        where: { prefix: defaultTenantPrefix },
        defaults: {
          prefix: defaultTenantPrefix,
          name: defaultTenantName,
          status: 'active',
        },
      });
      defaultTenant = tenant;
      console.log(`✅ Default tenant ready: ${defaultTenant.name} (${defaultTenant.prefix})`);

      // Initialize default sub-brand
      const defaultSubBrandCode = (process.env.SUB_BRAND || process.env.INIT_SUB_BRAND_CODE || '').trim().toUpperCase();
      const defaultSubBrandName = (process.env.SUB_BRAND || process.env.INIT_SUB_BRAND_NAME || '').trim();

      if (defaultSubBrandCode && defaultSubBrandName) {
        const [subBrand] = await SubBrand.findOrCreate({
          where: { code: defaultSubBrandCode },
          defaults: {
            tenant_id: defaultTenant.id,
            code: defaultSubBrandCode,
            name: defaultSubBrandName,
            status: 'active',
          },
        });
        defaultSubBrand = subBrand;
        console.log(`✅ Default sub-brand ready: ${defaultSubBrand.name} (${defaultSubBrand.code})\n`);
      }
    }

    // Seed Permissions
    console.log('⏳ Seeding permissions...');
    for (const p of PERMISSIONS) {
      await Permission.findOrCreate({
        where: { slug: p.slug },
        defaults: p,
      });
    }
    console.log(`✅ ${PERMISSIONS.length} permissions ready.\n`);

    // Seed Roles
    console.log('⏳ Seeding roles...');
    const allTenants = await Tenant.findAll({ order: [['id', 'ASC']] });

      for (const r of GLOBAL_ROLE_SPECS) {
        const [role] = await Role.findOrCreate({
          where: { tenant_id: null, name: r.name } as any,
          defaults: {
            tenant_id: null,
            name: r.name,
            description: r.description,
            isSystem: r.isSystem
          } as any
        });

        if (r.permissions.includes('*')) {
          const allPerms = await Permission.findAll();
          await (role as any).setPermissions(allPerms);
        } else {
          const perms = await Permission.findAll({
            where: { slug: r.permissions }
          });
          await (role as any).setPermissions(perms);
        }
      }

      const legacyGlobalRoles = await Role.findAll({
        where: {
          tenant_id: null,
          name: { [Op.ne]: SYSTEM_ROLE_NAMES.superAdmin }
        } as any,
        include: [Permission],
      });
      const legacyRoleByName = new Map<string, any>();
      for (const r of legacyGlobalRoles as any[]) {
        const key = String(r?.name ?? '').toLowerCase();
        if (key) legacyRoleByName.set(key, r);
      }

      for (const tenant of allTenants as any[]) {
        for (const spec of TENANT_DEFAULT_ROLE_SPECS) {
          const [role, created] = await Role.findOrCreate({
            where: { tenant_id: tenant.id, name: spec.name } as any,
            defaults: {
              tenant_id: tenant.id,
              name: spec.name,
              description: spec.description,
              isSystem: false,
            } as any,
          });

          if (created) {
            const legacy = legacyRoleByName.get(String(spec.name).toLowerCase());
            const legacyPerms = legacy?.Permissions ? legacy.Permissions : null;
            if (Array.isArray(legacyPerms) && legacyPerms.length > 0) {
              await (role as any).setPermissions(legacyPerms);
            } else if (spec.permissions.includes('*')) {
              const allPerms = await Permission.findAll();
              await (role as any).setPermissions(allPerms);
            } else {
              const perms = await Permission.findAll({ where: { slug: spec.permissions } });
              await (role as any).setPermissions(perms);
            }
          }
        }
      }

      for (const legacy of legacyGlobalRoles as any[]) {
        const legacyNameLower = String(legacy?.name ?? '').toLowerCase();
        const mappings = await UserRole.findAll({
          where: { roleId: legacy.id } as any,
          attributes: ['userId', 'roleId'],
        });

        for (const m of mappings as any[]) {
          const user = await User.findByPk(m.userId, { attributes: ['id', 'tenant_id'] } as any);
          if (!user) continue;

          const tenantIds: number[] = [];
          const baseTid = Number((user as any).tenant_id ?? null);
          if (Number.isFinite(baseTid) && baseTid > 0) tenantIds.push(baseTid);

          if (legacyNameLower === 'agent') {
            const rows = await UserTenant.findAll({ where: { userId: user.id } as any, attributes: ['tenantId'] });
            for (const r of rows as any[]) {
              const tid = Number(r.tenantId ?? null);
              if (Number.isFinite(tid) && tid > 0 && !tenantIds.includes(tid)) tenantIds.push(tid);
            }
          }

          for (const tid of tenantIds) {
            const tenantRole = await Role.findOne({ where: { tenant_id: tid, name: legacy.name } as any });
            if (!tenantRole) continue;
            await UserRole.findOrCreate({ where: { userId: user.id, roleId: (tenantRole as any).id } as any });
          }

          await UserRole.destroy({ where: { userId: user.id, roleId: legacy.id } as any });
        }
      }

      console.log(`✅ Roles ready.\n`);

    // Create Admin User
    console.log('⏳ Creating admin user...');

    if (!defaultTenant) {
      defaultTenant = await Tenant.findOne({ order: [['id', 'ASC']] } as any);
    }
    if (!defaultSubBrand) {
      defaultSubBrand = await SubBrand.findOne({ order: [['id', 'ASC']] } as any);
    }

    // Fixed admin credentials
    const adminUsername = 'superadminsparkx';
    const adminPassword = crypto.randomBytes(16).toString('base64url');
    const adminFullName = 'System Administrator';

    if (!defaultTenant || !defaultSubBrand) {
      console.log(`ℹ️  Skip admin create: missing tenant/sub-brand.\n`);
      console.log(`ℹ️  Please set TENANT and SUB_BRAND in your .env file and run db:install again.\n`);
      process.exit(0);
      return;
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const [admin, created] = await User.findOrCreate({
      where: { username: adminUsername },
      defaults: {
        username: adminUsername,
        password_hash: hashedPassword,
        status: 'active',
        full_name: adminFullName,
        api_key: generateApiKey(),
        tenant_id: defaultTenant.id,
        sub_brand_id: defaultSubBrand.id,
        is_super_admin: true,
      },
    });

    if (created) {
      // Assign Super Admin role
      const superAdminRole = await Role.findOne({ where: { tenant_id: null, name: 'Super Admin' } as any });
      if (superAdminRole) {
        // @ts-ignore
        await admin.setRoles([superAdminRole]);
      }

      console.log('\n========================================');
      console.log('🎉 ADMIN USER CREATED');
      console.log('========================================');
      console.log(`Username: ${adminUsername}`);
      console.log(`Password: ${adminPassword}`);
      console.log(`Full Name: ${adminFullName}`);
      console.log('========================================');
      console.log('⚠️  IMPORTANT: Save these credentials now!');
      console.log('   This password will NOT be shown again.');
      console.log('========================================\n');
    } else {
      console.log(`ℹ️  Admin user '${adminUsername}' already exists. Updating roles...`);
      // Ensure Super Admin role is assigned even if user already exists
      const superAdminRole = await Role.findOne({ where: { tenant_id: null, name: 'Super Admin' } as any });
      if (superAdminRole) {
        // @ts-ignore
        await admin.setRoles([superAdminRole]);
        console.log(`✅ Super Admin role assigned to existing user.\n`);
      } else {
        console.log(`⚠️  Super Admin role not found. Please check role seeding.\n`);
      }
    }

    if (false) {
      // Initialize Settings
      console.log('⏳ Initializing settings...');

      const defaultReferralSources = ['Google', 'Facebook', 'Telegram', 'Line', 'Friend'];
      const defaultPlayerTags = [
        { name: 'New', color: '#3b82f6' },
        { name: 'VIP', color: '#f97316' },
        { name: 'Bonus Hunter', color: '#ef4444' },
        { name: 'Regular', color: '#22c55e' },
      ];

      await Setting.findOrCreate({
        where: { key: 'referralSources' },
        defaults: { key: 'referralSources', value: defaultReferralSources }
      });

      await Setting.findOrCreate({
        where: { key: 'tagOptions' },
        defaults: { key: 'tagOptions', value: defaultPlayerTags }
      });

      console.log('✅ Default settings ready.\n');
    }

    console.log('========================================');
    console.log('✅ DATABASE INITIALIZATION COMPLETE');
    console.log('========================================');
    console.log('You can now start using the application.');
    console.log('========================================');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ ERROR: Database initialization failed:');
    console.error(error);
    process.exit(1);
  }
}

initDb();
