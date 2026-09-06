import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { User, Permission, Role, Setting, SubBrand, Tenant } from '../models';
import { logAudit } from '../services/AuditService';
import crypto from 'crypto';
import sequelize from '../config/database';
import UserSession from '../models/UserSession';
import UserDeviceLock from '../models/UserDeviceLock';
import { AuthRequest } from '../middleware/auth';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import {
  normalizeBase32Secret,
  resolveVerifiedSetupSecret,
  verifyTotpCode,
} from '../services/twoFactorPolicy';
import { setCache, getCache, invalidateCache } from '../services/CacheService';
import { sendSuccess, sendError, sendWarning } from '../utils/response';

const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET environment variable must be set');
}

const MAX_DEVICES_PER_USER = Number(process.env.MAX_DEVICES_PER_USER || 2);
type SessionKickStrategy = 'OLDEST' | 'ALL_OTHERS';
const SESSION_KICK_STRATEGY: SessionKickStrategy =
  (process.env.SESSION_KICK_STRATEGY as SessionKickStrategy) || 'OLDEST';

type SessionEventPayload = {
  sessionId: number;
  deviceId: string;
  jwtId: string | null;
  reason: string | null;
  revokedAt: string;
};

const sseClientsByUser = new Map<number, Set<Response>>();

const addSseClient = (userId: number, res: Response) => {
  let set = sseClientsByUser.get(userId);
  if (!set) {
    set = new Set<Response>();
    sseClientsByUser.set(userId, set);
  }
  set.add(res);
};

const removeSseClient = (userId: number, res: Response) => {
  const set = sseClientsByUser.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    sseClientsByUser.delete(userId);
  }
};

const broadcastSessionRevoked = (userId: number, payload: SessionEventPayload) => {
  const set = sseClientsByUser.get(userId);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const res of set) {
    res.write(`event: session_revoked\n`);
    res.write(`data: ${text}\n\n`);
  }
};

