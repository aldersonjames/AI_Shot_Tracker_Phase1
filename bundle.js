/* bundle.js v18
   - Splash shows for >= 3000ms before navigating to Setup
   - Removed bottom log dock; add header ⋮ menu to toggle/download/copy/clear logs
   - All other behavior preserved (ROI, contain-fit, Vid controls, stabilization wiring)
*/
(function () {
  'use strict';

  // ---------- Logger ----------
  const LOG = (function ensureLogger(){
    if (window.LOG && typeof window.LOG.info === 'function') return window.LOG;
    const buf = [];
    return {
      install(){}, info:(...a)=>{console.log(...a); buf.push(['I',a]);},
      warn:(...a)=>{console.warn(...a); buf.push(['W',a]);},
      error:(...a)=>{console.error(...a); buf.push(['E',a]);},
      attachTo(){}, download(){}, copy(){}, clear(){}, _buf: buf
    };
  })();
  LOG.install?.();

  // ---------- Utilities ----------
  const qs = (sel) => document.querySelector(sel);
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts || { passive: true });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
  function toast(msg){ const t=qs('#errorToast'); if(!t) return; t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'),1600); }
  function fmt(n, places=2) { if (!isFinite(n)) return '—'; return Number(n).toFixed(Math.max(0, places|0)); }

  // MEC helpers
  function dist2(a,b){ const dx=a[0]-b[0], dy=a[1]-b[1]; return dx*dx+dy*dy; }
  function circleFrom2(a,b){ const cx=(a[0]+b[0])/2, cy=(a[1]+b[1])/2; const r=Math.sqrt(dist2(a,b))/2; return {cx,cy,r}; }
  function circleFrom3(a,b,c){
    const A=b[0]-a[0], B=b[1]-a[1], C=c[0]-a[0], D=c[1]-a[1];
    const E=A*(a[0]+b[0])+B*(a[1]+b[1]), F=C*(a[0]+c[0])+D*(a[1]+c[1]);
    const G=2*(A*(c[1]-b[1])-B*(c[0]-b[0]));
    if (Math.abs(G)<1e-9){ const d=[[a,b,dist2(a,b)],[a,c,dist2(a,c)],[b,c,dist2(b,c)]].sort((x,y)=>y[2]-x[2]); return circleFrom2(d[0][0], d[0][1]); }
    const cx=(D*E-B*F)/G, cy=(A*F-C*E)/G; const r=Math.sqrt(dist2([cx,cy],a)); return {cx,cy,r};
  }
  function isInCircle(p, c){ return Math.sqrt(dist2(p,[c.cx,c.cy])) <= c.r + 1e-6; }
  function minimumEnclosingCircle(points){
    const P = points.slice(); for (let i=P.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [P[i],P[j]]=[P[j],P[i]]; }
    let c=null; for (let i=0;i<P.length;i++){ const p=P[i]; if (!c || !isInCircle(p,c)){ c={cx:p[0],cy:p[1],r:0};
      for(let j=0;j<=i;j++){ const q=P[j]; if (!isInCircle(q,c)){ c=circleFrom2(p,q); for(let k=0;k<=j;k++){ const r=P[k]; if (!isInCircle(r,c)) c=circleFrom3(p,q,r); } } } } }
    return c || {cx:0,cy:0,r:0};
  }
  function groupDiameterPx(points){ if (!points || points.length<2) return 0; const mec = minimumEnclosingCircle(points); return 2*mec.r; }

  // ---------- State ----------
  const screens = ['splash','setup','live','review','settings'];
  const state = {
    label: '', distance: 100, units: 'yards',
    pxPerInch: NaN,
    detect: true, shots: [],
    // media
    testMode: false, testObjectURL: null, testImageBitmap: null,
    stream: null, videoTrack: null,
    // flow
    sessionActive: false,
    // UI/detection
    trails: false,
    stabilize: true,
    frameStride: 3, frameCounter: 0,
    minRepeatPx: 14, minNeighborPx: 18, cooldownMs: 600,
    // ROI (CSS px)
    roi: null, roiDrawing:false,
    // content rect of drawn source in overlay pixel space (dpr-scaled)
    contentRect: { x:0, y:0, w:0, h:0 }
  };

  // ---------- Log UI in overflow menu ----------
  (function initMenuAndLogs(){
    const viewer=qs('#logViewer');
    LOG.attachTo?.(viewer);

    const menu = qs('#overflowMenu');
    on(qs('#menuBtn'),'click', (e)=>{ e.preventDefault(); menu.classList.toggle('hidden'); }, {passive:false});
    // close on outside click
    on(document,'click', (e)=>{
      const m = qs('#overflowMenu'); const btn = qs('#menuBtn');
      if (!m || m.classList.contains('hidden')) return;
      if (e.target===m || m.contains(e.target) || e.target===btn) return;
      m.classList.add('hidden');
    });

    on(qs('#menuToggleLogs'),'click', ()=>{ viewer.classList.toggle('hidden'); });
    on(qs('#menuDownloadLog'),'click', ()=>{ LOG.download?.(); });
    on(qs('#menuCopyLog'),'click', async()=>{ try{ await LOG.copy?.(); }catch{} });
    on(qs('#menuClearLog'),'click', ()=>{ LOG.clear?.(); });

    // Keyboard quick toggle (press "L")
    on(window,'keydown',(e)=>{ if ((e.key==='l'||e.key==='L')) viewer.classList.toggle('hidden'); }, {passive:false});
  })();

  // ---------- Router / Init (splash >=3s) ----------
  function go(id){ for(const s of screens){ const el=qs('#'+s); if (el) el.classList.toggle('active', s===id); } }
  (async function init(){
    try{
      // keep splash visible for at least 3 seconds
      await wait(3000);
      go('setup');
    }catch(e){ console.error(e);}
  })();

  // ---------- Setup → Live ----------
  on(qs('#useTestMedia'),'click', async ()=>{
    try{
      const f=qs('#testMedia')?.files?.[0]; if(!f){ toast('Pick a file'); return; }
      await loadTestMedia(f);
      toast('Test media loaded');
    }catch(e){ console.error(e); toast('Failed to load'); }
  });
  on(qs('#useLiveCamera'),'click', ()=>{ try{ unloadTestMedia(); toast('Live camera'); }catch(e){ console.error(e);} });

  on(qs('#toCalTags'),'click', async ()=>{
    state.label=(qs('#groupLabel')?.value||'').trim()||'Session';
    state.distance=parseFloat(qs('#distanceVal')?.value)||100;
    state.units=qs('#units')?.value||'yards';
    go('live'); await startLive();
  });

  // ---------- Live controls ----------
  on(qs('#startSession'),'click', async ()=>{
    try {
      state.shots=[]; await postWorker({type:'reset'});
      await captureBaseline(); state.sessionActive=true; toast('Session started');
    } catch(e){ console.error(e); toast('Baseline failed'); }
  });
  on(qs('#endSession'),'click', ()=>{ state.sessionActive=false; toast('Session ended'); });
  on(qs('#toggleDetect'),'click', ()=>{ state.detect=!state.detect; toast(state.detect?'Detection ON':'Detection OFF'); });
  on(qs('#toggleTrails'),'click', ()=>{ state.trails=!state.trails; toast(state.trails?'Trails ON':'Trails OFF'); });
  on(qs('#toggleStab'),'click', ()=>{ state.stabilize=!state.stabilize; toast(state.stabilize?'Stabilize ON':'Stabilize OFF'); });
  on(qs('#toggleROI'),'click', ()=>{
    if (state.roi){ state.roi=null; state.roiDrawing=false; toast('ROI cleared'); }
    else { state.roiDrawing=true; toast('Draw ROI: drag on video'); }
  });
  on(qs('#togglePlay'),'click', ()=>{
    if (!state.testMode) { toast('Load a test video first'); return; }
    const v=qs('#liveVideo'); if (!v || v.srcObject) { toast('Play/Pause is for test video'); return; }
    if (v.paused) { v.play().catch(()=>{}); toast('Video ▶︎'); }
    else { v.pause(); toast('Video ❚❚'); }
  });
  on(qs('#manualShot'),'click', ()=>{
    const overlay = qs('#liveOverlay'); overlay?.classList.add('aim-cursor');
    const once = (ev) => {
      const rect = overlay.getBoundingClientRect();
      const x = (ev.touches?.[0]?.clientX ?? ev.clientX) - rect.left;
      const y = (ev.touches?.[0]?.clientY ?? ev.clientY) - rect.top;
      addShot({x,y}); overlay.classList.remove('aim-cursor');
      overlay.removeEventListener('click', once); overlay.removeEventListener('touchstart', once);
    };
    on(overlay,'click',once,{passive:false}); on(overlay,'touchstart',once,{passive:true});
  });
  on(qs('#undoShot'),'click',()=>{ state.shots.pop(); drawLiveOverlay(); updateMetrics(); });
  on(qs('#resetGroup'),'click',()=>{ state.shots=[]; drawLiveOverlay(); updateMetrics(); });
  on(qs('#endGroup'),'click',()=>{ qs('#completeBanner')?.classList.remove('hidden'); setTimeout(()=>qs('#completeBanner')?.classList.add('hidden'),1200); });
  on(qs('#snapBtn'),'click',()=>{ renderReview(); go('review'); });
  on(qs('#backToLive'),'click',()=>{ go('live'); });

  // ROI draw on live overlay (CSS coords)
  ;(function wireROI(){
    const canvas = qs('#liveOverlay'); if (!canvas) return;
    let start=null;
    const getPos = (e)=>{ const r=canvas.getBoundingClientRect(); const t=e.touches?.[0]||e; return { x: clamp((t.clientX-r.left),0,r.width), y: clamp((t.clientY-r.top),0,r.height) }; };
    canvas.addEventListener('mousedown',(e)=>{ if(!state.roiDrawing) return; const p=getPos(e); state.roi={x:p.x,y:p.y,w:1,h:1}; start=p; });
    window.addEventListener('mouseup',()=>{ if(!state.roiDrawing) return; state.roiDrawing=false; toast('ROI set'); });
    canvas.addEventListener('mousemove',(e)=>{ if(!state.roiDrawing||!state.roi) return; const p=getPos(e); state.roi.x=Math.min(start.x,p.x); state.roi.y=Math.min(start.y,p.y); state.roi.w=Math.abs(p.x-start.x); state.roi.h=Math.abs(p.y-start.y); });
    canvas.addEventListener('touchstart',(e)=>{ if(!state.roiDrawing) return; const p=getPos(e); state.roi={x:p.x,y:p.y,w:1,h:1}; start=p; },{passive:true});
    canvas.addEventListener('touchmove',(e)=>{ if(!state.roiDrawing||!state.roi) return; const p=getPos(e); state.roi.x=Math.min(start.x,p.x); state.roi.y=Math.min(start.y,p.y); state.roi.w=Math.abs(p.x-start.x); state.roi.h=Math.abs(p.y-start.y); },{passive:true});
  })();

  // ---------- Media ----------
  async function startLive() {
    setOverlaySize(qs('#liveOverlay'), qs('#liveVideo'));
    if (state.testMode) { loopFrames(); return; }
    await startCamera(qs('#liveVideo'), qs('#cameraFacing')?.value || 'environment');
    loopFrames();
  }
  async function startCamera(videoEl, facing='environment') {
    try {
      if (state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ideal:facing}, width:{ideal:1280}, height:{ideal:720} }, audio:false });
      try { videoEl.removeAttribute('src'); videoEl.load?.(); } catch {}
      videoEl.srcObject = stream; await videoEl.play(); state.stream=stream; state.videoTrack=stream.getVideoTracks()[0]||null;
    } catch (e) { console.error('startCamera:', e); toast('Camera error'); }
  }
  function setOverlaySize(canvas, video) {
    const resize=()=>{ const r=video.getBoundingClientRect(); const w=Math.max(1,Math.floor(r.width*devicePixelRatio)); const h=Math.max(1,Math.floor(r.height*devicePixelRatio)); canvas.width=w; canvas.height=h; canvas.style.width=r.width+'px'; canvas.style.height=r.height+'px'; };
    resize(); new ResizeObserver(resize).observe(video);
  }
  async function loadTestMedia(file){
    unloadTestMedia();
    const url = URL.createObjectURL(file); state.testObjectURL = url; state.testMode = true;
    const v=qs('#liveVideo'); if(!v) return;
    if (file.type.startsWith('video/')){
      try{ v.srcObject=null; }catch{} v.src=url; v.loop=true; v.muted=true; v.playsInline=true; v.play().catch(()=>{});
    } else if (file.type.startsWith('image/')){
      const img = new Image(); await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; });
      state.testImageBitmap = await createImageBitmap(img);
      try{ v.removeAttribute('src'); v.load?.(); }catch{}
    } else { throw new Error('Unsupported'); }
  }
  function unloadTestMedia(){
    try {
      if (state.testObjectURL){ URL.revokeObjectURL(state.testObjectURL); state.testObjectURL=null; }
      state.testImageBitmap=null; state.testMode=false;
      const v=qs('#liveVideo'); if (v){ try{ v.pause(); }catch{} v.removeAttribute('src'); v.load?.(); }
    } catch(e){ console.error(e); }
  }

  // ---------- Worker ----------
  let worker;
  async function getWorker() {
    if (worker) return worker;
    if ('Worker' in window && 'OffscreenCanvas' in window) {
      worker = new Worker('worker.js?v=17');
      worker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'shots') {
          const dpr = devicePixelRatio || 1;
          const roi = msg.roi || null;
          (msg.points || []).forEach(p => {
            const cssX = (p.x / dpr) + (roi ? (roi.x / dpr) : 0);
            const cssY = (p.y / dpr) + (roi ? (roi.y / dpr) : 0);
            addShot({ x: cssX, y: cssY, t: msg.t });
          });
        }
      };
      worker.onerror = (err) => console.error('worker error:', err.message || err);
      return worker;
    }
    toast('Worker/OffscreenCanvas not available — AI disabled'); return undefined;
  }
  function postWorker(message, transfer=[]) { return getWorker().then(w => w && w.postMessage(message, transfer)); }

  // ---------- Contain draw helpers ----------
  function drawContain(ctx, source, sw, sh, cw, ch){
    const sAR = sw / sh, cAR = cw / ch;
    let w, h, x, y;
    if (sAR > cAR) { w = cw; h = Math.round(cw / sAR); x = 0; y = Math.round((ch - h) / 2); }
    else           { h = ch; w = Math.round(ch * sAR); y = 0; x = Math.round((cw - w) / 2); }
    ctx.clearRect(0,0,cw,ch); ctx.drawImage(source, 0, 0, sw, sh, x, y, w, h);
    return { x, y, w, h };
  }
  function roiIntersectionCanvasPx(roiCSS, contentRect, dpr){
    if (!roiCSS || roiCSS.w <= 0 || roiCSS.h <= 0) return null;
    const rx = Math.floor(roiCSS.x * dpr), ry = Math.floor(roiCSS.y * dpr);
    const rw = Math.floor(roiCSS.w * dpr), rh = Math.floor(roiCSS.h * dpr);
    const ax1 = Math.max(rx, contentRect.x);
    const ay1 = Math.max(ry, contentRect.y);
    const ax2 = Math.min(rx + rw, contentRect.x + contentRect.w);
    const ay2 = Math.min(ry + rh, contentRect.y + contentRect.h);
    if (ax2 - ax1 <= 4 || ay2 - ay1 <= 4) return null;
    return { x: ax1, y: ay1, w: ax2 - ax1, h: ay2 - ay1 };
  }

  // ---------- Baseline & Frame loop ----------
  async function captureBaseline() {
    const video = qs('#liveVideo'); const overlay = qs('#liveOverlay');
    const cw = overlay.width, ch = overlay.height; if(!cw||!ch) throw new Error('overlay not ready');

    const off = new OffscreenCanvas(cw, ch); const ctx = off.getContext('2d');
    let contentRect;

    if (state.testMode && state.testImageBitmap) {
      const sw=state.testImageBitmap.width, sh=state.testImageBitmap.height;
      contentRect = drawContain(ctx, state.testImageBitmap, sw, sh, cw, ch);
    } else if (state.testMode && (video?.currentSrc || video?.src)) {
      const sw = video.videoWidth || cw, sh = video.videoHeight || ch;
      contentRect = drawContain(ctx, video, sw, sh, cw, ch);
    } else if (video?.readyState >= 2) {
      const sw = video.videoWidth, sh = video.videoHeight;
      contentRect = drawContain(ctx, video, sw, sh, cw, ch);
    } else { throw new Error('no frame'); }

    state.contentRect = contentRect;

    const dpr = devicePixelRatio || 1;
    const crop = roiIntersectionCanvasPx(state.roi, contentRect, dpr);

    if (crop) {
      const {x,y,w,h} = crop;
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(off, x, y, w, h, 0, 0, w, h);
      const bmp = await c.transferToImageBitmap();
      await postWorker({ type:'frame', width:w, height:h, bitmap:bmp, detect:true, baseline:true, roi:{x,y,w,h}, stabilize: state.stabilize }, [bmp]);
    } else {
      const bmp = await off.transferToImageBitmap();
      await postWorker({ type:'frame', width:cw, height:ch, bitmap:bmp, detect:true, baseline:true, stabilize: state.stabilize }, [bmp]);
    }
  }

  async function loopFrames() {
    const video = qs('#liveVideo'); const overlay = qs('#liveOverlay');
    const step = async () => {
      try {
        drawLiveOverlay();

        if (!state.sessionActive || !state.detect) { requestAnimationFrame(step); return; }
        if ((state.frameCounter++ % state.frameStride) !== 0) { requestAnimationFrame(step); return; }

        const cw = overlay.width, ch = overlay.height; if(!cw||!ch){ requestAnimationFrame(step); return; }
        const off = new OffscreenCanvas(cw, ch); const ctx = off.getContext('2d');

        let contentRect;
        if (state.testMode && state.testImageBitmap) {
          const sw=state.testImageBitmap.width, sh=state.testImageBitmap.height;
          contentRect = drawContain(ctx, state.testImageBitmap, sw, sh, cw, ch);
        } else if (state.testMode && (video?.currentSrc || video?.src)) {
          const sw = video.videoWidth || cw, sh = video.videoHeight || ch;
          contentRect = drawContain(ctx, video, sw, sh, cw, ch);
        } else if (video?.readyState >= 2) {
          const sw = video.videoWidth, sh = video.videoHeight;
          contentRect = drawContain(ctx, video, sw, sh, cw, ch);
        } else { requestAnimationFrame(step); return; }

        state.contentRect = contentRect;

        const dpr = devicePixelRatio || 1;
        const crop = roiIntersectionCanvasPx(state.roi, contentRect, dpr);
        if (crop) {
          const {x,y,w,h} = crop;
          const c = new OffscreenCanvas(w, h);
          c.getContext('2d').drawImage(off, x, y, w, h, 0, 0, w, h);
          const bmp = await c.transferToImageBitmap();
          await postWorker({ type:'frame', width:w, height:h, bitmap:bmp, detect:true, roi:{x,y,w,h}, stabilize: state.stabilize }, [bmp]);
        } else {
          const bmp = await off.transferToImageBitmap();
          await postWorker({ type:'frame', width:cw, height:ch, bitmap:bmp, detect:true, stabilize: state.stabilize }, [bmp]);
        }
      } catch (e) { console.error('loopFrames:', e); }
      requestAnimationFrame(step);
    };
    step();
  }

  // ---------- Shots / overlay ----------
  let lastShotAt = 0;
  function addShot({x, y, t}) {
    if (!isFinite(x) || !isFinite(y)) return;
    const now = t || performance.now();
    if (now - lastShotAt < state.cooldownMs) return;

    const last = state.shots[state.shots.length-1];
    if (last && Math.hypot(x-last.x,y-last.y) < state.minRepeatPx) return;
    for (let i=state.shots.length-1;i>=0;i--){
      const s=state.shots[i]; if (Math.hypot(x-s.x,y-s.y) < state.minNeighborPx) return;
    }
    if (state.roi) {
      if (!(x>=state.roi.x && y>=state.roi.y && x<=state.roi.x+state.roi.w && y<=state.roi.y+state.roi.h)) return;
    }
    state.shots.push({x,y,t:now}); lastShotAt=now;
    drawLiveOverlay(); updateMetrics();
  }

  function drawLiveOverlay() {
    const canvas = qs('#liveOverlay'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);

    // ROI rect
    if (state.roi) {
      ctx.save();
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 2*devicePixelRatio; ctx.setLineDash([6*devicePixelRatio,6*devicePixelRatio]);
      ctx.strokeRect(state.roi.x*devicePixelRatio, state.roi.y*devicePixelRatio, state.roi.w*devicePixelRatio, state.roi.h*devicePixelRatio);
      ctx.restore();
    }

    // shots & trails
    ctx.fillStyle='#35dc82'; ctx.strokeStyle='#55a7ff'; ctx.lineWidth=2*devicePixelRatio;
    if (state.trails && state.shots.length>1){
      ctx.beginPath(); ctx.moveTo(state.shots[0].x*devicePixelRatio, state.shots[0].y*devicePixelRatio);
      for(let i=1;i<state.shots.length;i++) ctx.lineTo(state.shots[i].x*devicePixelRatio, state.shots[i].y*devicePixelRatio);
      ctx.stroke();
    }
    for(let i=0;i<state.shots.length;i++){
      const s=state.shots[i], r=6*devicePixelRatio;
      ctx.beginPath(); ctx.arc(s.x*devicePixelRatio, s.y*devicePixelRatio, r, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle='#e8e8ee'; ctx.font=`${12*devicePixelRatio}px system-ui,-apple-system,sans-serif`; ctx.textAlign='center';
      ctx.fillText(String(i+1), s.x*devicePixelRatio, s.y*devicePixelRatio - 12*devicePixelRatio);
      ctx.fillStyle='#35dc82';
    }

    // MEC
    if (state.shots.length>=2){
      const pts = state.shots.map(s=>[s.x*devicePixelRatio, s.y*devicePixelRatio]);
      const mec = minimumEnclosingCircle(pts);
      ctx.strokeStyle='#ff2b2b'; ctx.lineWidth=3*devicePixelRatio;
      ctx.beginPath(); ctx.arc(mec.cx, mec.cy, mec.r, 0, Math.PI*2); ctx.stroke();
      ctx.fillStyle='#ff2b2b'; ctx.beginPath(); ctx.arc(mec.cx, mec.cy, 3*devicePixelRatio, 0, Math.PI*2); ctx.fill();
    }
  }

  function updateMetrics(){
    const pxDiam = groupDiameterPx(state.shots.map(s => [s.x*devicePixelRatio, s.y*devicePixelRatio]));
    const inches = NaN, moa = NaN;
    const sc=qs('#shotCount'), gi=qs('#groupInches'), gm=qs('#groupMOA');
    if (sc) sc.textContent = state.shots.length;
    if (gi) gi.textContent = isFinite(inches) ? `${fmt(inches,3)}"` : '—';
    if (gm) gm.textContent = isFinite(moa) ? fmt(moa,2) : '—';
  }

  function renderReview(){
    const live=qs('#liveVideo'), over=qs('#liveOverlay'); const c=qs('#reviewCanvas'); if(!c||!over) return;
    const w=over.width,h=over.height; c.width=w; c.height=h; const ctx=c.getContext('2d');
    try{ ctx.drawImage(live,0,0,w,h); }catch{}
    ctx.drawImage(over,0,0);
    const pxDiam = groupDiameterPx(state.shots.map(s => [s.x*devicePixelRatio, s.y*devicePixelRatio]));
    const inches = NaN, moa=NaN;
    const cap=qs('#reviewCaption'); if (cap) cap.textContent = `${state.label} • ${state.distance} ${state.units} • Group: ${isFinite(inches)?fmt(inches,3)+'"':'—'} • ${isFinite(moa)?fmt(moa,2)+' MOA':'—'}`;
  }

})();