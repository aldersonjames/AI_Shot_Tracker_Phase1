/* worker.js v15
   - Baseline dark-diff: report only NEW darker changes (new holes)
   - ROI-aware: main thread may crop before sending; we return points in that cropped space
   - Translation stabilization (optional): detect colored corners (R,G,B,Y) and align current frame to baseline via average (dx,dy)
   - Downsampled mask + dilate/erode + connected components + temporal & spatial gating
*/
let W = 0, H = 0;
let baselineGray = null;    // Float32Array
let haveBaseline = false;
let stabEnabled = false;

let baselineCentroid = null; // {x,y} centroid of colored markers at baseline (ROI space)
const recent = [];           // shot gating
const cooldownMs = 500;
const minDistPx  = 16;

// detection tuning
const ds = 2;               // downsample factor for mask/HSV sampling
const minAreaDS = 8;
const maxAreaDS = 900;

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'reset') {
      baselineGray = null; haveBaseline=false; baselineCentroid=null; recent.length=0;
      return;
    }
    if (msg.type === 'frame' && msg.bitmap) {
      W = msg.width|0; H = msg.height|0; stabEnabled = !!msg.stabilize;

      // Rasterize to RGBA (so we can do HSV for markers)
      const { data: rgba } = rasterizeBitmap(msg.bitmap, W, H);
      // Grayscale for diff
      const gray = toGray(rgba);

      if (msg.baseline) {
        baselineGray = gray; haveBaseline = true; recent.length = 0;
        if (stabEnabled) {
          baselineCentroid = detectMarkersCentroid(rgba, W, H, ds); // may be null if not found
        } else baselineCentroid = null;
        return;
      }
      if (!msg.detect || !haveBaseline) return;

      // Optional stabilization
      let alignedGray = gray;
      if (stabEnabled && baselineCentroid) {
        const currCentroid = detectMarkersCentroid(rgba, W, H, ds);
        if (currCentroid) {
          const dx = currCentroid.x - baselineCentroid.x;
          const dy = currCentroid.y - baselineCentroid.y;
          alignedGray = translateGray(gray, W, H, -dx, -dy);
        }
      }

      // diff = baseline - current (dark-only)
      const diff = new Float32Array(alignedGray.length);
      for (let i=0;i<alignedGray.length;i++){ const d = baselineGray[i] - alignedGray[i]; diff[i] = d > 0 ? d : 0; }

      // adaptive threshold
      const { mean, std } = stats(diff); const T = mean + 2*std;

      // downsample + binarize
      const w2 = Math.floor(W/ds), h2 = Math.floor(H/ds);
      const mask = new Uint8Array(w2*h2);
      for (let y=0;y<h2;y++){
        for (let x=0;x<w2;x++){
          let s=0,c=0;
          for(let yy=0; yy<ds; yy++){
            for(let xx=0; xx<ds; xx++){
              const X=x*ds+xx, Y=y*ds+yy;
              if (X<W && Y<H){ s += diff[Y*W+X]; c++; }
            }
          }
          mask[y*w2+x] = (s/c) > T ? 1 : 0;
        }
      }

      dilate(mask, w2, h2);
      erode(mask, w2, h2);

      // connected-components → centroids
      const labels = new Int32Array(w2*h2).fill(-1);
      const points = [];
      let lbl = 0;
      const stack = new Int32Array(w2*h2);
      for (let y=0;y<h2;y++){
        for (let x=0;x<w2;x++){
          const idx=y*w2+x;
          if (!mask[idx] || labels[idx] !== -1) continue;

          let top=0; stack[top++]=idx; labels[idx]=lbl;
          let sumX=0,sumY=0,count=0,minX=x,maxX=x,minY=y,maxY=y;

          while(top>0){
            const p=stack[--top]; const px=p%w2, py=(p/w2)|0;
            sumX+=px; sumY+=py; count++;
            if (px<minX)minX=px; if(px>maxX)maxX=px; if(py<minY)minY=py; if(py>maxY)maxY=py;

            const nbs=[p-1,p+1,p-w2,p+w2];
            for(let k=0;k<4;k++){
              const q=nbs[k];
              if(q<0||q>=w2*h2) continue;
              if(!mask[q] || labels[q]!==-1) continue;
              labels[q]=lbl; stack[top++]=q;
            }
          }

          if (count>=minAreaDS && count<=maxAreaDS){
            const bw=(maxX-minX+1), bh=(maxY-minY+1);
            const fill = count/(bw*bh);
            if (fill>0.20 && fill<0.85){
              const cx_ds=sumX/count, cy_ds=sumY/count;
              const cx = cx_ds * ds;
              const cy = cy_ds * ds;

              const now = performance.now();
              if (!tooClose(cx,cy,now)) {
                points.push({x:cx,y:cy});
                recent.push({x:cx,y:cy,t:now});
                pruneRecent(now);
              }
            }
          }
          lbl++;
        }
      }

      if (points.length){
        self.postMessage({ type:'shots', points, t: performance.now(), roi: msg.roi || null });
      }
    }
  } catch (err) {
    self.postMessage({ type:'error', msg: String(err && (err.stack || err.message || err)) });
  }
};