const deriveDeviceNameFromUserAgent = (ua: string | null | undefined): string | null => {
  if (!ua) return null;
  let os = 'Unknown OS';
  let browser = 'Browser';
  
  // More precise OS detection with version-specific patterns
  const uaLower = ua.toLowerCase();
  
  // Windows detection with version
  if (uaLower.includes('windows nt 10')) os = 'Windows 10/11';
  else if (uaLower.includes('windows nt 6.3')) os = 'Windows 8.1';
  else if (uaLower.includes('windows nt 6.2')) os = 'Windows 8';
  else if (uaLower.includes('windows nt 6.1')) os = 'Windows 7';
  else if (uaLower.includes('windows nt 6.0')) os = 'Windows Vista';
  else if (uaLower.includes('windows nt 5.1')) os = 'Windows XP';
  else if (uaLower.includes('windows nt 5.0')) os = 'Windows 2000';
  else if (uaLower.includes('windows')) os = 'Windows';
  
  // macOS detection with version
  else if (uaLower.includes('mac os x 10_15') || uaLower.includes('mac os x 10.15')) os = 'macOS Catalina';
  else if (uaLower.includes('mac os x 10_14') || uaLower.includes('mac os x 10.14')) os = 'macOS Mojave';
  else if (uaLower.includes('mac os x 10_13') || uaLower.includes('mac os x 10.13')) os = 'macOS High Sierra';
  else if (uaLower.includes('mac os x 10_12') || uaLower.includes('mac os x 10.12')) os = 'macOS Sierra';
  else if (uaLower.includes('mac os x 10_11') || uaLower.includes('mac os x 10.11')) os = 'macOS El Capitan';
  else if (uaLower.includes('mac os x 10_10') || uaLower.includes('mac os x 10.10')) os = 'macOS Yosemite';
  else if (uaLower.includes('mac os x')) os = 'macOS';
  else if (uaLower.includes('macintosh')) os = 'macOS';
  
  // Linux distributions with better detection
  else if (uaLower.includes('ubuntu')) {
    if (uaLower.includes('ubuntu/20')) os = 'Ubuntu 20.04';
    else if (uaLower.includes('ubuntu/18')) os = 'Ubuntu 18.04';
    else if (uaLower.includes('ubuntu/22')) os = 'Ubuntu 22.04';
    else if (uaLower.includes('ubuntu/16')) os = 'Ubuntu 16.04';
    else os = 'Ubuntu';
  }
  else if (uaLower.includes('debian')) {
    if (uaLower.includes('debian/10')) os = 'Debian 10';
    else if (uaLower.includes('debian/11')) os = 'Debian 11';
    else if (uaLower.includes('debian/9')) os = 'Debian 9';
    else os = 'Debian';
  }
  else if (uaLower.includes('fedora')) {
    if (uaLower.includes('fedora/36')) os = 'Fedora 36';
    else if (uaLower.includes('fedora/35')) os = 'Fedora 35';
    else if (uaLower.includes('fedora/34')) os = 'Fedora 34';
    else os = 'Fedora';
  }
  else if (uaLower.includes('centos')) {
    if (uaLower.includes('centos/7')) os = 'CentOS 7';
    else if (uaLower.includes('centos/8')) os = 'CentOS 8';
    else if (uaLower.includes('centos/6')) os = 'CentOS 6';
    else os = 'CentOS';
  }
  else if (uaLower.includes('red hat')) os = 'Red Hat';
  else if (uaLower.includes('arch linux')) os = 'Arch Linux';
  else if (uaLower.includes('manjaro')) os = 'Manjaro';
  else if (uaLower.includes('linux mint')) os = 'Linux Mint';
  else if (uaLower.includes('opensuse')) os = 'openSUSE';
  else if (uaLower.includes('elementary os')) os = 'Elementary OS';
  else if (uaLower.includes('zorin os')) os = 'Zorin OS';
  else if (uaLower.includes('deepin')) os = 'Deepin';
  else if (uaLower.includes('pop!_os')) os = 'Pop!_OS';
  else if (uaLower.includes('kali')) os = 'Kali Linux';
  else if (uaLower.includes('parrot')) os = 'Parrot OS';
  else if (uaLower.includes('linux')) os = 'Linux';
  
  // Mobile OS with better detection
  else if (uaLower.includes('android')) {
    if (uaLower.includes('android 13')) os = 'Android 13';
    else if (uaLower.includes('android 12')) os = 'Android 12';
    else if (uaLower.includes('android 11')) os = 'Android 11';
    else if (uaLower.includes('android 10')) os = 'Android 10';
    else if (uaLower.includes('android 9')) os = 'Android 9';
    else if (uaLower.includes('android 8')) os = 'Android 8';
    else if (uaLower.includes('android 7')) os = 'Android 7';
    else if (uaLower.includes('android 6')) os = 'Android 6';
    else os = 'Android';
  }
  else if (uaLower.includes('iphone') || uaLower.includes('ipod')) {
    if (uaLower.includes('iphone os 16')) os = 'iOS 16';
    else if (uaLower.includes('iphone os 15')) os = 'iOS 15';
    else if (uaLower.includes('iphone os 14')) os = 'iOS 14';
    else if (uaLower.includes('iphone os 13')) os = 'iOS 13';
    else if (uaLower.includes('iphone os 12')) os = 'iOS 12';
    else if (uaLower.includes('iphone os 11')) os = 'iOS 11';
    else os = 'iOS';
  }
  else if (uaLower.includes('ipad')) {
    if (uaLower.includes('cpu os 16')) os = 'iPadOS 16';
    else if (uaLower.includes('cpu os 15')) os = 'iPadOS 15';
    else if (uaLower.includes('cpu os 14')) os = 'iPadOS 14';
    else if (uaLower.includes('cpu os 13')) os = 'iPadOS 13';
    else os = 'iPadOS';
  }
  
  // BSD systems
  else if (uaLower.includes('freebsd')) os = 'FreeBSD';
  else if (uaLower.includes('openbsd')) os = 'OpenBSD';
  else if (uaLower.includes('netbsd')) os = 'NetBSD';
  else if (uaLower.includes('dragonfly')) os = 'DragonFly BSD';
  
  // Other systems
  else if (uaLower.includes('cros') || uaLower.includes('chrome os')) os = 'Chrome OS';
  else if (uaLower.includes('windows phone')) os = 'Windows Phone';
  else if (uaLower.includes('blackberry')) os = 'BlackBerry';
  else if (uaLower.includes('webos')) os = 'webOS';
  else if (uaLower.includes('symbian')) os = 'Symbian';
  else if (uaLower.includes('nokia')) os = 'Nokia';
  else if (uaLower.includes('samsung')) os = 'Samsung Bada';
  else if (uaLower.includes('bada')) os = 'Bada';
  
  // More precise browser detection
  // Chrome/Chromium-based browsers
  if (uaLower.includes('edg/')) {
    const edgeMatch = ua.match(/Edg\/(\d+\.\d+)/);
    browser = edgeMatch ? `Edge ${edgeMatch[1]}` : 'Edge';
  }
  else if (uaLower.includes('chrome/') && !uaLower.includes('edg/')) {
    const chromeMatch = ua.match(/Chrome\/(\d+\.\d+)/);
    browser = chromeMatch ? `Chrome ${chromeMatch[1]}` : 'Chrome';
  }
  else if (uaLower.includes('chromium/')) {
    const chromiumMatch = ua.match(/Chromium\/(\d+\.\d+)/);
    browser = chromiumMatch ? `Chromium ${chromiumMatch[1]}` : 'Chromium';
  }
  
  // Firefox-based browsers
  else if (uaLower.includes('firefox/')) {
    const firefoxMatch = ua.match(/Firefox\/(\d+\.\d+)/);
    browser = firefoxMatch ? `Firefox ${firefoxMatch[1]}` : 'Firefox';
  }
  else if (uaLower.includes('waterfox/')) {
    const waterfoxMatch = ua.match(/Waterfox\/(\d+\.\d+)/);
    browser = waterfoxMatch ? `Waterfox ${waterfoxMatch[1]}` : 'Waterfox';
  }
  else if (uaLower.includes('pale moon/')) {
    const paleMoonMatch = ua.match(/PaleMoon\/(\d+\.\d+)/);
    browser = paleMoonMatch ? `Pale Moon ${paleMoonMatch[1]}` : 'Pale Moon';
  }
  
  // Safari
  else if (uaLower.includes('safari/') && !uaLower.includes('chrome')) {
    const safariMatch = ua.match(/Version\/(\d+\.\d+)/);
    browser = safariMatch ? `Safari ${safariMatch[1]}` : 'Safari';
  }
  
  // Opera
  else if (uaLower.includes('opr/') || uaLower.includes('opera/')) {
    const operaMatch = ua.match(/(?:OPR|Opera)\/(\d+\.\d+)/);
    browser = operaMatch ? `Opera ${operaMatch[1]}` : 'Opera';
  }
  
  // Internet Explorer
  else if (uaLower.includes('msie')) {
    const ieMatch = ua.match(/MSIE (\d+\.\d+)/);
    browser = ieMatch ? `Internet Explorer ${ieMatch[1]}` : 'Internet Explorer';
  }
  else if (uaLower.includes('trident/')) {
    const tridentMatch = ua.match(/Trident\/(\d+\.\d+)/);
    browser = tridentMatch ? `Internet Explorer ${tridentMatch[1]}` : 'Internet Explorer';
  }
  
  // Other browsers with version detection
  else if (uaLower.includes('vivaldi/')) {
    const vivaldiMatch = ua.match(/Vivaldi\/(\d+\.\d+)/);
    browser = vivaldiMatch ? `Vivaldi ${vivaldiMatch[1]}` : 'Vivaldi';
  }
  else if (uaLower.includes('brave/')) {
    const braveMatch = ua.match(/Brave\/(\d+\.\d+)/);
    browser = braveMatch ? `Brave ${braveMatch[1]}` : 'Brave';
  }
  else if (uaLower.includes('duckduckgo/')) {
    const ddgMatch = ua.match(/DuckDuckGo\/(\d+\.\d+)/);
    browser = ddgMatch ? `DuckDuckGo ${ddgMatch[1]}` : 'DuckDuckGo';
  }
  else if (uaLower.includes('tor browser')) {
    browser = 'Tor Browser';
  }
  else if (uaLower.includes('maxthon/')) {
    const maxthonMatch = ua.match(/Maxthon\/(\d+\.\d+)/);
    browser = maxthonMatch ? `Maxthon ${maxthonMatch[1]}` : 'Maxthon';
  }
  else if (uaLower.includes('seamonkey/')) {
    const seamonkeyMatch = ua.match(/SeaMonkey\/(\d+\.\d+)/);
    browser = seamonkeyMatch ? `SeaMonkey ${seamonkeyMatch[1]}` : 'SeaMonkey';
  }
  else if (uaLower.includes('konqueror/')) {
    const konquerorMatch = ua.match(/Konqueror\/(\d+\.\d+)/);
    browser = konquerorMatch ? `Konqueror ${konquerorMatch[1]}` : 'Konqueror';
  }
  else if (uaLower.includes('epiphany/')) {
    const epiphanyMatch = ua.match(/Epiphany\/(\d+\.\d+)/);
    browser = epiphanyMatch ? `Epiphany ${epiphanyMatch[1]}` : 'Epiphany';
  }
  else if (uaLower.includes('midori/')) {
    const midoriMatch = ua.match(/Midori\/(\d+\.\d+)/);
    browser = midoriMatch ? `Midori ${midoriMatch[1]}` : 'Midori';
  }
  else if (uaLower.includes('qupzilla/')) {
    const qupzillaMatch = ua.match(/QupZilla\/(\d+\.\d+)/);
    browser = qupzillaMatch ? `QupZilla ${qupzillaMatch[1]}` : 'QupZilla';
  }
  else if (uaLower.includes('lynx')) {
    const lynxMatch = ua.match(/Lynx\/(\d+\.\d+)/);
    browser = lynxMatch ? `Lynx ${lynxMatch[1]}` : 'Lynx';
  }
  else if (uaLower.includes('w3m')) {
    browser = 'w3m';
  }
  else if (uaLower.includes('links')) {
    const linksMatch = ua.match(/Links\/(\d+\.\d+)/);
    browser = linksMatch ? `Links ${linksMatch[1]}` : 'Links';
  }

  return `${os} ${browser}`;
};

