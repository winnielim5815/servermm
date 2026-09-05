import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'path';
import routes from './routes';
import sequelize from './config/database';
import { checkMaintenanceMode } from './middleware/maintenance';
import { trackLandingEventGif, trackLandingPageViewGif } from './controllers/LandingTrackingController';
import { generalRateLimit, authRateLimit, uploadRateLimit, trackingRateLimit } from './middleware/rateLimit';
import { productionErrorHandler, notFoundHandler, setupGlobalErrorHandlers } from './middleware/errorHandler';
import { requireAppSignature } from './middleware/appSignature';
import { ensureGameLogStorage, startGameLogSyncScheduler } from './services/GameLogSyncService';

dotenv.config();

const app = express();
const PORT = 5000;

const exactOrigins = new Set<string>(
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const allowedDomains = new Set<string>(
  (process.env.CORS_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const allowAny =
  String(process.env.CORS_ALLOW_ANY || '').trim().toLowerCase() === 'true';

const isAllowedOrigin = (origin: string) => {
  if (allowAny) return true;
  if (exactOrigins.has(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    for (const d of allowedDomains) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
  } catch {
    return false;
  }

  return false;
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(compression());
app.use('/lp', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Timing-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.options(/.*/, cors(corsOptions));
app.use(cookieParser());
app.use(express.text({ type: 'text/plain', limit: '5mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(express.json({ limit: '5mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

// Trust proxy for rate limiting behind proxies (like Nginx, Cloudflare, or local dev proxy)
app.set('trust proxy', 1);

app.use(checkMaintenanceMode);

// 营销页面跟踪速率限制（非常宽松）
app.use('/lp', trackingRateLimit);
app.get('/lp/pv.gif', trackLandingPageViewGif);
app.get('/lp/event.gif', trackLandingEventGif);
app.post('/lp/pv.gif', trackLandingPageViewGif);
app.post('/lp/event.gif', trackLandingEventGif);

// API通用速率限制
app.use('/api', generalRateLimit);
app.use('/api', requireAppSignature);
app.use('/api', routes);

// 404处理 - 必须在所有路由之后
app.use(notFoundHandler);

// 全局错误处理 - 必须在最后
app.use(productionErrorHandler);

app.get('/', (req, res) => {
  res.status(403).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>403 - Forbidden: Access is denied</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          background-color: #09090b;
          color: #e4e4e7;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
        }
        .container {
          text-align: center;
          padding: 2rem;
          border: 1px solid #27272a;
          border-radius: 0.5rem;
          background-color: #18181b;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
          max-width: 400px;
          width: 90%;
        }
        .icon {
          color: #ef4444;
          margin-bottom: 1rem;
        }
        h1 {
          font-size: 1.5rem;
          font-weight: 600;
          margin-bottom: 0.5rem;
          color: #fff;
        }
        p {
          color: #a1a1aa;
          font-size: 0.875rem;
          line-height: 1.5;
        }
        .footer {
          margin-top: 1.5rem;
          font-size: 0.75rem;
          color: #52525b;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h1>403 - Forbidden: Access is denied</h1>
        <p>You do not have permission to view this directory or page using the credentials that you supplied. </p>
        <div class="footer">
          Warning: All activities are monitored and logged.
        </div>
      </div>
    </body>
    </html>
  `);
});

const startServer = async () => {
  try {
    // 设置全局错误处理
    setupGlobalErrorHandlers();
    
    await sequelize.authenticate();
    await ensureGameLogStorage();
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`🚀 Server running...`);
      startGameLogSyncScheduler();
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

export default app;
