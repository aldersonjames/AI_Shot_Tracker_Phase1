// app.js v10 — Safari-safe (no dynamic import), verbose logging, same features

import { minimumEnclosingCircle, groupDiameterPx } from './mec.js?v=10';
import { buildCalib, pxPerInchFromRing, moaFromInchesAtDistance, fmt } from './geometry.js?v=10';
import { LOG } from './logger.js?v=10';

LOG.install(); // idempotent
LOG.info('app.js: module evaluated');

try { LOG.startAutoDownload('ai-shot-tracker-auto.log', 5000); } catch {}

const qs = sel => document.querySelector(sel);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { passive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

const screens = ['splash','setup','cal-tags','cal-ring','live','review','settings'];

let state = {
  label: '',
  distance: 100,
  units: 'yards',
  pxPerInch: 0,
  detect: true,
  shots: [],
  baselineLocked: false,
  ringFitPx: 300,
  videoTrack: null,
  stream: null,
  calib: null
};

// ===== Log UI =====
(function initLogUI(){
  try {
    LOG.info('initLogUI: attaching');
    const viewer = qs('#logViewer');
    const toggleBtn = qs('#toggleLog');
    const downloadBtn = qs('#downloadLog');
    const copyBtn = qs('#copyLog');
    const clearBtn = qs('#clearLog');

    if (viewer) LOG.attachTo(viewer);
    on(toggleBtn, 'click', () => {
      viewer.classList.toggle('hidden');
      LOG.info('Log viewer toggled, hidden=', viewer.classList.contains('hidden'));
    });
    on(downloadBtn, 'click', () => LOG.download());
    on(copyBtn, 'click', async () => {
      const ok = await LOG.copy(); toast(ok ? 'Logs copied' : 'Copy failed');
    });
    on(clearBtn, 'click', () => LOG.clear());
  } catch (e) {
    LOG.error('initLogUI: failed', e);
  }
})();

// ===== Router =====
function go(id) {
  LOG.info('Route ->', id);
  for (const s of screens) {
    const el = qs('#'+s);
    if (el) el.classList.toggle('active', s === id);
  }
}

async function init() {
  try {
    LOG.info('init: starting');
    await wait(100);
    LOG.info('init: moving to setup');
    go('setup');
  } catch (e) {
    LOG.error('init: failed', e);
    toast('Init error, see logs');
  }
}
init();

// ===== Setup =====
on(qs('#toCalTags'), 'click', () => {
  LOG.info('toCalTags: clicked');
  try {
    state.label = (qs('#groupLabel')?.value || '').trim() || 'Session';
    state.distance = parseFloat(qs('#distanceVal')?.value) || 100;
    state.units = qs('#units')?.value || 'yards';
    LOG.info('toCalTags: state', JSON.stringify({label:state.label, distance:state.distance, units:state.units}));

    go('cal-tags');
    startCamera(qs('#video'), qs('#cameraFacing')?.value || 'environment')
      .then(() => {
        LOG.info('toCalTags: camera started');
        setOverlaySize(qs('#overlay'), qs('#video'));
        LOG.info('toCalTags: overlay sized');
      })
      .catch(err => {
        LOG.error('toCalTags: camera error', err);
        toast('Camera error (see logs)');
      });
  } catch (e) { LOG.error('toCalTags: exception', e); }
});

on(qs('#lockTags'), 'click', async () => {
  LOG.info('lockTags: clicked');
  try {
    await setWorkerBaseline(qs('#video'));
    LOG.info('lockTags: baseline set');
    toast('Baseline locked');
  } catch (e) {
    LOG.error('lockTags: failed', e);
    toast('Baseline failed');
  }
});

on(qs('#toCalRing'), 'click', () => {
  LOG.info('toCalRing: clicked');
  go('cal-ring');
  prepareRingCanvas();
});

on(qs('#confirmRing'), 'click', () => {
  try {
    LOG.info('confirmRing: clicked');
    const ringInches = parseFloat(qs('#ringDiameter')?.value) || 6.0;
    const ringPx = state.ringFitPx;
    state.pxPerInch = pxPerInchFromRing({ ringPxDiameter: ringPx, ringInches });
    state.calib = buildCalib({ pxPerInch: state.pxPerInch });
    LOG.info('confirmRing: pxPerInch=', state.pxPerInch);
    go('live');
    startLive();
  } catch (e) {
    LOG.error('confirmRing: failed', e);
    toast('Calibration error');
  }
});

// ===== Live HUD =====
on(qs('#toggleDetect'), 'click', () => {
  state.detect = !state.detect;
  LOG.info('toggleDetect:', state.detect);
  toast(state.detect ? 'Detection ON' : 'Detection OFF');
});

on(qs('#manualShot'), 'click', () => {
  LOG.info('manualShot: clicked');
  try {
    const overlay = qs('#liveOverlay');
    overlay?.classList.add('aim-cursor');
    const once = (ev) => {
      try {
        const rect = overlay.getBoundingClientRect();
        const x = (ev.touches?.[0]?.clientX ?? ev.clientX) - rect.left;
        const y = (ev.touches?.[0]?.clientY ?? ev.clientY) - rect.top;
        LOG.info('manualShot: add', x, y);
        addShot({ x, y });
      } catch (e) { LOG.error('manualShot: handler failed', e); }
      overlay.classList.remove('aim-cursor');
      overlay.removeEventListener('click', once);
      overlay.removeEventListener('touchstart', once);
    };
    on(overlay, 'click', once);
    on(overlay, 'touchstart', once);
  } catch (e) { LOG.error('manualShot: failed to init', e); }
});

on(qs('#undoShot'), 'click', () => {
  LOG.info('undoShot: clicked');
  state.shots.pop();
  drawLiveOverlay();
  updateMetrics();
});

on(qs('#resetGroup'), 'click', () => {
  LOG.info('resetGroup: clicked');
  state.shots = [];
  drawLiveOverlay();
  updateMetrics();
});

on(qs('#endGroup'), 'click', () => {
  LOG.info('endGroup: clicked');
  qs('#completeBanner')?.classList.remove('hidden');
  setTimeout(()=>qs('#completeBanner')?.classList.add('hidden'), 1500);
});

on(qs('#snapBtn'), 'click', () => {
  LOG.info('snapBtn: clicked -> review');
  renderReview();
  go('review');
});

on(qs('#backToLive'), 'click', () => { LOG.info('backToLive: clicked'); go('live'); });

on(qs('#exportJSON'), 'click', () => {
  LOG.info('exportJSON: clicked');
  const payload = {
    label: state.label,
    distance: state.distance,
    units: state.units,
    pxPerInch: state.pxPerInch,
    shots: state.shots
  };
  try {
    download('shot-group.json', JSON.stringify(payload, null, 2));
    LOG.info('exportJSON: ok bytes=', JSON.stringify(payload).length);
  } catch (e) { LOG.error('exportJSON: failed', e); }
});

on(qs('#exportCSV'), 'click', () => {
  LOG.info('exportCSV: clicked');
  try {
    const lines = ['idx,x_px,y_px'];
    state.shots.forEach((s,i)=>lines.push(`${i+1},${s.x.toFixed(2)},${s.y.toFixed(2)}`));
    download('shots.csv', lines.join('\n'));
    LOG.info('exportCSV: ok lines=', lines.length);
  } catch (e) { LOG.error('exportCSV: failed', e); }
});

on(qs('#shareImage'), 'click', async () => {
  LOG.info('shareImage: clicked');
  const canvas = qs('#reviewCanvas');
  if (!canvas) return;
  canvas.toBlob(async blob => {
    try {
      if (navigator.canShare && blob) {
        const file = new File([blob], 'group.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Shot Group' });
          LOG.info('shareImage: shared via Web Share');
          return;
        }
      }
      if (blob) download('group.png', blob);
      LOG.info('shareImage: downloaded');
    } catch (e) { LOG.error('shareImage: failed', e); }
  });
});