type LoginAttemptState = {
  failures: number;
  tempLockUntil?: number;
};

const loginAttemptsByUser = new Map<number, LoginAttemptState>();
const unknownUserAttempts = new Map<string, LoginAttemptState>();

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

const generateApiKey = () => crypto.randomBytes(32).toString('hex');

const PRE_AUTH_SECRET = process.env.JWT_SECRET + '_PRE_AUTH';

const finalizeLogin = async (user: any, req: Request, res: Response, deviceId: string, deviceName: string | undefined, clientIp: string | null) => {
    const userAgent = req.headers['user-agent'] || null;
    const jti = crypto.randomBytes(16).toString('hex');

    const t = await sequelize.transaction();
    let kickedSessions: { original: any; updated: any }[] = [];

    try {
      const activeSessions = await UserSession.findAll({
        where: {
          user_id: user.id,
          is_active: true,
        },
        order: [['createdAt', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE as any,
      });

      // Revoke sessions with same device ID
      for (const s of activeSessions.filter((s) => s.device_id === deviceId)) {
        const original = s.toJSON();
        s.is_active = false;
        s.revoked_at = new Date();
        s.revoked_reason = 'REPLACED_BY_NEW_LOGIN';
        await s.save({ transaction: t });
        kickedSessions.push({ original, updated: s.toJSON() });
      }

      const remaining = activeSessions.filter((s) => s.device_id !== deviceId);
      const MAX_ALLOWED = MAX_DEVICES_PER_USER; 
      
      const uniqueDevices = new Map<string, typeof remaining>();
      remaining.forEach(s => {
        if (!uniqueDevices.has(s.device_id)) {
           uniqueDevices.set(s.device_id, []);
        }
        uniqueDevices.get(s.device_id)?.push(s);
      });
      
      const currentDeviceCount = uniqueDevices.size;
      
      if (currentDeviceCount >= MAX_ALLOWED) {
         const devicesToKickCount = currentDeviceCount - MAX_ALLOWED + 1;
         const sortedDevices = Array.from(uniqueDevices.entries()).sort(([, sessionsA], [, sessionsB]) => {
            const sessionA = sessionsA[0];
            const sessionB = sessionsB[0];
            if (!sessionA || !sessionB) return 0;
            const timeA = sessionA.createdAt instanceof Date ? sessionA.createdAt.getTime() : new Date(sessionA.createdAt).getTime();
            const timeB = sessionB.createdAt instanceof Date ? sessionB.createdAt.getTime() : new Date(sessionB.createdAt).getTime();
            return timeA - timeB; 
         });
         
         const devicesToKick = sortedDevices.slice(0, devicesToKickCount);
         for (const [_, sessions] of devicesToKick) {
            for (const s of sessions) {
                const original = s.toJSON();
                s.is_active = false;
                s.revoked_at = new Date();
                s.revoked_reason = 'MAX_DEVICES_EXCEEDED';
                await s.save({ transaction: t });
                kickedSessions.push({ original, updated: s.toJSON() });
            }
         }
      }

      await UserSession.create(
        {
          user_id: user.id,
          device_id: deviceId,
          device_name:
            typeof deviceName === 'string' && deviceName.trim().length > 0
              ? deviceName.trim().slice(0, 191)
              : null,
          user_agent: userAgent ? userAgent.slice(0, 255) : null,
          ip_address: clientIp,
          jwt_id: jti,
          is_active: true,
          last_active_at: new Date(),
          fullname: (user as any).full_name || user.username,
        },
        { transaction: t }
      );

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        jti,
        deviceId: deviceId, 
        tokenVersion: user.token_version, 
      },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any }
    );

    for (const entry of kickedSessions) {
      await logAudit(
        user.id,
        'SESSION_FORCE_LOGOUT',
        entry.original,
        entry.updated,
        clientIp || undefined
      );
      const updated: any = entry.updated;
      const revokedAt =
        updated.revoked_at instanceof Date
          ? updated.revoked_at.toISOString()
          : new Date().toISOString();
      broadcastSessionRevoked(user.id, {
        sessionId: updated.id,
        deviceId: updated.device_id,
        jwtId: updated.jwt_id || null,
        reason: updated.revoked_reason || null,
        revokedAt,
      });
    }

    await logAudit(
      user.id,
      'LOGIN_SUCCESS',
      null,
      {
        deviceId: deviceId,
        jti,
      },
      clientIp || undefined
    );

    try {
      const effectiveIp = clientIp || null;
      await user.update({ last_login_at: new Date(), last_login_ip: effectiveIp });
    } catch (e) {
      console.error('Failed to update last login info:', e);
    }

    const encryptedToken = encrypt(token);

    const parseDuration = (duration: string) => {
      if (!duration) return 24 * 60 * 60 * 1000; 
      const match = duration.match(/^(\d+)([dhms])?$/);
      if (!match) return 24 * 60 * 60 * 1000;
      const val = parseInt(match[1], 10);
      const unit = match[2] || 'ms';
      switch(unit) {
        case 'd': return val * 24 * 60 * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'm': return val * 60 * 1000;
        case 's': return val * 1000;
        default: return val;
      }
    };
    const maxAge = parseDuration(process.env.JWT_EXPIRES_IN || '24h');

    res.cookie('_T', encryptedToken, {
      httpOnly: true,
      secure: true, 
      sameSite: 'none', 
      maxAge: maxAge 
    });

    sendSuccess(res, 'Code1', {
      t: encryptedToken,
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name || user.username
      }
    });
};

const encodePermissionSlug = (slug: string): string => {
  const b64 = Buffer.from(String(slug), 'utf8').toString('base64');
  const url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `P${url}`;
};

type MaintenanceGateSettings = {
  maintenance_mode?: boolean;
  allowed_roles?: string[];
  [key: string]: any;
};

const normalizeMaintenanceGateSettings = (value: any): MaintenanceGateSettings => {
  let raw: any = value;
  if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  if (!raw || typeof raw !== 'object') {
    raw = {};
  }
  const allowed = Array.isArray(raw.allowed_roles)
    ? raw.allowed_roles.map((r: any) => String(r)).filter((r: string) => r.trim().length > 0)
    : [];
  return {
    ...raw,
    maintenance_mode: Boolean(raw.maintenance_mode),
    allowed_roles: allowed,
  };
};