// ---------- helpers ----------
function rasterizeBitmap(bitmap, w, h){
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  const imageData = g.getImageData(0, 0, w, h);
  return imageData; // {data,width,height}
}
function toGray(rgba){
  const n = rgba.length/4; const g = new Float32Array(n);
  for(let i=0,j=0;i<n;i++,j+=4){ const R=rgba[j], G=rgba[j+1], B=rgba[j+2]; g[i] = 0.2126*R + 0.7152*G + 0.0722*B; }
  return g;
}
function stats(arr){
  let s=0,s2=0,n=arr.length;
  for(let i=0;i<n;i++){ const v=arr[i]; s+=v; s2+=v*v; }
  const mean=s/n; const varr=Math.max(0, s2/n-mean*mean); const std=Math.sqrt(varr); return {mean,std};
}
function dilate(mask,w,h){
  const out = mask.slice(0);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x;
      out[i] = (mask[i] | mask[i-1] | mask[i+1] | mask[i-w] | mask[i+w]) ? 1 : 0;
    }
  }
  mask.set(out);
}
function erode(mask,w,h){
  const out = mask.slice(0);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i=y*w+x;
      out[i] = (mask[i] & mask[i-1] & mask[i+1] & mask[i-w] & mask[i+w]) ? 1 : 0;
    }
  }
  mask.set(out);
}
function tooClose(x,y,now){
  for(let i=recent.length-1;i>=0;i--){
    const r=recent[i]; if (now-r.t < cooldownMs){ const dx=x-r.x, dy=y-r.y; if (dx*dx+dy*dy < minDistPx*minDistPx) return true; }
  }
  return false;
}
function pruneRecent(now){
  for(let i=recent.length-1;i>=0;i--){ if (now - recent[i].t > 3000) recent.splice(i,1); }
}

// ---------- Translation stabilization via colored corners ----------
function detectMarkersCentroid(rgba, W, H, step){
  let sumX=0,sumY=0,count=0;
  // Accumulate pixels matching any of the four colors (broad HSV ranges)
  for (let y=0; y<H; y+=step){
    for (let x=0; x<W; x+=step){
      const j = (y*W + x) * 4;
      const r=rgba[j], g=rgba[j+1], b=rgba[j+2];
      const {h,s,v} = rgb2hsv(r,g,b);
      // normalize hue to [0,360)
      // thresholds (broad; tweak if needed)
      const isRed    = ((h<15 || h>345) && s>0.5 && v>0.25);
      const isGreen  = (h>80 && h<160 && s>0.45 && v>0.25);
      const isBlue   = (h>190 && h<260 && s>0.45 && v>0.25);
      const isYellow = (h>35 && h<70  && s>0.45 && v>0.35);
      if (isRed || isGreen || isBlue || isYellow){
        sumX += x; sumY += y; count++;
      }
    }
  }
  if (count < 50) return null; // not enough evidence
  return { x: sumX / count, y: sumY / count };
}
function rgb2hsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  const d=max-min;
  let h=0; if (d!==0){
    switch(max){
      case r: h=((g-b)/d)%6; break;
      case g: h=(b-r)/d+2; break;
      case b: h=(r-g)/d+4; break;
    }
    h*=60; if (h<0) h+=360;
  }
  const s = max===0?0:d/max; const v=max;
  return {h,s,v};
}
function translateGray(gray, W, H, dx, dy){
  // Shift gray by (dx,dy) using bilinear sampling into a new Float32Array
  const out = new Float32Array(gray.length);
  for (let y=0;y<H;y++){
    const sy = y + dy;
    const y0 = Math.floor(sy), wy = sy - y0;
    for (let x=0;x<W;x++){
      const sx = x + dx;
      const x0 = Math.floor(sx), wx = sx - x0;
      let v=0;
      // bilinear from 4 neighbors, clamp at edges
      const v00 = sampleGray(gray,W,H,x0,y0);
      const v10 = sampleGray(gray,W,H,x0+1,y0);
      const v01 = sampleGray(gray,W,H,x0,y0+1);
      const v11 = sampleGray(gray,W,H,x0+1,y0+1);
      v = (1-wx)*(1-wy)*v00 + wx*(1-wy)*v10 + (1-wx)*wy*v01 + wx*wy*v11;
      out[y*W + x] = v;
    }
  }
  return out;
}
function sampleGray(gray,W,H,x,y){
  if (x<0) x=0; else if (x>=W) x=W-1;
  if (y<0) y=0; else if (y>=H) y=H-1;
  return gray[y*W + x];
}