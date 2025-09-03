// logger.js - persistent, verbose browser logger with UI helpers
// Persists to localStorage, captures console + global errors,
// auto-downloads (optional), and (critically) installs IMMEDIATELY so
// even earliest bootstrap logs are captured. Overlay attaches as soon
// as the DOM/body exists when window.__AUTO_LOGGER__ is true.

const STORAGE_KEY = 'ai_shot_tracker_logs_v1';
const MAX_MEM_LINES = 5000;      // in-memory cap
const MAX_STORE_LINES = 20000;   // persistent cap

function nowISO() {
  try { return new Date().toISOString(); } catch { return '' }
}
function serialize(obj) {
  try {
    if (obj instanceof Error) return `${obj.name}: ${obj.message}\n${obj.stack || ''}`;
    if (typeof obj === 'object') return JSON.stringify(obj);
    return String(obj);
  } catch { return String(obj); }
}
function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePersisted(lines) {
  try {
    const trimmed = lines.slice(-MAX_STORE_LINES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    try {
      const half = lines.slice(-Math.floor(MAX_STORE_LINES/2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
    } catch {}
  }
}

class Logger {
  constructor() {
    this.lines = loadPersisted();
    this.mem = [];
    this.ui = null;
    this._installed = false;

    // Auto-download state
    this._autoDlTimer = null;
    this._lastDlCount = -1;
    this._autoDlFilename = 'ai-shot-tracker-auto.log';
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
    const wrap = (level) => (...args) => {
      try { this._push(level, args); } catch {}
      try { original[level](...args); } catch {}
    };
    console.log = wrap('log');
    console.warn = wrap('warn');
    console.error = wrap('error');

    // global error hooks
    window.addEventListener('error', (e) => {
      this._push('error', [`[window.onerror] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this._push('error', ['[unhandledrejection]', e.reason]);
    });

    this.info('Logger installed');
  }

  _push(level, args) {
    const msg = args.map(serialize).join(' ');
    const line = `${nowISO()} [${level.toUpperCase()}] ${msg}`;
    this.mem.push(line);
    if (this.mem.length > MAX_MEM_LINES) this.mem.shift();

    this.lines.push(line);
    if (this.lines.length > MAX_STORE_LINES) this.lines = this.lines.slice(-MAX_STORE_LINES);
    savePersisted(this.lines);
    if (this.ui) this._renderUI();
  }

  info(...a){ this._push('log', a); }
  warn(...a){ this._push('warn', a); }
  error(...a){ this._push('error', a); }

  // === Auto-download support (optional) ===
  startAutoDownload(filename = 'ai-shot-tracker-auto.log', intervalMs = 5000) {
    this._autoDlFilename = filename || this._autoDlFilename;
    if (this._autoDlTimer) clearInterval(this._autoDlTimer);
    this._lastDlCount = -1;
    const safeInterval = Math.max(1000, intervalMs|0);
    this._autoDlTimer = setInterval(() => {
      try {
        if (!this.lines.length) return;
        if (this.lines.length !== this._lastDlCount) {
          this._lastDlCount = this.lines.length;
          this._downloadBlob(this.lines.join('\n'), this._autoDlFilename);
        }
      } catch {}
    }, safeInterval);
  }
  stopAutoDownload() {
    if (this._autoDlTimer) { clearInterval(this._autoDlTimer); this._autoDlTimer = null; }
  }
  _downloadBlob(text, filename) {
    try {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch {}
  }

  // === Log viewer UI support ===
  attachTo(containerEl) { this.ui = containerEl; this._renderUI(); }
  _renderUI() {
    if (!this.ui) return;
    const last = this.lines.slice(-500);
    this.ui.textContent = last.join('\n');
    this.ui.scrollTop = this.ui.scrollHeight;
  }

  // === Manual controls ===
  clear() { this.mem = []; this.lines = []; savePersisted(this.lines); if (this.ui) this._renderUI(); }
  download(filename = `ai-shot-tracker-${Date.now()}.log`) {
    try {
      const blob = new Blob([this.lines.join('\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      this.info('download: triggered', filename);
    } catch (e) { this.error('download: failed', e); }
  }
  async copy() { try { await navigator.clipboard.writeText(this.lines.join('\n')); return true; } catch { return false; } }
}

export const LOG = new Logger();
// Expose for quick manual checks in console if needed
window.LOG = LOG;

/* ========= EARLY INSTALL & OVERLAY =========
   Install immediately so bootstrap logs are captured.
   Attach overlay as soon as body exists, then flush backlog.
*/
(function earlyBoot(){
  if (typeof window === 'undefined') return;
  const wantOverlay = !!window.__AUTO_LOGGER__;

  try { LOG.install(); } catch {}

  if (!wantOverlay) return;

  // Inline CSS once
  const ensureStyles = () => {
    if (document.getElementById('boot-log-style')) return;
    const css = `
#boot-log {
  position: fixed; left: 8px; right: 8px; bottom: 8px; height: 45vh;
  background: rgba(0,0,0,.90); border: 1px solid #333; border-radius: 12px;
  padding: 10px; z-index: 99999; color: #c7f5c7;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  white-space: pre-wrap; overflow: auto;
}
#boot-log::before {
  content: 'Live Log'; position:absolute; left:10px; top:-11px;
  font: 600 11px/1 system-ui, -apple-system; padding:2px 6px; border-radius:6px;
  background:#111; color:#a0ffd0; border:1px solid #2a2a2a;
}`;
    const style = document.createElement('style');
    style.id = 'boot-log-style';
    style.textContent = css;
    document.head.appendChild(style);
  };

  const attachOverlay = () => {
    try {
      ensureStyles();
      let pre = document.getElementById('boot-log');
      if (!pre) {
        pre = document.createElement('pre');
        pre.id = 'boot-log';
        document.body.appendChild(pre);
      }
      LOG.attachTo(pre);
      LOG.info('Auto logger overlay booted');
    } catch (e) {
      // If attaching fails, at least keep capturing logs in memory
      console.log('Auto logger overlay attach failed:', e);
    }
  };

  if (document.body) attachOverlay();
  else document.addEventListener('DOMContentLoaded', attachOverlay, { once: true });
})();