const getMaintenanceGateSettings = async (): Promise<MaintenanceGateSettings> => {
  const cacheKey = 'maintenance_gate:settings';
  const cached = getCache(cacheKey) as MaintenanceGateSettings | undefined;
  if (cached && typeof cached === 'object') {
    return cached;
  }
  const setting = await Setting.findByPk('maintenance');
  const normalized = normalizeMaintenanceGateSettings(setting ? (setting as any).value : { maintenance_mode: false });
  setCache(cacheKey, normalized, 30);
  return normalized;
};

const isAllowedDuringMaintenance = (settings: MaintenanceGateSettings, roleNames: string[]): boolean => {
  if (!settings.maintenance_mode) {
    return true;
  }
  const allowed = Array.isArray(settings.allowed_roles)
    ? settings.allowed_roles.map((r) => String(r).trim()).filter(Boolean)
    : [];
  if (allowed.length === 0) {
    return false;
  }
  const allowedSet = new Set(allowed.map((r) => r.toLowerCase()));
  return roleNames.some((name) => allowedSet.has(name.toLowerCase()));
};

const denyMaintenance = (res: Response, settings: MaintenanceGateSettings) => {
  sendWarning(res, 'api.systemIsUnderMaintenance', settings, undefined, 503);
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
	const clientIp = getClientIp(req);
    const { prefix, username, password, deviceId, deviceName } = req.body;

    const rawPrefix = typeof prefix === 'string' ? prefix.trim() : '';
    if (!rawPrefix) {
      sendError(res, 'Code231', 400);
      return;
    }

    const subBrand = await SubBrand.findOne({ where: { code: rawPrefix, status: 'active' } as any });
    if (!subBrand) {
      sendError(res, 'Code232', 404);
      return;
    }

    const user: any = await User.findOne({ 
      where: { username },
      include: [
        Permission,
        {
          model: Role,
          include: [Permission]
        }
      ]
    });

    if (!user) {
      const now = Date.now();
      const key = (username || '').trim().toLowerCase();
      const state: LoginAttemptState = unknownUserAttempts.get(key) ?? { failures: 0 };

      if (state.tempLockUntil && now < state.tempLockUntil) {
        const remainingSeconds = Math.ceil((state.tempLockUntil - now) / 1000);
        await logAudit(
          null,
          'LOGIN_BLOCKED',
          { username, reason: 'Unknown username temporary lockout', remainingSeconds },
          null,
          clientIp || undefined
        );
        sendWarning(res, 'Code204', { lockoutUntil: state.tempLockUntil }, { seconds: remainingSeconds }, 429);
        return;
      } else if (state.tempLockUntil && now >= state.tempLockUntil) {
        state.tempLockUntil = undefined;
      }

      state.failures += 1;

      if (state.failures > 5) {
        state.tempLockUntil = now + 30 * 1000;
        unknownUserAttempts.set(key, state);
        await logAudit(
          null,
          'LOGIN_BLOCKED',
          { username, reason: 'Unknown username too many failed attempts; temp lock', failures: state.failures, lockoutSeconds: 30 },
          null,
          clientIp || undefined
        );
        sendWarning(res, 'Code203', { lockoutUntil: state.tempLockUntil }, { seconds: 30 }, 429);
        return;
      }

      unknownUserAttempts.set(key, state);

      await logAudit(null, 'LOGIN_FAILED', { username, reason: 'User not found', failures: state.failures }, null, clientIp || undefined);
      sendError(res, 'Code200', 401);
      return;
    }

    if (user.status === 'locked') {
      await logAudit(user.id, 'LOGIN_BLOCKED', { reason: 'Account locked' }, null, clientIp || undefined);
      sendError(res, 'Code105', 403);
      return;
    }

    const isSuperAdmin = Boolean(user.is_super_admin) || Boolean(user?.Roles?.some((r: any) => r?.name === 'Super Admin'));
    if (!isSuperAdmin) {
      const userSubBrandId = Number(user.sub_brand_id);
      if (!Number.isFinite(userSubBrandId) || userSubBrandId !== subBrand.id) {
        await logAudit(
          user.id,
          'LOGIN_BLOCKED',
          { username, reason: 'Prefix sub brand mismatch', prefix: rawPrefix },
          null,
          clientIp || undefined,
        );
        sendError(res, 'Code233', 403);
        return;
      }
    }

    const now = Date.now();
    const state: LoginAttemptState = loginAttemptsByUser.get(user.id) ?? { failures: 0 };

    if (state.tempLockUntil && now < state.tempLockUntil) {
      const remainingSeconds = Math.ceil((state.tempLockUntil - now) / 1000);
      await logAudit(user.id, 'LOGIN_BLOCKED', { username, reason: 'Temporary lockout', remainingSeconds }, null, clientIp || undefined);
      sendWarning(res, 'Code204', { lockoutUntil: state.tempLockUntil }, { seconds: remainingSeconds }, 429);
      return;
    } else if (state.tempLockUntil && now >= state.tempLockUntil) {
      state.tempLockUntil = undefined;
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      state.failures += 1;

      if (state.failures > 5) {
        user.status = 'locked';
        await user.save();
        loginAttemptsByUser.delete(user.id);
        await logAudit(user.id, 'LOGIN_BLOCKED', { username, reason: 'Too many failed attempts; account locked', failures: state.failures }, null, clientIp || undefined);
        sendError(res, 'Code205', 403);
        return;
      }

      if (state.failures >= 4 && state.failures <= 5) {
        state.tempLockUntil = now + 30 * 1000;
        loginAttemptsByUser.set(user.id, state);
        await logAudit(
          user.id,
          'LOGIN_FAILED',
          { username, reason: 'Invalid password', failures: state.failures, lockoutSeconds: 30 },
          null,
          clientIp || undefined
        );
        sendWarning(res, 'Code203', { lockoutUntil: state.tempLockUntil }, { seconds: 30 }, 429);
        return;
      }

      loginAttemptsByUser.set(user.id, state);
      await logAudit(user.id, 'LOGIN_FAILED', { username, reason: 'Invalid password', failures: state.failures }, null, clientIp || undefined);
      sendError(res, 'Code201', 401);
      return;
    }

    if (state.failures > 0 || state.tempLockUntil) {
      loginAttemptsByUser.delete(user.id);
    }

    const maintenanceSettings = await getMaintenanceGateSettings();
    if (maintenanceSettings.maintenance_mode) {
      const roleNames = Array.isArray(user.Roles) ? user.Roles.map((r: any) => String(r?.name ?? '')).filter(Boolean) : [];
      if (!isAllowedDuringMaintenance(maintenanceSettings, roleNames)) {
        denyMaintenance(res, maintenanceSettings);
        return;
      }
    }

    if (!user.api_key) {
      await logAudit(
        user.id,
        'LOGIN_BLOCKED',
        { username, reason: 'Missing API key on login' },
        null,
        clientIp || undefined
      );
      sendError(res, 'Code106', 403);
      return;
    }

    const effectiveDeviceId =
      typeof deviceId === 'string' && deviceId.trim().length > 0
        ? deviceId.trim()
        : `auto-${(clientIp || 'unknown').replace(/[^a-zA-Z0-9]/g, '_')}`;

    const existingDeviceLock = await UserDeviceLock.findOne({
      where: {
        user_id: user.id,
        device_id: effectiveDeviceId,
      },
    });

    if (existingDeviceLock) {
      await logAudit(
        user.id,
        'LOGIN_BLOCKED_DEVICE_LOCK',
        { deviceId: effectiveDeviceId, lockId: existingDeviceLock.id },
        null,
        clientIp || undefined
      );
      sendError(res, 'Code107', 403);
      return;
    }

    const isSetupRequired = !user.two_factor_enabled;
    const stage = isSetupRequired ? '2fa_setup' : '2fa_verify';

    const preAuthToken = jwt.sign(
      {
        id: user.id,
        username: user.username,
        stage,
        prefix: rawPrefix,
        deviceId: effectiveDeviceId,
        deviceName: typeof deviceName === 'string' && deviceName.trim().length > 0 ? deviceName.trim().slice(0, 191) : null
      },
      PRE_AUTH_SECRET,
      { expiresIn: '10m' }
    );

    sendSuccess(res, 'Code1', {
      require2fa: true,
      setupRequired: isSetupRequired,
      token: preAuthToken
    });
  } catch (error) {
    console.error('Login error:', error);
    sendError(res, 'Code2', 500);
  }
};