// ===== Camera / Overlay / Worker =====
async function startCamera(videoEl, facing='environment') {
  LOG.info('startCamera: begin; facing=', facing);
  try {
    if (state.stream) {
      state.stream.getTracks().forEach(t=>t.stop());
      state.stream = null;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('mediaDevices.getUserMedia not available (use https or localhost)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    state.stream = stream;
    state.videoTrack = stream.getVideoTracks()[0] || null;
    LOG.info('startCamera: success settings=', JSON.stringify(state.videoTrack?.getSettings?.() || {}));
  } catch (e) {
    LOG.error('startCamera: error', e);
    toast('Camera error: ' + (e?.message || e));
  }
}

function setOverlaySize(canvas, video) {
  LOG.info('setOverlaySize: attach ResizeObserver');
  const resize = () => {
    try {
      const r = video.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width * devicePixelRatio));
      const h = Math.max(1, Math.floor(r.height * devicePixelRatio));
      canvas.width = w; canvas.height = h;
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      LOG.info('setOverlaySize: sized to', w, h);
    } catch (e) { LOG.error('setOverlaySize: failed', e); }
  };
  resize();
  new ResizeObserver(resize).observe(video);
}

function prepareRingCanvas() {
  LOG.info('prepareRingCanvas: start');
  const canvas = qs('#ringCanvas');
  const parent = canvas?.parentElement;
  if (!canvas || !parent) return;
  const rect = parent.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  canvas.width = Math.max(1, Math.floor(size * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(size * devicePixelRatio));
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';

  let cx = canvas.width/2, cy = canvas.height/2;
  let r = (Math.min(canvas.width, canvas.height) * 0.35);
  state.ringFitPx = r * 2 / devicePixelRatio;

  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = '#ff2b2b';
    ctx.lineWidth = 4 * devicePixelRatio;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 4*devicePixelRatio, 0, Math.PI*2); ctx.fillStyle='#ff2b2b'; ctx.fill();
  };
  draw();

  let dragging = false, pinchStart = 0;
  const pos = (e) => {
    const t = e.touches?.[0] || e;
    const rect = canvas.getBoundingClientRect();
    return { x: (t.clientX-rect.left)*devicePixelRatio, y: (t.clientY-rect.top)*devicePixelRatio };
  };
  canvas.addEventListener('mousedown', ()=> { dragging = true; });
  window.addEventListener('mouseup', ()=> dragging=false);
  canvas.addEventListener('mousemove', e => { if(!dragging) return; const p=pos(e); cx=p.x; cy=p.y; draw(); });
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length===2) {
      pinchStart = dist(e.touches[0], e.touches[1]);
    } else dragging = true;
  }, {passive:true});
  canvas.addEventListener('touchmove', e => {
    if (e.touches.length===2) {
      const d = dist(e.touches[0], e.touches[1]);
      const scale = d / (pinchStart || d);
      r = Math.max(10, Math.min(r*scale, canvas.width*.49));
      pinchStart = d;
      state.ringFitPx = (r * 2) / devicePixelRatio;
      draw();
    } else if (dragging) {
      const p = pos(e); cx=p.x; cy=p.y; draw();
    }
  }, {passive:true});
  function dist(a,b){ return Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY); }
  LOG.info('prepareRingCanvas: ready; ringFitPx=', state.ringFitPx);
}

