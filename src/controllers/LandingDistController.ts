import { Response } from 'express';
import { ZipArchive } from 'archiver';
import { LandingPage } from '../models';
import { AuthRequest } from '../middleware/auth';
import { sendError } from '../utils/response';
import { getTenancyScopeOrThrow, withTenancyWhere } from '../tenancy/scope';

const getTrackingBaseUrl = (req: AuthRequest): string => {
  const raw = (process.env.LANDING_TRACK_BASE_URL || '').trim();
  if (raw.length > 0) {
    return raw.replace(/\/+$/, '');
  }
  const host = (req as any).get ? (req as any).get('host') : '';
  const proto = (req as any).protocol || 'http';
  if (typeof host === 'string' && host.trim().length > 0) {
    return `${proto}://${host.trim()}`.replace(/\/+$/, '');
  }
  return '';
};

const safeInlineJson = (json: string) => {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
};

const safeHtmlText = (value: any, fallback: string) => {
  const s = typeof value === 'string' ? value.trim() : '';
  const raw = s.length > 0 ? s : fallback;
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const renderIndexHtml = (configJson: string, titleText: string) => {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <title>${titleText}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
    <link rel="stylesheet" href="./assets/style.css" />
  </head>
  <body>
    <main class="container">
      <div id="hero" class="hero" style="display:none">
        <img id="hero-img" alt="" />
      </div>

      <section class="card">
        <h1 class="title" id="lp-title"></h1>
        <p class="subtitle" id="lp-subtitle"></p>
        <div class="cta">
          <a id="primary-cta" class="btn" href="#" rel="noreferrer" style="display:none"></a>
          <a id="secondary-cta" class="btn btn-secondary" href="#" rel="noreferrer" style="display:none"></a>
        </div>
      </section>
    </main>
    <script>window.__LP_CONFIG__=${configJson};</script>
    <script src="./assets/app.js"></script>
  </body>
</html>`;
};

const renderStyleCss = () => {
  return `/* 基础重置 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

/* 锁定视口，防止出现滚动条 */
html, body {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background-color: #000;
  font-family: "Inter", -apple-system, sans-serif;
}

/* 布局容器：强制占据 100% 物理屏幕宽高 */
.container {
  position: relative;
  width: 100vw;
  /* 使用 dvh 确保在移动端浏览器弹出地址栏时依然全屏 */
  height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  overflow: hidden;
}

/* 背景图片容器 */
.hero {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
}

.hero img {
  /* 强制图片宽高 100% 填满容器 */
  width: 100%;
  height: 100%;
  /* 核心修改：使用 fill 确保图片像右图那样 100% 还原并全屏，不留任何黑边 */
  object-fit: fill;
  /* 移除缩放动画，因为全屏锁定下缩放会产生黑边或裁切 */
  animation: none;
  filter: brightness(0.8);
}

/* 底部内容卡片区 */
.card {
  position: relative;
  z-index: 2;
  width: 100%;
  /* 增加底部安全区距离，确保按钮在 iPhone 底部横条上方 */
  padding: 40px 24px calc(20px + env(safe-area-inset-bottom));
  text-align: center;
  /* 阴影遮罩，确保文字在复杂的背景图上依然清晰 */
  background: linear-gradient(to top,
    rgba(0,0,0,0.85) 0%,
    rgba(0,0,0,0.4) 60%,
    transparent 100%);
}

/* 文字排版 */
.title {
  font-size: clamp(1.6rem, 8vw, 3rem);
  font-weight: 800;
  color: #fff;
  line-height: 1.1;
  margin-bottom: 8px;
  text-shadow: 0 4px 12px rgba(0,0,0,0.6);
}

.subtitle {
  font-size: clamp(0.9rem, 4vw, 1.1rem);
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 24px;
}

/* 按钮样式 */
.cta {
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60px;
  width: 100%;
  border-radius: 16px;
  text-decoration: none;
  font-weight: 700;
  font-size: 1.1rem;
  transition: transform 0.2s cubic-bezier(0.2, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
  margin-bottom: 12px;
}

#primary-cta {
  background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
  color: #ffffff;
  box-shadow: 0 8px 20px rgba(99, 102, 241, 0.3);
}

/* 扫光动画 */
.btn::after {
  content: "";
  position: absolute;
  top: 0;
  left: -150%;
  width: 50%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
  animation: sweep 4s infinite linear;
}

@keyframes sweep {
  0% { left: -150%; }
  50% { left: 150%; }
  100% { left: 150%; }
}

.btn:active {
  transform: scale(0.96);
}`;
};

const renderAppJs = () => {
  return `(function(){
  var cfg = window.__LP_CONFIG__ || {};
  var trackBase = String(cfg.trackBase || '').replace(/\\/+$/,'');
  var lp = String(cfg.landingPageId || '');
  var theme = String(cfg.theme || 'auto');
  if(theme === 'light'){ document.documentElement.classList.add('theme-light'); }
  if(theme === 'dark'){ document.documentElement.classList.add('theme-dark'); }
  var title = document.getElementById('lp-title');
  var subtitle = document.getElementById('lp-subtitle');
  if(title && (cfg.title || cfg.name)){ title.textContent = String(cfg.title || cfg.name); }
  if(subtitle && cfg.subtitle){ subtitle.textContent = String(cfg.subtitle); }

  var hero = document.getElementById('hero');
  var heroImg = document.getElementById('hero-img');
  if(hero && heroImg && cfg.heroImageUrl){
    hero.style.display = '';
    heroImg.src = String(cfg.heroImageUrl);
    heroImg.alt = String(cfg.title || cfg.name || '');
  }

  function getOrCreateSid(){
    try{
      var key = 'lp_sid';
      
      // Enhanced iOS 14+ detection 
      var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent); 
      var isIOS14OrHigher = false; 
      var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent); 
      
      if (isIOS) { 
        try { 
          var match = navigator.userAgent.match(/OS (\\d+)_(\\d+)/); 
          if (match && parseInt(match[1]) >= 14) { 
            isIOS14OrHigher = true; 
          } 
        } catch(e) {} 
      } 
      
      // iOS 14+ Safari: Prioritize sessionStorage over localStorage (ITP compatibility) 
      if (isIOS14OrHigher && isSafari) { 
        try { 
          var v = sessionStorage.getItem(key); 
          if(v){ return v; } 
        } catch(e) {} 
        
        try { 
          v = localStorage.getItem(key); 
          if(v){ return v; } 
        } catch(e) {} 
      } else { 
        // Non-iOS 14+: Standard localStorage first 
        try { 
          var v = localStorage.getItem(key); 
          if(v){ return v; } 
        } catch(e) {} 
        
        try { 
          v = sessionStorage.getItem(key); 
          if(v){ return v; } 
        } catch(e) {} 
      } 
      
      // Fallback to first-party cookie with enhanced iOS 14+ compatibility 
      try { 
        var cookies = document.cookie.split(';'); 
        for(var i = 0; i < cookies.length; i++) { 
          var cookie = cookies[i].trim(); 
          if(cookie.indexOf(key + '=') === 0) { 
            return cookie.substring(key.length + 1); 
          } 
        } 
      } catch(e) {} 
      
      // Generate new session ID with enhanced entropy 
      var sid; 
      if (crypto && crypto.randomUUID) { 
        sid = crypto.randomUUID(); 
      } else if (crypto && crypto.getRandomValues) { 
        var array = new Uint8Array(16); 
        crypto.getRandomValues(array); 
        sid = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join(''); 
      } else { 
        sid = Date.now().toString(16) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2); 
      } 
      
      // Store in all available storage methods with iOS 14+ considerations 
      var storageSuccess = { localStorage: false, sessionStorage: false, cookie: false }; 
      
      // localStorage with quota management 
      try { 
        localStorage.setItem(key, sid); 
        storageSuccess.localStorage = true; 
      } catch(e) { 
        // Handle quota exceeded 
        try { 
          // Clear old tracking data if quota is full 
          var keysToRemove = []; 
          for (var i = 0; i < localStorage.length; i++) { 
            var lsKey = localStorage.key(i); 
            if (lsKey && lsKey.startsWith('lp_') && lsKey !== key) { 
              keysToRemove.push(lsKey); 
            } 
          } 
          keysToRemove.forEach(function(k) { localStorage.removeItem(k); }); 
          localStorage.setItem(key, sid); 
          storageSuccess.localStorage = true; 
        } catch(e2) {} 
      } 
      
      // sessionStorage 
      try { 
        sessionStorage.setItem(key, sid); 
        storageSuccess.sessionStorage = true; 
      } catch(e) {} 
      
      // Enhanced cookie setting for iOS 14+ compatibility 
      try { 
        var expires = new Date(); 
        expires.setFullYear(expires.getFullYear() + 1); 
        var cookieString = key + '=' + sid + '; expires=' + expires.toUTCString() + '; path=/; SameSite=Lax'; 
        
        // Add secure flag for HTTPS 
        if (location.protocol === 'https:') { 
          cookieString += '; Secure'; 
        } 
        
        // iOS 14+ Safari: Avoid domain attribute to prevent third-party cookie classification 
        // Only set domain for non-Safari browsers or when not on iOS 14+ 
        if (!isIOS14OrHigher || !isSafari) { 
          if (location.hostname.indexOf('.') > -1) { 
            var domainParts = location.hostname.split('.'); 
            if (domainParts.length > 2) { 
              cookieString += '; domain=.' + domainParts.slice(-2).join('.'); 
            } else { 
              cookieString += '; domain=.' + location.hostname; 
            } 
          } 
        } 
        
        document.cookie = cookieString; 
        
        // Verify cookie was set successfully 
        var testCookie = document.cookie.split(';').find(function(c) { 
          return c.trim().indexOf(key + '=') === 0; 
        }); 
        storageSuccess.cookie = !!testCookie; 
        
      } catch(e) {} 
      
      // Store success metrics for debugging 
      try { 
        var metrics = { 
          timestamp: Date.now(), 
          isIOS14OrHigher: isIOS14OrHigher, 
          isSafari: isSafari, 
          storageSuccess: storageSuccess, 
          userAgent: navigator.userAgent.slice(0, 100) 
        }; 
        sessionStorage.setItem('lp_sid_metrics', JSON.stringify(metrics)); 
      } catch(e) {} 
      
      return sid; 
    }catch(e){ 
      // Ultimate fallback 
      return 'fallback_' + Date.now().toString(16) + Math.random().toString(16).slice(2); 
    } 
  }

  function qs(){
    var p = new URLSearchParams(location.search);
    var keep = ['utm_source','utm_campaign','utm_medium','utm_content','utm_term','fbclid'];
    var out = new URLSearchParams();
    keep.forEach(function(k){
      var v = p.get(k);
      if(v){ out.set(k, v); }
    });
    return out.toString();
  }

  function img(url){
    try{
      var i = new Image();
      i.referrerPolicy = 'strict-origin-when-cross-origin';
      
      // iOS 14+ compatibility: Add load and error handlers 
      i.onload = function() { 
        // Tracking pixel loaded successfully 
      }; 
      i.onerror = function() { 
        // Fallback: try with different referrer policy for iOS 14+ 
        try { 
          var fallbackImg = new Image(); 
          fallbackImg.referrerPolicy = 'no-referrer-when-downgrade'; 
          fallbackImg.src = url; 
        } catch(e) {} 
      }; 
      
      i.src = url; 
    }catch(e){}
  }

  function track(kind, ev, el){
    if(!trackBase || !lp){ return; }
    var sid = encodeURIComponent(getOrCreateSid());
    var u = encodeURIComponent(location.href);
    var r = encodeURIComponent(document.referrer || '');
    var q = qs();
    
    // Use production tracking endpoints 
    var base = trackBase + (kind === 'pv' ? '/lp/pv.gif' : '/lp/event.gif'); 
    
    var tz = '';
    try{ tz = String((new Date()).getTimezoneOffset()); }catch(e){}
    var lang = '';
    try{ lang = String(navigator.language || ''); }catch(e){}
    var sc = '';
    try{ sc = String(window.screen && window.screen.width ? (window.screen.width + 'x' + window.screen.height) : ''); }catch(e){}
    
    // Enhanced iOS 14+ detection and compatibility 
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent); 
    var isIOS14OrHigher = false; 
    var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent); 
    var isPrivateMode = false; 
    
    if (isIOS) { 
      try { 
        var match = navigator.userAgent.match(/OS (\\d+)_(\\d+)/); 
        if (match && parseInt(match[1]) >= 14) { 
          isIOS14OrHigher = true; 
        } 
      } catch(e) {} 
    } 
    
    // Detect private browsing mode 
    try { 
      if (typeof localStorage !== 'undefined') { 
        localStorage.setItem('private_test', 'test'); 
        localStorage.removeItem('private_test'); 
      } 
    } catch(e) { 
      isPrivateMode = true; 
    } 
    
    var url = base + '?lp=' + encodeURIComponent(lp) + '&sid=' + sid + '&u=' + u + '&r=' + r; 
    if(tz){ url += '&tz=' + encodeURIComponent(tz); }
    if(lang){ url += '&lang=' + encodeURIComponent(lang); }
    if(sc){ url += '&sc=' + encodeURIComponent(sc); }
    if(q){ url += '&' + q; }
    if(kind !== 'pv'){
      url += '&ev=' + encodeURIComponent(ev || 'event');
      if(el){ url += '&el=' + encodeURIComponent(el); }
    }
    
    // Add enhanced iOS 14+ and compatibility parameters 
    if (isIOS14OrHigher) { 
      url += '&ios14=1'; 
      url += '&safari=' + (isSafari ? '1' : '0'); 
      url += '&private=' + (isPrivateMode ? '1' : '0'); 
      url += '&ts=' + Date.now(); 
    } 
    
    // Add storage success metrics 
    try { 
      var metrics = sessionStorage.getItem('lp_sid_metrics'); 
      if (metrics) { 
        var parsed = JSON.parse(metrics); 
        url += '&ls=' + (parsed.storageSuccess.localStorage ? '1' : '0'); 
        url += '&ss=' + (parsed.storageSuccess.sessionStorage ? '1' : '0'); 
        url += '&ck=' + (parsed.storageSuccess.cookie ? '1' : '0'); 
      } 
    } catch(e) {} 
    
    // Enhanced tracking methods for iOS 14+ 
    var trackingAttempts = []; 
    
    // Method 1: Standard image pixel (always try first) 
    try { 
      img(url); 
      trackingAttempts.push('image'); 
    } catch(e) { 
      trackingAttempts.push('image_failed'); 
    } 
    
    // Method 2: Send Beacon (iOS 14+ compatible) 
    if (navigator.sendBeacon && (isIOS14OrHigher || kind !== 'pv')) { 
      try { 
        var beaconData = url.split('?').slice(1).join('?'); 
        var beaconUrl = url.split('?')[0]; 
        var success = navigator.sendBeacon(beaconUrl + '?' + beaconData); 
        if (success) { 
          trackingAttempts.push('beacon'); 
        } else { 
          trackingAttempts.push('beacon_failed'); 
        } 
      } catch(e) { 
        trackingAttempts.push('beacon_error'); 
      } 
    } 
    
    // Method 3: Fetch with keepalive (iOS 14+ fallback) 
    if (isIOS14OrHigher && kind !== 'pv' && window.fetch) { 
      try { 
        fetch(url, { 
          method: 'GET', 
          mode: 'no-cors', 
          cache: 'no-cache', 
          keepalive: true, 
          priority: 'low' 
        }).then(function() { 
          trackingAttempts.push('fetch_success'); 
        }).catch(function() { 
          trackingAttempts.push('fetch_failed'); 
        }); 
      } catch(e) { 
        trackingAttempts.push('fetch_error'); 
      } 
    } 
    
    // Method 4: XHR fallback for critical events 
    if (isIOS14OrHigher && kind !== 'pv' && window.XMLHttpRequest) { 
      try { 
        var xhr = new XMLHttpRequest(); 
        xhr.open('GET', url, true); 
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); 
        xhr.withCredentials = false; // Important for iOS 14+ 
        xhr.timeout = 3000; 
        xhr.send(); 
        trackingAttempts.push('xhr'); 
      } catch(e) { 
        trackingAttempts.push('xhr_error'); 
      } 
    } 
    
    // Log tracking attempts for debugging 
    try { 
      var trackingLog = { 
        timestamp: Date.now(), 
        kind: kind, 
        attempts: trackingAttempts, 
        isIOS14OrHigher: isIOS14OrHigher, 
        isSafari: isSafari, 
        isPrivateMode: isPrivateMode 
      }; 
      var existingLog = JSON.parse(sessionStorage.getItem('lp_tracking_log') || '[]'); 
      existingLog.push(trackingLog); 
      // Keep only last 10 entries 
      if (existingLog.length > 10) { 
        existingLog = existingLog.slice(-10); 
      } 
      sessionStorage.setItem('lp_tracking_log', JSON.stringify(existingLog)); 
    } catch(e) {} 
  }

  track('pv');

  var cta1 = document.getElementById('primary-cta');
  if(cta1){
    if(cfg.primaryCtaText && cfg.primaryCtaUrl){
      cta1.style.display = '';
      cta1.textContent = String(cfg.primaryCtaText);
      cta1.setAttribute('href', String(cfg.primaryCtaUrl));
      cta1.setAttribute('target', '_blank');
      cta1.addEventListener('click', function(){ track('ev','click_primary','primary-cta'); });
    }
  }

  var cta2 = document.getElementById('secondary-cta');
  if(cta2){
    if(cfg.secondaryCtaText && cfg.secondaryCtaUrl){
      cta2.style.display = '';
      cta2.textContent = String(cfg.secondaryCtaText);
      cta2.setAttribute('href', String(cfg.secondaryCtaUrl));
      cta2.setAttribute('target', '_blank');
      cta2.addEventListener('click', function(){ track('ev','click_secondary','secondary-cta'); });
    }
  }
})();`;
};

export const downloadLandingDistZip = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    sendError(res, 'LP104', 400);
    return;
  }

  const scope = getTenancyScopeOrThrow(req);
  const page = await LandingPage.findOne({ where: withTenancyWhere(scope, { id }) } as any);
  if (!page) {
    sendError(res, 'LP105', 404);
    return;
  }

  const trackBase = getTrackingBaseUrl(req);

  const config = {
    landingPageId: id,
    name: (page as any).name,
    source: (page as any).source || null,
    trackBase,
    theme: (page as any).theme || 'auto',
    title: (page as any).title || null,
    subtitle: (page as any).subtitle || null,
    heroImageUrl: (page as any).hero_image_url || null,
    primaryCtaText: (page as any).primary_cta_text || 'Continue',
    primaryCtaUrl: (page as any).primary_cta_url || (page as any).page_url,
    secondaryCtaText: (page as any).secondary_cta_text || null,
    secondaryCtaUrl: (page as any).secondary_cta_url || null,
  };

  const zipName = `dist.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', () => {
    try {
      res.status(500).end();
    } catch {}
  });

  archive.pipe(res);

  const configJson = safeInlineJson(JSON.stringify(config));
  const htmlTitle = safeHtmlText(config.subtitle || config.title || config.name, 'Landing');
  archive.append(renderIndexHtml(configJson, htmlTitle), { name: 'index.html' });
  archive.append(renderAppJs(), { name: 'assets/app.js' });
  archive.append(renderStyleCss(), { name: 'assets/style.css' });

  await archive.finalize();
};