export const setup2FA = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token } = req.body;
        if (!token) {
             sendError(res, 'Code207', 400);
             return;
        }

        let decoded: any;
        try {
            decoded = jwt.verify(token, PRE_AUTH_SECRET);
        } catch (e) {
             sendError(res, 'Code208', 401);
             return;
        }

        if (decoded.stage !== '2fa_setup') {
             sendError(res, 'Code209', 400);
             return;
        }

        const user: any = await User.findByPk(decoded.id, {
          include: [{ model: Role, attributes: ['name'] }]
        });
        const maintenanceSettings = await getMaintenanceGateSettings();
        if (maintenanceSettings.maintenance_mode) {
          const roleNames = Array.isArray(user?.Roles) ? user.Roles.map((r: any) => String(r?.name ?? '')).filter(Boolean) : [];
          if (!isAllowedDuringMaintenance(maintenanceSettings, roleNames)) {
            denyMaintenance(res, maintenanceSettings);
            return;
          }
        }
        const displayName = user?.full_name || decoded.username || 'User';

        const cacheKey = `2fa_setup_secret:${decoded.id}`;
        const cachedSecret = normalizeBase32Secret(getCache(cacheKey));
        const generatedSecret = cachedSecret
          ? null
          : speakeasy.generateSecret({ length: 20, name: `SparkX (${displayName})` });
        const secretBase32 = cachedSecret || generatedSecret!.base32;
        const otpauthUrl = generatedSecret?.otpauth_url || speakeasy.otpauthURL({
          secret: secretBase32,
          encoding: 'base32',
          label: `SparkX (${displayName})`,
        });

        // Store secret in cache for verification step (10 mins)
        setCache(cacheKey, secretBase32, 600);

        const qrCodeUrl = await QRCode.toDataURL(otpauthUrl);

        sendSuccess(res, 'Code1', {
            secret: secretBase32,
            qrCode: qrCodeUrl
        });

    } catch (error) {
        console.error('Setup 2FA error:', error);
        sendError(res, 'Code2', 500);
    }
};

export const verify2FA = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token, code, setupSecret } = req.body;
        const clientIp = getClientIp(req);

        if (!token || !code) {
             sendError(res, 'Code210', 400);
             return;
        }

        let decoded: any;
        try {
            decoded = jwt.verify(token, PRE_AUTH_SECRET);
        } catch (e) {
             sendError(res, 'Code208', 401);
             return;
        }

        const user: any = await User.findOne({ 
          where: { id: decoded.id },
          include: [
            Permission,
            {
              model: Role,
              include: [Permission]
            }
          ]
        });

        if (!user) {
             sendError(res, 'Code200', 404);
             return;
        }

        const maintenanceSettings = await getMaintenanceGateSettings();
        if (maintenanceSettings.maintenance_mode) {
          const roleNames = Array.isArray(user.Roles) ? user.Roles.map((r: any) => String(r?.name ?? '')).filter(Boolean) : [];
          if (!isAllowedDuringMaintenance(maintenanceSettings, roleNames)) {
            denyMaintenance(res, maintenanceSettings);
            return;
          }
        }

        if (decoded.stage === '2fa_setup') {
             // Prefer the secret shown by this setup response, then fall back for older clients.
             const cachedSecret = getCache(`2fa_setup_secret:${user.id}`);
             const hasSetupSecret = Boolean(normalizeBase32Secret(setupSecret));
             const hasCachedSecret = Boolean(normalizeBase32Secret(cachedSecret));
             if (!hasSetupSecret && !hasCachedSecret) {
                 sendError(res, 'Code212', 400);
                 return;
             }

             const secretToUse = resolveVerifiedSetupSecret({
                 setupSecret,
                 cachedSecret,
                 token: code,
             });

             if (!secretToUse) {
                await logAudit(user.id, 'TWOFA_VERIFY_FAILED', {
                  stage: 'setup',
                  setupSecretProvided: hasSetupSecret,
                  cachedSecretPresent: hasCachedSecret,
                }, null, clientIp || undefined);
                sendError(res, 'Code213', 401);
                return;
             }

             // Save to user
             user.two_factor_secret = encrypt(secretToUse as string);
             user.two_factor_enabled = true;
             await user.save();
             
             invalidateCache(`2fa_setup_secret:${user.id}`);
             
             await logAudit(user.id, 'TWOFA_SETUP', null, null, clientIp || undefined);

        } else if (decoded.stage === '2fa_verify') {
             if (!user.two_factor_enabled || !user.two_factor_secret) {
                 // Should not happen if logic is correct, but safe fallback
                 sendError(res, 'Code214', 400);
                 return;
             }

             const secret = decrypt(user.two_factor_secret);
             const verified = verifyTotpCode(secret, code);

             if (!verified) {
                await logAudit(user.id, 'TWOFA_VERIFY_FAILED', { stage: 'verify' }, null, clientIp || undefined);
                sendError(res, 'Code213', 401);
                return;
             }
        } else {
             sendError(res, 'Code215', 400);
             return;
        }

        // Success - Finalize Login
        await finalizeLogin(user, req, res, decoded.deviceId, decoded.deviceName, clientIp);

    } catch (error) {
        console.error('Verify 2FA error:', error);
        sendError(res, 'Code2', 500);
    }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    let token = req.cookies?._T || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);

    if (token) {
      if (isEncrypted(token)) {
        token = decrypt(token);
      }
      try {
        const decoded: any = jwt.verify(token, secret);
        if (decoded && decoded.id && decoded.jti) {
          const session = await UserSession.findOne({
            where: {
              user_id: decoded.id,
              jwt_id: decoded.jti,
              is_active: true,
            },
          });

          if (session) {
            const original = session.toJSON();
            session.is_active = false;
            session.revoked_at = new Date();
            session.revoked_reason = 'LOGOUT';
            await session.save();
            const clientIp = getClientIp(req);
            await logAudit(
              decoded.id,
              'SESSION_LOGOUT',
              original,
              session.toJSON(),
              clientIp || undefined
            );
            const revokedAt = session.revoked_at
              ? session.revoked_at.toISOString()
              : new Date().toISOString();
            broadcastSessionRevoked(decoded.id, {
              sessionId: session.id,
              deviceId: session.device_id,
              jwtId: session.jwt_id || null,
              reason: session.revoked_reason || null,
              revokedAt,
            });
          }
        }
      } catch (e) {
      }
    }

    res.clearCookie('_T');
    sendSuccess(res, 'Code216'); // Logged out successfully
  } catch (error) {
    console.error('Logout error:', error);
    sendError(res, 'Code217', 500); // Error logging out
  }
};