async function startLive() {
  LOG.info('startLive: begin');
  await startCamera(qs('#liveVideo'), qs('#cameraFacing')?.value || 'environment');
  setOverlaySize(qs('#liveOverlay'), qs('#liveVideo'));
  loopFrames();
}

let worker;
async function getWorker() {
  if (worker) return worker;
  if ('Worker' in window && 'OffscreenCanvas' in window) {
    LOG.info('getWorker: creating classic worker');
    worker = new Worker('worker.js?v=10');
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'shots') {
        if (msg.baselineSet) { state.baselineLocked = true; LOG.info('worker: baselineSet'); }
        (msg.points || []).forEach(p => addShot(p));
        if (msg.points?.length) LOG.info('worker: points=', msg.points.length);
      } else if (msg.type === 'status') {
        LOG.info('worker: status', JSON.stringify(msg));
      } else if (msg.type === 'error') {
        LOG.error('worker: error', msg.msg || msg);
        toast('Detection error (see logs)');
      }
    };
    worker.onerror = (err) => LOG.error('worker: onerror', err.message || err);
    return worker;
  }
  LOG.warn('getWorker: Worker/OffscreenCanvas not available; AI disabled');
  return undefined;
}

async function loopFrames() {
  LOG.info('loopFrames: start RAF');
  const video = qs('#liveVideo');
  const overlay = qs('#liveOverlay');

  const step = async () => {
    try {
      if (video?.readyState >= 2) {
        drawLiveOverlay();
        await sendFrameToWorker(video, overlay);
      }
    } catch (e) {
      LOG.error('loopFrames: step error', e);
    } finally {
      requestAnimationFrame(step);
    }
  };
  step();
}

async function sendFrameToWorker(video, overlay) {
  const wrk = await getWorker();
  if (!wrk || !state.detect) return;
  const w = overlay?.width || 0, h = overlay?.height || 0;
  if (!w || !h) return;

  try {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    const bitmap = await off.transferToImageBitmap();

    wrk.postMessage({
      type: 'frame',
      width: w, height: h,
      bitmap,
      detect: state.detect,
      baseline: !state.baselineLocked
    }, [bitmap]);
  } catch (e) {
    LOG.error('sendFrameToWorker: failed', e);
  }
}

async function setWorkerBaseline(video) {
  LOG.info('setWorkerBaseline: begin');
  state.baselineLocked = false;
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  if (!vw || !vh) { LOG.warn('setWorkerBaseline: video not ready', vw, vh); toast('Hold on—camera not ready yet.'); return; }
  try {
    const off = new OffscreenCanvas(vw, vh);
    const ctx = off.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh);
    const bitmap = await off.transferToImageBitmap();
    const wrk = await getWorker();
    wrk?.postMessage({ type:'frame', width:vw, height:vh, bitmap, detect:true, baseline:true }, [bitmap]);
    LOG.info('setWorkerBaseline: posted baseline', vw, vh);
  } catch (e) {
    LOG.error('setWorkerBaseline: failed', e);
  }
}