export const getMySessions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      sendError(res, 'Code206', 401); // Not authenticated
      return;
    }

    // Check if user is Super Admin
    const user = await User.findByPk(userId, {
      include: [{ model: Role, through: { attributes: [] }, required: false }],
    } as any);

    const roles = ((user as any)?.Roles || []) as any[];
    const isSuperAdmin =
      Boolean(req.user?.is_super_admin) ||
      roles.some((r) => String(r?.name).toLowerCase() === 'super admin');
    const isOperator = roles.some((r) => String(r?.name).toLowerCase() === 'operator');

    const requesterTenantId = (user as any)?.tenant_id ?? null;
    let allowedUserIds: number[] | null = [userId];
    if (isSuperAdmin) {
      allowedUserIds = null;
    } else if (isOperator && requesterTenantId) {
      const tenantUsers = await User.findAll({
        where: { tenant_id: requesterTenantId } as any,
        attributes: ['id'],
      } as any);
      allowedUserIds = (tenantUsers as any[]).map((u) => Number(u.id)).filter((id) => Number.isFinite(id));
      if (allowedUserIds.length === 0) {
        allowedUserIds = [userId];
      }
    }

    // We want to return user+device combinations, not aggregated by device
    // 1. Find all active sessions for this user (or all users if Super Admin)
    const sessionWhere =
      allowedUserIds === null
        ? { is_active: true }
        : { user_id: { [Op.in]: allowedUserIds }, is_active: true };
    const activeSessions = await UserSession.findAll({
      where: sessionWhere,
      order: [['createdAt', 'DESC']],
    });

    // 2. Find all locks for this user (or all users if Super Admin)
    const lockWhere =
      allowedUserIds === null
        ? {}
        : { user_id: { [Op.in]: allowedUserIds } };
    const userLocks = await UserDeviceLock.findAll({
      where: lockWhere
    });

    // 3. Collect user+device combinations from both active sessions and locks
    const userDeviceSet = new Set<string>();
    for (const s of activeSessions) {
      userDeviceSet.add(`${s.user_id}:${s.device_id}`);
    }
    for (const l of userLocks) {
      userDeviceSet.add(`${l.user_id}:${l.device_id}`);
    }

    if (userDeviceSet.size === 0) {
      sendSuccess(res, 'Code1', []);
      return;
    }

    // 4. Get user information for all users involved
    const userIds = new Set<number>();
    const deviceIds = new Set<string>();
    
    for (const userDeviceKey of userDeviceSet) {
      const [uid, deviceId] = userDeviceKey.split(':');
      userIds.add(Number(uid));
      deviceIds.add(deviceId);
    }

    const users = await User.findAll({
      where: { id: { [Op.in]: Array.from(userIds) } },
      attributes: ['id', 'username', 'full_name', 'tenant_id'],
      include: [{ model: Tenant, attributes: ['id', 'prefix', 'name'], required: false }],
    });

    const userMap = new Map<number, typeof users[number]>();
    for (const u of users) {
      userMap.set(u.id, u);
    }

    // 5. Get the latest session info for each user+device combination
    const allRelevantSessions = await UserSession.findAll({
      where: {
        [Op.and]: [
          { user_id: { [Op.in]: Array.from(userIds) } },
          { device_id: { [Op.in]: Array.from(deviceIds) } },
        ],
      },
      order: [['createdAt', 'DESC']],
    });

    // Map to find the best session for each user+device combination
    const userDeviceBestSession = new Map<string, typeof allRelevantSessions[number]>();
    
    for (const s of allRelevantSessions) {
      const key = `${s.user_id}:${s.device_id}`;
      if (!userDeviceBestSession.has(key)) {
        userDeviceBestSession.set(key, s);
      } else {
        const currentBest = userDeviceBestSession.get(key)!;
        // Prefer active sessions
        if (!currentBest.is_active && s.is_active) {
          userDeviceBestSession.set(key, s);
        }
        // If both have same active state, prefer more recent
        else if (currentBest.is_active === s.is_active) {
          const currentTime = currentBest.createdAt instanceof Date ? currentBest.createdAt.getTime() : new Date(currentBest.createdAt).getTime();
          const newTime = s.createdAt instanceof Date ? s.createdAt.getTime() : new Date(s.createdAt).getTime();
          if (newTime > currentTime) {
            userDeviceBestSession.set(key, s);
          }
        }
      }
    }

    // 6. Get all locks for these user+device combinations
    const locks = await UserDeviceLock.findAll({
      where: {
        [Op.and]: [
          { user_id: { [Op.in]: Array.from(userIds) } },
          { device_id: { [Op.in]: Array.from(deviceIds) } }
        ]
      },
    });

    const lockedUserDevices = new Set<string>();
    for (const lock of locks) {
      lockedUserDevices.add(`${lock.user_id}:${lock.device_id}`);
    }

    // 7. Build Result - each record represents a user on a device
    const result = [];
    for (const userDeviceKey of userDeviceSet) {
      const [uid, deviceId] = userDeviceKey.split(':');
      const userId = Number(uid);
      const session = userDeviceBestSession.get(userDeviceKey);
      
      const userInfo = userMap.get(userId);
      if (!userInfo) continue; // Skip if user not found

      const isLocked = lockedUserDevices.has(userDeviceKey);
      const isActive = session?.is_active || false;

      // Only show if active or locked (or both)
      if (!isActive && !isLocked) {
        continue;
      }

      result.push({
        id: session?.id || 0, // Use 0 for lock-only records, frontend will handle
        user_id: userId,
        username: userInfo.username,
        tenant_id: (userInfo as any).tenant_id ?? null,
        tenant_name: (userInfo as any).Tenant?.name ?? null,
        tenant_prefix: (userInfo as any).Tenant?.prefix ?? null,
        device_id: deviceId,
        device_name: session ? deriveDeviceNameFromUserAgent(session.user_agent) : 'Unknown Device',
        user_agent: session?.user_agent || null,
        ip_address: session?.ip_address || null,
        is_active: isActive,
        is_locked: isLocked,
        locked_by_self: isLocked && userId === req.user?.id,
        revoked_at: session?.revoked_at || null,
        revoked_reason: session?.revoked_reason || null,
        createdAt: session?.createdAt || new Date().toISOString(),
        updatedAt: session?.updatedAt || new Date().toISOString(),
        last_active_at: session?.last_active_at || null,
        fullname: userInfo.full_name || userInfo.username,
        is_self: userId === req.user?.id,
      });
    }

    // Sort: Active first, then by creation date (newest first)
    result.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });

    sendSuccess(res, 'Code1', result);
  } catch (error) {
    console.error('getMySessions error:', error);
    sendError(res, 'Code226', 500); // Error fetching sessions
  }
};

export const revokeMySession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      sendError(res, 'Code206', 401); // Not authenticated
      return;
    }
    const { id } = req.params;
    const sessionId = Number(id);
    if (!sessionId || Number.isNaN(sessionId)) {
      sendError(res, 'Code222', 400); // Invalid session id
      return;
    }

    const session = await UserSession.findOne({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      sendError(res, 'Code223', 404); // Session not found
      return;
    }

    const isSuperAdmin = Boolean(req.user?.is_super_admin);

    // Check if user has access to this device (owns a session with same device_id) or is Super Admin
    const hasAccessDevice = isSuperAdmin || await UserSession.findOne({
      where: {
        user_id: userId,
        device_id: session.device_id,
      },
    });

    if (!hasAccessDevice) {
      sendError(res, 'Code224', 403); // Not allowed to revoke this session
      return;
    }

    if (!session.is_active && session.revoked_at) {
      sendSuccess(res, 'Code1', session);
      return;
    }

    const original = session.toJSON();
    session.is_active = false;
    session.revoked_at = new Date();
    session.revoked_reason = 'MANUAL_TERMINATION';
    await session.save();

    const clientIp = getClientIp(req as any);
    await logAudit(
      userId,
      'SESSION_FORCE_LOGOUT',
      original,
      session.toJSON(),
      clientIp || undefined
    );

    const revokedAt = session.revoked_at
      ? session.revoked_at.toISOString()
      : new Date().toISOString();
    broadcastSessionRevoked(session.user_id, {
      sessionId: session.id,
      deviceId: session.device_id,
      jwtId: session.jwt_id || null,
      reason: session.revoked_reason || null,
      revokedAt,
    });

    sendSuccess(res, 'Code1', session);
  } catch (error) {
    console.error('revokeMySession error:', error);
    sendError(res, 'Code225', 500); // Error revoking session
  }
};

export const lockDeviceFingerprint = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      sendError(res, 'Code206', 401); // Not authenticated
      return;
    }
    const { id } = req.params;
    const sessionId = Number(id);
    
    // Handle both old session ID format and new user+device format
    let targetUserId: number;
    let deviceId: string;
    
    if (sessionId && sessionId > 0) {
      // Legacy format: find session by ID
      const session = await UserSession.findOne({
        where: { id: sessionId },
      });

      if (!session) {
        sendError(res, 'Code223', 404); // Session not found
        return;
      }

      targetUserId = session.user_id;
      deviceId = session.device_id;
    } else {
      // New format: expect user_id and device_id in request body
      const { user_id: bodyUserId, device_id: bodyDeviceId } = req.body;
      if (!bodyUserId || !bodyDeviceId) {
        sendError(res, 'Code227', 400); // user_id and device_id are required
        return;
      }
      targetUserId = Number(bodyUserId);
      deviceId = String(bodyDeviceId);
    }

    const isSuperAdmin = Boolean(req.user?.is_super_admin);

    // Check if user has access to this device (owns a session with same device_id) or is Super Admin
    const hasAccessDevice = isSuperAdmin || await UserSession.findOne({
      where: {
        user_id: userId,
        device_id: deviceId,
      },
    });

    if (!hasAccessDevice) {
      sendError(res, 'Code228', 403); // Not allowed to lock this device
      return;
    }

    const existingLock = await UserDeviceLock.findOne({
      where: {
        user_id: targetUserId,
        device_id: deviceId,
      },
    });

    if (existingLock) {
      sendSuccess(res, 'Code1', { success: true });
      return;
    }

    const t = await sequelize.transaction();
    const revokedSessions: any[] = [];

    try {
      await UserDeviceLock.create(
        {
          user_id: targetUserId,
          device_id: deviceId,
          locked_by: userId,
          reason: null,
        },
        { transaction: t }
      );

      const activeSessions = await UserSession.findAll({
        where: {
          user_id: targetUserId,
          device_id: deviceId,
          is_active: true,
        },
        transaction: t,
        lock: t.LOCK.UPDATE as any,
      });

      for (const s of activeSessions) {
        const original = s.toJSON();
        s.is_active = false;
        s.revoked_at = new Date();
        s.revoked_reason = 'DEVICE_LOCKED';
        await s.save({ transaction: t });
        revokedSessions.push({ original, updated: s.toJSON() });
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    const clientIp = getClientIp(req as any);

    await logAudit(
      userId,
      'DEVICE_FINGERPRINT_LOCKED',
      {
        targetUserId: targetUserId,
        deviceId: deviceId,
      },
      null,
      clientIp || undefined
    );

    for (const entry of revokedSessions) {
      const updated: any = entry.updated;
      const revokedAt =
        updated.revoked_at instanceof Date
          ? updated.revoked_at.toISOString()
          : new Date().toISOString();
      broadcastSessionRevoked(updated.user_id, {
        sessionId: updated.id,
        deviceId: updated.device_id,
        jwtId: updated.jwt_id || null,
        reason: updated.revoked_reason || null,
        revokedAt,
      });
    }

    sendSuccess(res, 'Code1', { success: true });
  } catch (error) {
    console.error('lockDeviceFingerprint error:', error);
    sendError(res, 'Code229', 500); // Error locking device
  }
};