function addShot({x, y}) {
  if (!isFinite(x) || !isFinite(y)) { LOG.warn('addShot: invalid', x, y); return; }
  state.shots.push({ x, y });
  drawLiveOverlay();
  updateMetrics();
}

function drawLiveOverlay() {
  try {
    const canvas = qs('#liveOverlay');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);

    ctx.fillStyle = '#35dc82';
    ctx.strokeStyle = '#55a7ff';
    ctx.lineWidth = 2 * devicePixelRatio;

    if (state.shots.length > 1) {
      ctx.beginPath();
      ctx.moveTo(state.shots[0].x*devicePixelRatio, state.shots[0].y*devicePixelRatio);
      for (let i = 1; i < state.shots.length; i++) {
        ctx.lineTo(state.shots[i].x*devicePixelRatio, state.shots[i].y*devicePixelRatio);
      }
      ctx.stroke();
    }

    for (let i = 0; i < state.shots.length; i++) {
      const s = state.shots[i];
      const r = 6 * devicePixelRatio;
      ctx.beginPath(); ctx.arc(s.x*devicePixelRatio, s.y*devicePixelRatio, r, 0, Math.PI*2); ctx.fill();

      ctx.fillStyle = '#e8e8ee';
      ctx.font = `${12*devicePixelRatio}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i+1), s.x*devicePixelRatio, s.y*devicePixelRatio - 12*devicePixelRatio);
      ctx.fillStyle = '#35dc82';
    }

    const liveMEC = qs('#prefLiveMEC');
    if (state.shots.length >= 2 && liveMEC && liveMEC.checked) {
      const pts = state.shots.map(s => [s.x*devicePixelRatio, s.y*devicePixelRatio]);
      const mec = minimumEnclosingCircle(pts);
      ctx.strokeStyle = '#ff2b2b';
      ctx.lineWidth = 3 * devicePixelRatio;
      ctx.beginPath(); ctx.arc(mec.cx, mec.cy, mec.r, 0, Math.PI*2); ctx.stroke();
      ctx.fillStyle = '#ff2b2b';
      ctx.beginPath(); ctx.arc(mec.cx, mec.cy, 3*devicePixelRatio, 0, Math.PI*2); ctx.fill();
    }
  } catch (e) {
    LOG.error('drawLiveOverlay: failed', e);
  }
}

function updateMetrics() {
  try {
    const pxDiam = groupDiameterPx(state.shots.map(s => [s.x*devicePixelRatio, s.y*devicePixelRatio]));
    const inches = state.calib ? state.calib.pxToIn(pxDiam / devicePixelRatio) : NaN;
    const moa = moaFromInchesAtDistance(inches, state.distance, state.units);
    const sc = qs('#shotCount'), gi = qs('#groupInches'), gm = qs('#groupMOA');
    if (sc) sc.textContent = state.shots.length;
    if (gi) gi.textContent = isFinite(inches) ? `${fmt(inches, 3)}"` : '—';
    if (gm) gm.textContent = isFinite(moa) ? fmt(moa, 2) : '—';
    LOG.info('updateMetrics:', { pxDiam, inches, moa });
  } catch (e) {
    LOG.error('updateMetrics: failed', e);
  }
}

function renderReview() {
  LOG.info('renderReview: begin');
  try {
    const live = qs('#liveVideo');
    const overlay = qs('#liveOverlay');
    const c = qs('#reviewCanvas');
    if (!c || !overlay) return;

    const w = overlay.width, h = overlay.height;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');

    try { ctx.drawImage(live, 0, 0, w, h); } catch {}
    ctx.drawImage(overlay, 0, 0);

    const pxDiam = groupDiameterPx(state.shots.map(s => [s.x*devicePixelRatio, s.y*devicePixelRatio]));
    const inches = state.calib ? state.calib.pxToIn(pxDiam / devicePixelRatio) : NaN;
    const moa = moaFromInchesAtDistance(inches, state.distance, state.units);

    const cap = qs('#reviewCaption');
    if (cap) cap.textContent =
      `${state.label} • ${state.distance} ${state.units} • Group: ${fmt(inches,3)}" • ${fmt(moa,2)} MOA`;

    LOG.info('renderReview: caption set');
  } catch (e) {
    LOG.error('renderReview: failed', e);
  }
}

// ===== Helpers =====
function download(name, content) {
  try {
    const blob = content instanceof Blob
      ? content
      : new Blob([content], { type: typeof content==='string' ? 'text/plain' : 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    LOG.info('download: triggered', name);
  } catch (e) { LOG.error('download: failed', e); }
}
function toast(msg) {
  const t = qs('#errorToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(()=>t.classList.add('hidden'), 1800);
}