export const unlockDeviceFingerprint = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      sendError(res, 'Code206', 401); // Not authenticated
      return;
    }
    const { id } = req.params;
    const sessionId = Number(id);
    
    // Handle both old session ID format and new user+device format
    let targetUserId: number;
    let deviceId: string;
    
    if (sessionId && sessionId > 0) {
      // Legacy format: find session by ID
      const session = await UserSession.findOne({
        where: { id: sessionId },
      });

      if (!session) {
        sendError(res, 'Code223', 404); // Session not found
        return;
      }

      targetUserId = session.user_id;
      deviceId = session.device_id;
    } else {
      // New format: expect user_id and device_id in request body
      const { user_id: bodyUserId, device_id: bodyDeviceId } = req.body;
      if (!bodyUserId || !bodyDeviceId) {
        sendError(res, 'Code227', 400); // user_id and device_id are required
        return;
      }
      targetUserId = Number(bodyUserId);
      deviceId = String(bodyDeviceId);
    }

    const isSuperAdmin = Boolean(req.user?.is_super_admin);

    // Check if user has access to this device (owns a session with same device_id) or is Super Admin
    const hasAccessDevice = isSuperAdmin || await UserSession.findOne({
      where: {
        user_id: userId,
        device_id: deviceId,
      },
    });

    if (!hasAccessDevice) {
      sendError(res, 'Code228', 403); // Not allowed to unlock this device
      return;
    }

    const deletedCount = await UserDeviceLock.destroy({
      where: {
        user_id: targetUserId,
        device_id: deviceId,
      },
    });

    const clientIp = getClientIp(req as any);

    await logAudit(
      userId,
      'DEVICE_FINGERPRINT_UNLOCKED',
      {
        targetUserId: targetUserId,
        deviceId: deviceId,
        deletedCount,
      },
      null,
      clientIp || undefined
    );

    sendSuccess(res, 'Code1', { success: true });
  } catch (error) {
    console.error('unlockDeviceFingerprint error:', error);
    sendError(res, 'Code230', 500); // Error unlocking device
  }
};

export const getUs = async (req: any, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      sendError(res, 'Code206', 401); // Not authenticated
      return;
    }

    const user: any = await User.findByPk(userId, {
      include: [
        Permission,
        {
          model: Role,
          include: [Permission]
        },
        {
          model: Tenant,
          attributes: ['id', 'prefix', 'name'],
          required: false,
        },
        {
          model: SubBrand,
          attributes: ['id', 'tenant_id', 'code', 'name', 'status'],
          required: false,
        },
      ]
    });

    if (!user) {
      sendError(res, 'Code200', 404); // User not found
      return;
    }

    const maintenanceSettings = await getMaintenanceGateSettings();
    if (maintenanceSettings.maintenance_mode) {
      const roleNames = Array.isArray(user.Roles) ? user.Roles.map((r: any) => String(r?.name ?? '')).filter(Boolean) : [];
      if (!isAllowedDuringMaintenance(maintenanceSettings, roleNames)) {
        denyMaintenance(res, maintenanceSettings);
        return;
      }
    }

    const safeName = user.full_name || user.username;

    const effectiveTenantIdRaw = req.user?.tenant_id ?? user.tenant_id ?? null;
    const effectiveTenantId = Number(effectiveTenantIdRaw);
    const scopedTenantId =
      Number.isFinite(effectiveTenantId) && effectiveTenantId > 0 ? effectiveTenantId : null;

    const slugSet = new Set<string>();
    if (Array.isArray(user.Permissions)) {
      for (const p of user.Permissions as any[]) {
        const slug = typeof p?.slug === 'string' ? p.slug : '';
        if (slug) slugSet.add(slug);
      }
    }
    if (Array.isArray(user.Roles)) {
      for (const role of user.Roles as any[]) {
        const roleNameLower = String(role?.name ?? '').toLowerCase();
        const roleTenantIdRaw = role?.tenant_id ?? null;
        const roleTenantIdNum = roleTenantIdRaw != null ? Number(roleTenantIdRaw) : NaN;
        const roleTenantId =
          Number.isFinite(roleTenantIdNum) && roleTenantIdNum > 0 ? roleTenantIdNum : null;

        const allowRole =
          (roleTenantId != null && scopedTenantId != null && roleTenantId === scopedTenantId) ||
          (roleTenantId == null && roleNameLower === 'super admin');
        if (!allowRole) continue;

        if (Array.isArray(role?.Permissions)) {
          for (const p of role.Permissions as any[]) {
            const slug = typeof p?.slug === 'string' ? p.slug : '';
            if (slug) slugSet.add(slug);
          }
        }
      }
    }

    const slugs =
      slugSet.size > 0
        ? Array.from(slugSet).sort()
        : Array.isArray(req.user?.permissions)
          ? ((req.user.permissions as any[])
              .map((x) => String(x ?? '').trim())
              .filter((x) => x.length > 0) as string[])
          : [];
    const permissionCodes = slugs.map((slug) => encodePermissionSlug(slug));

    // Send the API Key as stored in DB (encrypted). 
    // The frontend treats it as an opaque token.
    // The backend validates it by comparing the encrypted strings directly.

    sendSuccess(res, 'Code1', {
      id: user.id,
      name: safeName,
      status: user.status,
      currency: user.currency,
      roles: user.Roles ? user.Roles.map((r: any) => r.name) : [],
      permissions: permissionCodes,
      tenant_id: user.tenant_id ?? null,
      tenant_name: user.Tenant?.name ?? null,
      tenant_prefix: user.Tenant?.prefix ?? null,
      sub_brand_id: user.sub_brand_id ?? null,
      sub_brand_name: user.SubBrand?.name ?? null,
      sub_brand_code: user.SubBrand?.code ?? null,
      is_super_admin: Boolean(req.user?.is_super_admin),
      ap: user.api_key || null
    });
  } catch (error) {
    console.error('GetUs error:', error);
    sendError(res, 'Code2', 500); // Internal server error
  }
};

export const sessionEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    let token = req.cookies?._T || (req.query.token as string);
    if (!token) {
      sendError(res, 'Code218', 401); // Missing token
      return;
    }

    if (isEncrypted(token)) {
      token = decrypt(token);
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token as string, secret);
    } catch (e) {
      sendError(res, 'Code208', 401); // Invalid or expired token
      return;
    }

    const userId = decoded.id as number | undefined;
    const jti = decoded.jti as string | undefined;
    if (!userId || !jti) {
      sendError(res, 'Code219', 401); // Invalid token payload
      return;
    }

    const session = await UserSession.findOne({
      where: {
        user_id: userId,
        jwt_id: jti,
        is_active: true,
      },
    });

    if (!session || session.revoked_at) {
      sendError(res, 'Code220', 401); // Session is not active
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if ((res as any).flushHeaders) {
      (res as any).flushHeaders();
    } else {
      res.write('\n');
    }

    addSseClient(userId, res);

    const heartbeat = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ jti })}\n\n`);

    const onClose = () => {
      clearInterval(heartbeat);
      removeSseClient(userId, res);
      res.end();
    };

    req.on('close', onClose);
    req.on('end', onClose);
  } catch (error) {
    console.error('sessionEvents error:', error);
    try {
      sendError(res, 'Code221', 500); // Error establishing session events stream
    } catch {
    }
  }
};
