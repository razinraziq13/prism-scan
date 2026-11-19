/* Prism Scan — a document scanner that runs fully on the phone. */
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const CDN = {
    opencv: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  };
  const FILTERS = [['magic', 'Magic'], ['original', 'Original'], ['gray', 'Gray'], ['bw', 'B&W'], ['vivid', 'Vivid']];
  const HANDLE_COLORS = ['#a78bfa', '#f472b6', '#fb923c', '#2dd4bf'];

  const state = {
    view: 'home', docId: null, source: null, corners: null, warped: null,
    filter: lsGet('filter') || 'magic', queue: [], queueTotal: 0, cornersTouched: false,
    cropToken: 0, pageIdx: -1, pageBlob: null, pageUrl: null, ocrIds: [], ocrText: '',
    exportBlob: null, exportName: '', exportUrl: null,
  };

  /* ---------------- small helpers ---------------- */
  function lsGet(k) { try { return localStorage.getItem('prism:' + k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('prism:' + k, v); } catch { /* private mode */ } }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmtSize = b => !b ? '0 KB' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  function defaultName() {
    const d = new Date();
    return 'Scan ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function show(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    state.view = view;
  }

  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => res();
        s.onerror = () => { delete scripts[src]; s.remove(); rej(new Error('Could not download a component. Are you online?')); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  const toBlob = (c, type = 'image/jpeg', q = 0.85) => new Promise((res, rej) =>
    c.toBlob(b => b ? res(b) : rej(new Error('Could not encode image')), type, q));

  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function downscale(src, max) {
    const s = Math.min(1, max / Math.max(src.width, src.height));
    if (s === 1) return src;
    const c = makeCanvas(Math.round(src.width * s), Math.round(src.height * s));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function rotateCanvas(src) {
    const c = makeCanvas(src.height, src.width), x = c.getContext('2d');
    x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(src, 0, 0);
    return c;
  }
  function loadImageFile(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  /* ---------------- storage (IndexedDB) ---------------- */
  const DB = {
    _p: null,
    open() {
      if (!this._p) this._p = new Promise((res, rej) => {
        const r = indexedDB.open('prism-scan', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const s of ['docs', 'pages', 'thumbs', 'sigs']) {
            if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
          }
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this._p;
    },
    async run(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
        t.onerror = t.onabort = () => rej(t.error || new Error('Storage error'));
      });
    },
    get(s, k) { return this.run(s, 'readonly', o => o.get(k)); },
    all(s) { return this.run(s, 'readonly', o => o.getAll()); },
    put(s, v) { return this.run(s, 'readwrite', o => o.put(v)); },
    del(s, k) { return this.run(s, 'readwrite', o => o.delete(k)); },
  };

  const thumbUrls = new Map();
  async function thumbUrl(pageId) {
    if (thumbUrls.has(pageId)) return thumbUrls.get(pageId);
    const t = await DB.get('thumbs', pageId);
    if (!t) return '';
    const u = URL.createObjectURL(new Blob([t.data], { type: 'image/jpeg' }));
    thumbUrls.set(pageId, u);
    return u;
  }
  async function removePage(id) {
    const u = thumbUrls.get(id); if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); }
    await DB.del('pages', id); await DB.del('thumbs', id);
  }
  async function pageBlob(id) {
    const p = await DB.get('pages', id);
    return p ? { blob: new Blob([p.data], { type: 'image/jpeg' }), page: p } : null;
  }

  /* ---------------- OpenCV (edge detection) ---------------- */
  let cvPromise = null;
  function ensureCV() {
    if (cvPromise) return cvPromise;
    cvPromise = loadScript(CDN.opencv).then(() => new Promise((res, rej) => {
      let done = false, iv = null, to = null;
      const finish = m => {
        if (done || !m || !m.Mat) return;
        done = true; clearInterval(iv); clearTimeout(to);
        res({ cv: m }); // wrapped: the OpenCV module is "thenable" and would loop if resolved directly
      };
      const c = window.cv;
      if (!c) return rej(new Error('OpenCV missing'));
      iv = setInterval(() => window.cv && window.cv.Mat && finish(window.cv), 250);
      to = setTimeout(() => { if (!done) { clearInterval(iv); rej(new Error('OpenCV timed out')); } }, 90000);
      if (c.Mat) return finish(c);
      if (typeof c.then === 'function') { try { c.then(m => finish(m)); } catch { /* ignore */ } }
      const prev = c.onRuntimeInitialized;
      c.onRuntimeInitialized = () => { if (prev) prev(); finish(window.cv && window.cv.Mat ? window.cv : c); };
    })).catch(e => { cvPromise = null; throw e; });
    return cvPromise;
  }

  function matPts(m) { const p = []; for (let j = 0; j < 4; j++) p.push([m.data32S[j * 2], m.data32S[j * 2 + 1]]); return p; }

  function findQuad(cv, edges, minArea, maxArea, mats) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    mats.push(contours, hier);
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestA = 0, bigIdx = -1, bigA = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a < minArea) { c.delete(); continue; }
      if (a > bigA && a < maxArea) { bigA = a; bigIdx = i; }
      const ap = new cv.Mat();
      cv.approxPolyDP(c, ap, 0.02 * cv.arcLength(c, true), true);
      if (ap.rows === 4 && cv.isContourConvex(ap)) {
        const aa = cv.contourArea(ap);
        if (aa > bestA && aa < maxArea) { bestA = aa; best = matPts(ap); }
      }
      ap.delete(); c.delete();
    }
    if (best) return best;
    if (bigIdx >= 0) {
      const c = contours.get(bigIdx), hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const peri = cv.arcLength(hull, true);
      let res = null;
      for (let eps = 0.02; eps <= 0.15 && !res; eps += 0.01) {
        const ap = new cv.Mat();
        cv.approxPolyDP(hull, ap, eps * peri, true);
        if (ap.rows === 4) res = matPts(ap);
        ap.delete();
      }
      hull.delete(); c.delete();
      return res;
    }
    return null;
  }

  function detectQuad(cv, canvas) {
    const W = canvas.width, H = canvas.height;
    const mats = [], m = x => (mats.push(x), x);
    try {
      const src = m(cv.imread(canvas));
      const gray = m(new cv.Mat()); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const blur = m(new cv.Mat()); cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      const k = m(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      const e1 = m(new cv.Mat()); cv.Canny(blur, e1, 40, 120); cv.dilate(e1, e1, k);
      const e2 = m(new cv.Mat()); cv.threshold(blur, e2, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(e2, e2, cv.MORPH_CLOSE, k);
      for (const e of [e1, e2]) {
        const q = findQuad(cv, e, W * H * 0.12, W * H * 0.985, mats);
        if (q) return q;
      }
      return null;
    } finally {
      mats.forEach(x => { try { x.delete(); } catch { /* already freed */ } });
    }
  }

  // returns [topLeft, topRight, bottomRight, bottomLeft]
  function orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0;
    sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i; });
    return sorted.slice(start).concat(sorted.slice(0, start)).map(p => [p[0], p[1]]);
  }

  /* ---------------- perspective warp ---------------- */
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      const piv = A[i][i] || 1e-12;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / piv;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / (A[i][i] || 1e-12);
    }
    return x;
  }
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return solve(A, b);
  }
  function warp(src, quad) {
    const [tl, tr, br, bl] = quad;
    let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, 2200 / Math.max(W, H));
    W = Math.max(8, Math.round(W * s)); H = Math.max(8, Math.round(H * s));
    const h = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const sw = src.width, sh = src.height;
    const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = makeCanvas(W, H), octx = out.getContext('2d');
    const od = octx.createImageData(W, H), d = od.data;
    const mx = sw - 1.001, my = sh - 1.001, row = sw * 4;
    let o = 0;
    for (let y = 0; y < H; y++) {
      const yy = y + 0.5;
      for (let x = 0; x < W; x++) {
        const xx = x + 0.5;
        const den = h[6] * xx + h[7] * yy + 1;
        let sx = (h[0] * xx + h[1] * yy + h[2]) / den - 0.5;
        let sy = (h[3] * xx + h[4] * yy + h[5]) / den - 0.5;
        sx = sx < 0 ? 0 : sx > mx ? mx : sx;
        sy = sy < 0 ? 0 : sy > my ? my : sy;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + row, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const t = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const bt = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          d[o + c] = t + (bt - t) * fy;
        }
        d[o + 3] = 255; o += 4;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  /* ---------------- filters ---------------- */
  function localMean(a, w, h, r) {
    const W = w + 1, I = new Uint32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += a[y * w + x];
        I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rowSum;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      }
    }
    return out;
  }
  function applyFilter(src, name) {
    const w = src.width, h = src.height, out = makeCanvas(w, h), ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    if (name === 'original') return out;
    const img = ctx.getImageData(0, 0, w, h), d = img.data, n = w * h;
    if (name === 'vivid') {
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        for (let c = 0; c < 3; c++) d[i + c] = (l + (d[i + c] - l) * 1.6 - 128) * 1.15 + 134;
      }
    } else {
      const lum = new Uint8ClampedArray(n);
      for (let j = 0, i = 0; j < n; j++, i += 4) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const mean = localMean(lum, w, h, Math.max(6, Math.round(Math.max(w, h) / 22)));
      for (let j = 0, i = 0; j < n; j++, i += 4) {
        const m = Math.max(mean[j], 24), l = lum[j];
        if (name === 'magic') {
          const f = 245 / m;
          for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] * f - 140) * 1.35 + 140;
        } else if (name === 'gray') {
          d[i] = d[i + 1] = d[i + 2] = (l * 240 / m - 140) * 1.25 + 140;
        } else if (name === 'bw') {
          d[i] = d[i + 1] = d[i + 2] = (l / m - 0.72) / 0.2 * 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  /* ---------------- sheets ---------------- */
  const sheetStack = [];
  function openSheet(id) {
    const el = $('#' + id);
    if (sheetStack.includes(el)) return;
    el.classList.remove('hidden'); sheetStack.push(el); restack();
  }
  function closeSheet(el = sheetStack[sheetStack.length - 1]) {
    if (!el || !sheetStack.includes(el)) return;
    el.classList.add('hidden'); sheetStack.splice(sheetStack.indexOf(el), 1); restack();
    if (el.id === 'sheet-page' && state.pageUrl) { URL.revokeObjectURL(state.pageUrl); state.pageUrl = null; $('#page-img').removeAttribute('src'); }
    if (el.id === 'sheet-export' && state.exportUrl) { URL.revokeObjectURL(state.exportUrl); state.exportUrl = null; }
    if (el.id === 'sheet-sign') { sign.urls.forEach(u => URL.revokeObjectURL(u)); sign.urls = []; }
  }
  function restack() {
    const bd = $('#sheet-backdrop');
    sheetStack.forEach((s, i) => { s.style.zIndex = 22 + i * 2; });
    if (sheetStack.length) { bd.classList.remove('hidden'); bd.style.zIndex = 21 + (sheetStack.length - 1) * 2; }
    else bd.classList.add('hidden');
  }
  $('#sheet-backdrop').addEventListener('click', () => {
    const top = sheetStack[sheetStack.length - 1];
    if (top && !top.classList.contains('full')) closeSheet(top);
  });
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]');
    if (c) closeSheet(c.closest('.sheet'));
  });

  /* ---------------- home ---------------- */
  async function renderHome() {
    const docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated);
    $('#stat-docs').textContent = docs.length;
    $('#stat-pages').textContent = docs.reduce((s, d) => s + d.pages.length, 0);
    $('#stat-size').textContent = fmtSize(docs.reduce((s, d) => s + (d.size || 0), 0));
    const q = $('#search').value.trim().toLowerCase();
    const list = $('#doc-list');
    list.textContent = '';
    const shown = docs.filter(d => !q || d.name.toLowerCase().includes(q));
    $('#empty').classList.toggle('hidden', docs.length > 0);
    for (const d of shown) {
      const card = document.createElement('button');
      card.className = 'doc-card';
      const th = document.createElement('div'); th.className = 'doc-thumb c' + (hashCode(d.id) % 6);
      const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
      th.appendChild(img);
      const cnt = document.createElement('span'); cnt.className = 'doc-count'; cnt.textContent = d.pages.length + (d.pages.length === 1 ? ' page' : ' pages');
      th.appendChild(cnt);
      const nm = document.createElement('div'); nm.className = 'doc-name'; nm.textContent = d.name;
      const dt = document.createElement('div'); dt.className = 'doc-date'; dt.textContent = fmtDate(d.updated);
      card.append(th, nm, dt);
      card.onclick = () => openDoc(d.id);
      list.appendChild(card);
      if (d.pages[0]) thumbUrl(d.pages[0]).then(u => { if (u) img.src = u; });
    }
    if (docs.length && !shown.length) {
      const p = document.createElement('p'); p.className = 'search-empty muted'; p.textContent = 'No documents match your search.';
      list.appendChild(p);
    }
  }
  function hashCode(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
  $('#search').addEventListener('input', renderHome);

  /* ---------------- capture ---------------- */
  function startCamera(docId) { state.docId = docId; ensureCV().catch(() => {}); $('#file-camera').click(); }
  function startPhotos(docId) { state.docId = docId; ensureCV().catch(() => {}); $('#file-photos').click(); }
  function onFiles(e) {
    const files = [...e.target.files].filter(f => !f.type || f.type.startsWith('image/'));
    e.target.value = '';
    if (!files.length) return;
    state.queue = files; state.queueTotal = files.length;
    processNext();
  }
  $('#file-camera').addEventListener('change', onFiles);
  $('#file-photos').addEventListener('change', onFiles);

  async function processNext() {
    const file = state.queue.shift();
    if (!file) return;
    try {
      state.source = await loadImageFile(file);
    } catch (err) { toast('⚠️ ' + err.message); return processNext(); }
    const { width: w, height: h } = state.source, m = 0.05;
    state.corners = [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
    state.cornersTouched = false;
    const done = state.queueTotal - state.queue.length;
    const pill = $('#crop-queue');
    pill.textContent = done + ' / ' + state.queueTotal;
    pill.classList.toggle('hidden', state.queueTotal < 2);
    show('crop');
    requestAnimationFrame(() => { layoutCrop(); autoDetect(false); });
  }

  /* ---------------- crop screen ---------------- */
  let cropView = null, drag = null, statusTimer = null;
  const stage = $('#crop-stage');

  (function buildCropSvg() {
    $('#crop-svg').innerHTML =
      '<defs><linearGradient id="cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/>' +
      '<stop offset=".5" stop-color="#f472b6"/><stop offset="1" stop-color="#fb923c"/></linearGradient></defs>' +
      '<path id="crop-shade" fill="rgba(8,4,20,.6)" fill-rule="evenodd"/>' +
      '<polygon id="crop-poly" fill="rgba(244,114,182,.12)" stroke="url(#cg)" stroke-width="3" stroke-linejoin="round"/>' +
      HANDLE_COLORS.map((c, i) => `<g class="handle" id="h${i}"><circle r="22" fill="${c}" opacity=".28"/>` +
        `<circle r="10" fill="${c}" stroke="#fff" stroke-width="3"/></g>`).join('');
  })();

  function layoutCrop() {
    const src = state.source; if (!src) return;
    const W = stage.clientWidth, H = stage.clientHeight, pad = 26;
    const s = Math.min((W - pad * 2) / src.width, (H - pad * 2) / src.height);
    const dw = src.width * s, dh = src.height * s, ox = (W - dw) / 2, oy = (H - dh) / 2;
    const c = $('#crop-canvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(dw * dpr); c.height = Math.round(dh * dpr);
    Object.assign(c.style, { width: dw + 'px', height: dh + 'px', left: ox + 'px', top: oy + 'px' });
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    cropView = { s, ox, oy, dw, dh };
    drawOverlay();
  }
  function drawOverlay() {
    const v = cropView; if (!v || !state.corners) return;
    const P = state.corners.map(([x, y]) => [v.ox + x * v.s, v.oy + y * v.s]);
    $('#crop-poly').setAttribute('points', P.map(p => p.join(',')).join(' '));
    $('#crop-shade').setAttribute('d',
      `M${v.ox},${v.oy}H${v.ox + v.dw}V${v.oy + v.dh}H${v.ox}Z M${P.map(p => p.join(',')).join(' L')}Z`);
    P.forEach((p, i) => $('#h' + i).setAttribute('transform', `translate(${p[0]},${p[1]})`));
  }
  function setStatus(msg, hideAfter) {
    const el = $('#detect-status');
    clearTimeout(statusTimer);
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg; el.classList.remove('hidden');
    if (hideAfter) statusTimer = setTimeout(() => el.classList.add('hidden'), hideAfter);
  }
  async function autoDetect(manual) {
    const token = ++state.cropToken;
    setStatus(cvPromise ? '✨ Finding edges…' : '✨ Loading edge finder…');
    try {
      const { cv } = await ensureCV();
      if (token !== state.cropToken || state.view !== 'crop') return;
      setStatus('✨ Finding edges…');
      await wait(20);
      const small = downscale(state.source, 640), sc = state.source.width / small.width;
      const q = detectQuad(cv, small);
      if (token !== state.cropToken) return;
      if (q) {
        if (manual || !state.cornersTouched) {
          state.corners = orderCorners(q.map(([x, y]) => [x * sc, y * sc]));
          drawOverlay();
        }
        setStatus('✅ Document found', 1400);
      } else {
        setStatus('🤔 Edges not found. Drag the dots', 2400);
      }
    } catch {
      if (token === state.cropToken) setStatus('⚠️ Auto-detect needs internet the first time', 2600);
    }
  }

  function stagePoint(e) { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  stage.addEventListener('pointerdown', e => {
    if (!cropView || !state.corners) return;
    const [px, py] = stagePoint(e), v = cropView;
    let best = -1, bd = 60;
    state.corners.forEach(([x, y], i) => {
      const d = Math.hypot(v.ox + x * v.s - px, v.oy + y * v.s - py);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return;
    const [cx, cy] = state.corners[best];
    drag = { i: best, offX: v.ox + cx * v.s - px, offY: v.oy + cy * v.s - py };
    state.cornersTouched = true; state.cropToken++; setStatus('');
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    $('#loupe').classList.remove('hidden'); drawLoupe(best);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const [px, py] = stagePoint(e), v = cropView;
    state.corners[drag.i] = [
      clamp((px + drag.offX - v.ox) / v.s, 0, state.source.width),
      clamp((py + drag.offY - v.oy) / v.s, 0, state.source.height),
    ];
    drawOverlay(); drawLoupe(drag.i);
    e.preventDefault();
  });
  const endDrag = () => { drag = null; $('#loupe').classList.add('hidden'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  function drawLoupe(i) {
    const L = $('#loupe'), ctx = L.getContext('2d'), src = state.source, v = cropView;
    const [x, y] = state.corners[i];
    const side = 120 / (v.s * 3), scale = 240 / side;
    const sx0 = x - side / 2, sy0 = y - side / 2;
    const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0);
    const ix1 = Math.min(src.width, sx0 + side), iy1 = Math.min(src.height, sy0 + side);
    ctx.fillStyle = '#120c24'; ctx.fillRect(0, 0, 240, 240);
    if (ix1 > ix0 && iy1 > iy0) {
      ctx.drawImage(src, ix0, iy0, ix1 - ix0, iy1 - iy0,
        (ix0 - sx0) * scale, (iy0 - sy0) * scale, (ix1 - ix0) * scale, (iy1 - iy0) * scale);
    }
    ctx.strokeStyle = HANDLE_COLORS[i]; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(120, 70); ctx.lineTo(120, 170); ctx.moveTo(70, 120); ctx.lineTo(170, 120); ctx.stroke();
    const disp = v.ox + x * v.s;
    L.style.left = disp < stage.clientWidth / 2 ? (stage.clientWidth - 132) + 'px' : '12px';
  }

  $('#crop-auto').onclick = () => autoDetect(true);
  $('#crop-full').onclick = () => {
    state.cropToken++; setStatus('');
    const { width: w, height: h } = state.source;
    state.corners = [[0, 0], [w, 0], [w, h], [0, h]]; state.cornersTouched = true; drawOverlay();
  };
  $('#crop-rotate').onclick = () => {
    state.cropToken++; setStatus('');
    const H = state.source.height;
    state.source = rotateCanvas(state.source);
    state.corners = orderCorners(state.corners.map(([x, y]) => [H - y, x]));
    layoutCrop();
  };
  $('#crop-back').onclick = () => {
    state.queue = []; state.cropToken++; setStatus('');
    if (state.docId) openDoc(state.docId); else { show('home'); renderHome(); }
  };
  $('#crop-next').onclick = async () => {
    state.cropToken++;
    setStatus('🪄 Straightening…');
    await wait(30);
    try {
      state.warped = warp(state.source, orderCorners(state.corners));
    } catch (err) { setStatus('⚠️ ' + err.message, 2500); return; }
    setStatus('');
    show('filter');
    renderChips(); renderPreview();
  };
  window.addEventListener('resize', () => { if (state.view === 'crop') layoutCrop(); });

  /* ---------------- filter screen ---------------- */
  function renderChips() {
    const box = $('#filters'); box.textContent = '';
    const small = downscale(state.warped, 150);
    for (const [key, label] of FILTERS) {
      const b = document.createElement('button');
      b.className = 'chip' + (key === state.filter ? ' on' : '');
      b.dataset.key = key;
      b.appendChild(applyFilter(small, key));
      b.append(label);
      b.onclick = () => {
        state.filter = key; lsSet('filter', key);
        box.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.key === key));
        renderPreview();
      };
      box.appendChild(b);
    }
  }
  let previewToken = 0;
  async function renderPreview() {
    const token = ++previewToken;
    $('#filter-busy').classList.remove('hidden');
    await wait(30);
    if (token !== previewToken) return;
    const out = applyFilter(downscale(state.warped, 1400), state.filter);
    const c = $('#filter-canvas');
    c.width = out.width; c.height = out.height; c.getContext('2d').drawImage(out, 0, 0);
    $('#filter-busy').classList.add('hidden');
  }
  $('#filter-back').onclick = () => { show('crop'); requestAnimationFrame(layoutCrop); };
  $('#filter-rotate').onclick = () => { state.warped = rotateCanvas(state.warped); renderChips(); renderPreview(); };
  $('#filter-retake').onclick = () => { state.queue = []; startCamera(state.docId); };
  $('#filter-save').onclick = async () => {
    const btn = $('#filter-save');
    btn.disabled = true; $('#filter-busy').classList.remove('hidden');
    await wait(30);
    try {
      const out = applyFilter(state.warped, state.filter);
      const blob = await toBlob(out, 'image/jpeg', 0.86);
      const thumb = await toBlob(downscale(out, 360), 'image/jpeg', 0.72);
      let doc = state.docId ? await DB.get('docs', state.docId) : null;
      if (!doc) doc = { id: uid(), name: defaultName(), created: Date.now(), pages: [], size: 0 };
      const id = uid();
      await DB.put('pages', { id, w: out.width, h: out.height, size: blob.size, data: await blob.arrayBuffer() });
      await DB.put('thumbs', { id, data: await thumb.arrayBuffer() });
      doc.pages.push(id); doc.updated = Date.now(); doc.size = (doc.size || 0) + blob.size;
      await DB.put('docs', doc);
      state.docId = doc.id;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast('🎉 Page ' + doc.pages.length + ' saved');
      if (state.queue.length) processNext(); else openDoc(doc.id);
    } catch (err) {
      toast('⚠️ Could not save: ' + err.message, 3500);
    } finally {
      btn.disabled = false; $('#filter-busy').classList.add('hidden');
    }
  };

  /* ---------------- document screen ---------------- */
  async function openDoc(id) {
    const doc = await DB.get('docs', id);
    if (!doc) { show('home'); return renderHome(); }
    state.docId = id;
    $('#doc-title').textContent = doc.name;
    $('#doc-meta').textContent = `${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'} · ${fmtSize(doc.size || 0)} · ${fmtDate(doc.updated)}`;
    const grid = $('#page-grid'); grid.textContent = '';
    doc.pages.forEach((pid, i) => {
      const card = document.createElement('button');
      card.className = 'page-card'; card.style.animationDelay = Math.min(i * 35, 350) + 'ms';
      const img = document.createElement('img'); img.alt = 'Page ' + (i + 1);
      const num = document.createElement('span'); num.className = 'page-num'; num.textContent = i + 1;
      card.append(img, num);
      card.onclick = () => openPage(i);
      grid.appendChild(card);
      thumbUrl(pid).then(u => { if (u) img.src = u; });
    });
    show('doc');
  }
  $('#doc-back').onclick = () => { state.docId = null; show('home'); renderHome(); };
  $('#doc-add').onclick = () => startCamera(state.docId);
  $('#doc-import').onclick = () => startPhotos(state.docId);
  const rename = async () => {
    const doc = await DB.get('docs', state.docId); if (!doc) return;
    const name = prompt('Document name', doc.name);
    if (name && name.trim()) { doc.name = name.trim().slice(0, 80); await DB.put('docs', doc); openDoc(doc.id); }
  };
  $('#doc-rename').onclick = rename;
  $('#doc-title').onclick = rename;
  $('#doc-delete').onclick = async () => {
    const doc = await DB.get('docs', state.docId); if (!doc) return;
    if (!confirm(`Delete "${doc.name}" and its ${doc.pages.length} page(s)? This cannot be undone.`)) return;
    for (const p of doc.pages) await removePage(p);
    await DB.del('docs', doc.id);
    state.docId = null; toast('🗑️ Document deleted'); show('home'); renderHome();
  };
  $('#doc-pdf').onclick = async () => {
    const doc = await DB.get('docs', state.docId); if (!doc || !doc.pages.length) return;
    toast('📕 Making PDF…', 8000);
    try {
      await loadScript(CDN.jspdf);
      const { jsPDF } = window.jspdf;
      let pdf = null;
      for (const pid of doc.pages) {
        const p = await DB.get('pages', pid); if (!p) continue;
        const wmm = 210, hmm = Math.round(210 * p.h / p.w * 10) / 10, ori = wmm > hmm ? 'l' : 'p';
        if (!pdf) pdf = new jsPDF({ unit: 'mm', format: [wmm, hmm], orientation: ori, compress: true });
        else pdf.addPage([wmm, hmm], ori);
        pdf.addImage(new Uint8Array(p.data), 'JPEG', 0, 0, wmm, hmm, undefined, 'FAST');
      }
      pdf.setProperties({ title: doc.name, creator: 'Prism Scan' });
      state.exportBlob = pdf.output('blob');
      state.exportName = safeName(doc.name) + '.pdf';
      $('#export-title').textContent = 'PDF ready';
      $('#export-info').textContent = `${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'} · ${fmtSize(state.exportBlob.size)}`;
      $('#toast').classList.remove('show');
      openSheet('sheet-export');
    } catch (err) { toast('⚠️ ' + err.message, 3500); }
  };
  $('#doc-ocr').onclick = async () => {
    const doc = await DB.get('docs', state.docId); if (!doc) return;
    openOcr(doc.pages);
  };
  const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'scan';

  async function shareFile(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  $('#export-share').onclick = () => state.exportBlob && shareFile(state.exportBlob, state.exportName);
  $('#export-open').onclick = () => {
    if (!state.exportBlob) return;
    if (!state.exportUrl) state.exportUrl = URL.createObjectURL(state.exportBlob);
    window.open(state.exportUrl, '_blank');
  };

  /* ---------------- single page ---------------- */
  async function openPage(i) {
    const doc = await DB.get('docs', state.docId); if (!doc || !doc.pages[i]) return;
    state.pageIdx = i;
    $('#page-label').textContent = `Page ${i + 1} of ${doc.pages.length}`;
    $('#page-left').disabled = i === 0;
    $('#page-right').disabled = i === doc.pages.length - 1;
    $('#page-left').style.opacity = i === 0 ? .4 : 1;
    $('#page-right').style.opacity = i === doc.pages.length - 1 ? .4 : 1;
    const r = await pageBlob(doc.pages[i]); if (!r) return;
    state.pageBlob = r.blob;
    if (state.pageUrl) URL.revokeObjectURL(state.pageUrl);
    state.pageUrl = URL.createObjectURL(r.blob);
    $('#page-img').src = state.pageUrl;
    openSheet('sheet-page');
  }
  async function movePage(delta) {
    const doc = await DB.get('docs', state.docId); const i = state.pageIdx, j = i + delta;
    if (!doc || j < 0 || j >= doc.pages.length) return;
    [doc.pages[i], doc.pages[j]] = [doc.pages[j], doc.pages[i]];
    doc.updated = Date.now(); await DB.put('docs', doc);
    await openDoc(doc.id); openPage(j);
  }
  $('#page-left').onclick = () => movePage(-1);
  $('#page-right').onclick = () => movePage(1);
  $('#page-share').onclick = async () => {
    const doc = await DB.get('docs', state.docId);
    if (state.pageBlob) shareFile(state.pageBlob, `${safeName(doc ? doc.name : 'scan')}-p${state.pageIdx + 1}.jpg`);
  };
  $('#page-ocr').onclick = async () => {
    const doc = await DB.get('docs', state.docId);
    if (doc && doc.pages[state.pageIdx]) openOcr([doc.pages[state.pageIdx]]);
  };
  $('#page-delete').onclick = async () => {
    const doc = await DB.get('docs', state.docId); if (!doc) return;
    if (!confirm('Delete this page? This cannot be undone.')) return;
    const [pid] = doc.pages.splice(state.pageIdx, 1);
    const p = await DB.get('pages', pid);
    doc.size = Math.max(0, (doc.size || 0) - (p ? p.size : 0));
    await removePage(pid);
    closeSheet($('#sheet-page'));
    if (!doc.pages.length) {
      await DB.del('docs', doc.id); state.docId = null;
      toast('🗑️ Last page deleted, document removed'); show('home'); return renderHome();
    }
    doc.updated = Date.now(); await DB.put('docs', doc);
    toast('🗑️ Page deleted'); openDoc(doc.id);
  };

  /* ---------------- signatures ---------------- */
  const sign = { pageId: null, page: null, sigId: null, sigData: null, box: null, view: null, urls: [] };
  function forgetThumb(id) { const u = thumbUrls.get(id); if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); } }

  async function openSign() {
    const doc = await DB.get('docs', state.docId); if (!doc) return;
    const pid = doc.pages[state.pageIdx]; const page = await DB.get('pages', pid); if (!page) return;
    Object.assign(sign, { pageId: pid, page, box: null });
    $('#sign-revert').style.visibility = page.orig ? 'visible' : 'hidden';
    $('#sign-page').src = state.pageUrl;
    $('#sign-box').classList.add('hidden'); $('#sign-hint').classList.remove('hidden');
    $('#sign-apply').disabled = true;
    openSheet('sheet-sign');
    layoutSign(); // reading clientWidth forces layout, so no frame wait is needed
    const sigs = await renderSigList();
    if (!sigs.length) openPad();
    else if (sign.sigId) { const s = sigs.find(x => x.id === sign.sigId); if (s) useSig(s, sign.urls[sigs.indexOf(s)]); }
  }
  function layoutSign() {
    const st = $('#sign-stage'), W = st.clientWidth, H = st.clientHeight, pad = 18, p = sign.page;
    if (!p || !W) return;
    const s = Math.min((W - pad * 2) / p.w, (H - pad * 2) / p.h), dw = p.w * s, dh = p.h * s;
    sign.view = { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
    Object.assign($('#sign-page').style, { left: sign.view.ox + 'px', top: sign.view.oy + 'px', width: dw + 'px', height: dh + 'px' });
    placeBox();
  }
  function fitBox(b) {
    const v = sign.view;
    const maxW = Math.min(1, v.dh / (v.dw * b.ratio));
    b.w = clamp(b.w, 0.08, maxW);
    const hFrac = b.w * v.dw * b.ratio / v.dh;
    b.x = clamp(b.x, 0, 1 - b.w); b.y = clamp(b.y, 0, 1 - hFrac);
    return b;
  }
  function placeBox() {
    const b = sign.box, v = sign.view; if (!b || !v) return;
    const w = b.w * v.dw;
    Object.assign($('#sign-box').style, { left: v.ox + b.x * v.dw + 'px', top: v.oy + b.y * v.dh + 'px', width: w + 'px', height: w * b.ratio + 'px' });
  }
  async function renderSigList() {
    sign.urls.forEach(u => URL.revokeObjectURL(u)); sign.urls = [];
    const sigs = (await DB.all('sigs')).sort((a, b) => b.created - a.created);
    const list = $('#sig-list'); list.textContent = '';
    const add = document.createElement('button');
    add.className = 'sig-tile add'; add.textContent = '＋ New'; add.onclick = openPad;
    list.appendChild(add);
    for (const s of sigs) {
      const url = URL.createObjectURL(new Blob([s.data], { type: 'image/png' })); sign.urls.push(url);
      const t = document.createElement('button');
      t.className = 'sig-tile' + (s.id === sign.sigId ? ' on' : ''); t.dataset.id = s.id;
      const img = document.createElement('img'); img.src = url; img.alt = 'Saved signature'; t.appendChild(img);
      const del = document.createElement('span');
      del.className = 'sig-del'; del.textContent = '✕'; del.setAttribute('role', 'button'); del.setAttribute('aria-label', 'Delete signature');
      del.onclick = async e => {
        e.stopPropagation();
        if (!confirm('Delete this saved signature?')) return;
        await DB.del('sigs', s.id);
        if (sign.sigId === s.id) { sign.sigId = null; sign.box = null; $('#sign-box').classList.add('hidden'); $('#sign-apply').disabled = true; $('#sign-hint').classList.remove('hidden'); }
        renderSigList();
      };
      t.appendChild(del);
      t.onclick = () => useSig(s, url);
      list.appendChild(t);
    }
    return sigs;
  }
  function useSig(s, url) {
    sign.sigId = s.id; sign.sigData = s.data;
    document.querySelectorAll('#sig-list .sig-tile').forEach(t => t.classList.toggle('on', t.dataset.id === s.id));
    $('#sign-img').src = url;
    const ratio = s.h / s.w;
    if (sign.box) sign.box.ratio = ratio;
    else {
      const w = 0.38, hFrac = w * sign.view.dw * ratio / sign.view.dh;
      sign.box = { x: 1 - w - 0.07, y: 0.86 - hFrac, w, ratio };
    }
    fitBox(sign.box);
    $('#sign-box').classList.remove('hidden'); $('#sign-hint').classList.add('hidden');
    $('#sign-apply').disabled = false;
    placeBox();
  }
  (function signDrag() {
    const el = $('#sign-box'); let d = null;
    el.addEventListener('pointerdown', e => {
      if (!sign.box) return;
      d = { resize: e.target.id === 'sign-resize', sx: e.clientX, sy: e.clientY, b: { ...sign.box } };
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
      if (!d) return;
      const v = sign.view, dx = (e.clientX - d.sx) / v.dw, dy = (e.clientY - d.sy) / v.dh, b = sign.box;
      if (d.resize) b.w = d.b.w + dx; else { b.x = d.b.x + dx; b.y = d.b.y + dy; }
      fitBox(b); placeBox();
    });
    const end = () => { d = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  })();

  async function savePageImage(page, doc, canvas, keepOriginal) {
    const blob = await toBlob(canvas, 'image/jpeg', 0.9);
    const thumb = await toBlob(downscale(canvas, 360), 'image/jpeg', 0.72);
    if (keepOriginal && !page.orig) { page.orig = page.data; page.origSize = page.size; }
    const old = page.size;
    page.data = await blob.arrayBuffer(); page.size = blob.size;
    await DB.put('pages', page);
    await DB.put('thumbs', { id: page.id, data: await thumb.arrayBuffer() });
    forgetThumb(page.id);
    doc.size = Math.max(0, (doc.size || 0) - old + blob.size); doc.updated = Date.now();
    await DB.put('docs', doc);
  }
  $('#sign-apply').onclick = async () => {
    if (!sign.box || !sign.sigData) return;
    const btn = $('#sign-apply'); btn.disabled = true;
    try {
      const page = await DB.get('pages', sign.pageId), doc = await DB.get('docs', state.docId);
      const base = await loadImageFile(new Blob([page.data], { type: 'image/jpeg' }));
      const sig = await loadImageFile(new Blob([sign.sigData], { type: 'image/png' }));
      const W = base.width, H = base.height, b = sign.box, x = base.getContext('2d'), w = b.w * W;
      x.globalCompositeOperation = 'multiply';
      x.drawImage(sig, b.x * W, b.y * H, w, w * b.ratio);
      x.globalCompositeOperation = 'source-over';
      await savePageImage(page, doc, base, true);
      closeSheet($('#sheet-sign'));
      toast('✍️ Page signed');
      await openDoc(doc.id); openPage(state.pageIdx);
    } catch (err) { toast('⚠️ ' + err.message, 3500); }
    finally { btn.disabled = false; }
  };
  $('#sign-revert').onclick = async () => {
    const page = await DB.get('pages', sign.pageId); if (!page || !page.orig) return;
    if (!confirm('Remove all signatures from this page and restore the original scan?')) return;
    const doc = await DB.get('docs', state.docId);
    // put the untouched original bytes back (no re-compression), and rebuild the thumbnail
    const original = await loadImageFile(new Blob([page.orig], { type: 'image/jpeg' }));
    const thumb = await toBlob(downscale(original, 360), 'image/jpeg', 0.72);
    const old = page.size;
    page.data = page.orig; page.size = page.origSize || page.orig.byteLength;
    delete page.orig; delete page.origSize;
    await DB.put('pages', page);
    await DB.put('thumbs', { id: page.id, data: await thumb.arrayBuffer() });
    forgetThumb(page.id);
    doc.size = Math.max(0, (doc.size || 0) - old + page.size); doc.updated = Date.now();
    await DB.put('docs', doc);
    closeSheet($('#sheet-sign'));
    toast('↺ Original page restored');
    await openDoc(doc.id); openPage(state.pageIdx);
  };
  $('#page-sign').onclick = openSign;
  $('#sign-new').onclick = () => openPad();
  window.addEventListener('resize', () => { if (!$('#sheet-sign').classList.contains('hidden')) layoutSign(); });

  /* signature drawing pad */
  const pad = { ctx: null, ink: lsGet('ink') || '#111827', drawing: false, pts: [], w: 0, dirty: false, dpr: 1 };
  function openPad() {
    openSheet('sheet-pad');
    document.querySelectorAll('#inks .ink').forEach(b => b.classList.toggle('on', b.dataset.ink === pad.ink));
    const c = $('#pad'), r = c.getBoundingClientRect();
    pad.dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(r.width * pad.dpr); c.height = Math.round(r.height * pad.dpr);
    pad.ctx = c.getContext('2d', { willReadFrequently: true });
    clearPad();
  }
  function clearPad() {
    const c = $('#pad'); pad.ctx.clearRect(0, 0, c.width, c.height);
    pad.dirty = false; $('#pad-ph').classList.remove('hidden');
  }
  (function padEvents() {
    const c = $('#pad');
    const pt = e => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.dpr, y: (e.clientY - r.top) * pad.dpr, t: e.timeStamp }; };
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    function stroke(from, ctrl, to, w) {
      const x = pad.ctx;
      x.strokeStyle = pad.ink; x.lineWidth = w; x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath(); x.moveTo(from.x, from.y);
      if (ctrl) x.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y); else x.lineTo(to.x, to.y);
      x.stroke();
    }
    function addPoint(p) {
      const pts = pad.pts, prev = pts[pts.length - 1];
      const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (dist < 1.2 * pad.dpr) return;
      const v = dist / pad.dpr / Math.max(1, p.t - prev.t);           // CSS px per ms
      const target = clamp(4.2 - v * 1.3, 1.5, 4.2) * pad.dpr;        // faster stroke = thinner line
      pad.w = pad.w * 0.65 + target * 0.35;
      pts.push(p);
      if (pts.length === 2) stroke(prev, null, mid(prev, p), pad.w);
      else stroke(mid(pts[pts.length - 3], prev), prev, mid(prev, p), pad.w);
    }
    c.addEventListener('pointerdown', e => {
      if (!pad.ctx) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const p = pt(e);
      pad.drawing = true; pad.pts = [p]; pad.w = 3.2 * pad.dpr; pad.dirty = true;
      pad.ctx.fillStyle = pad.ink; pad.ctx.beginPath(); pad.ctx.arc(p.x, p.y, pad.w / 2, 0, Math.PI * 2); pad.ctx.fill();
      $('#pad-ph').classList.add('hidden');
      e.preventDefault();
    });
    c.addEventListener('pointermove', e => {
      if (!pad.drawing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      (evs.length ? evs : [e]).forEach(ev => addPoint(pt(ev)));
      e.preventDefault();
    });
    const end = e => {
      if (!pad.drawing) return;
      pad.drawing = false;
      const pts = pad.pts;
      if (pts.length > 1) { const a = pts[pts.length - 2], b = pts[pts.length - 1]; stroke(mid(a, b), null, b, pad.w); }
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  })();
  document.querySelectorAll('#inks .ink').forEach(b => b.addEventListener('click', () => {
    pad.ink = b.dataset.ink; lsSet('ink', pad.ink);
    document.querySelectorAll('#inks .ink').forEach(x => x.classList.toggle('on', x === b));
    if (pad.dirty) { // recolour what is already drawn
      const c = $('#pad'), x = pad.ctx;
      x.globalCompositeOperation = 'source-in'; x.fillStyle = pad.ink; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-over';
    }
  }));
  $('#pad-clear').onclick = clearPad;
  $('#pad-save').onclick = async () => {
    if (!pad.dirty) { toast('✍️ Draw your signature first'); return; }
    const c = $('#pad'), w = c.width, h = c.height, data = pad.ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) { toast('✍️ Draw your signature first'); return; }
    const m = Math.round(6 * pad.dpr);
    minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(w - 1, maxX + m); maxY = Math.min(h - 1, maxY + m);
    const cw = maxX - minX + 1, ch = maxY - minY + 1, out = makeCanvas(cw, ch);
    out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
    const blob = await toBlob(out, 'image/png');
    const rec = { id: uid(), data: await blob.arrayBuffer(), w: cw, h: ch, created: Date.now() };
    await DB.put('sigs', rec);
    closeSheet($('#sheet-pad'));
    toast('✅ Signature saved');
    if (!$('#sheet-sign').classList.contains('hidden')) { await renderSigList(); useSig(rec, sign.urls[0]); }
  };

  /* ---------------- OCR ---------------- */
  function openOcr(ids) {
    state.ocrIds = ids.slice(); state.ocrText = '';
    $('#ocr-text').value = '';
    $('#ocr-progress').classList.add('hidden');
    const saved = lsGet('ocrLang'); if (saved) $('#ocr-lang').value = saved;
    $('#ocr-run').disabled = false;
    openSheet('sheet-ocr');
  }
  function ocrProgress(frac, label) {
    const p = $('#ocr-progress'); p.classList.remove('hidden');
    p.firstElementChild.style.width = Math.round(frac * 100) + '%';
    p.lastElementChild.textContent = label;
  }
  $('#ocr-run').onclick = async () => {
    const lang = $('#ocr-lang').value; lsSet('ocrLang', lang);
    const btn = $('#ocr-run'); btn.disabled = true;
    const total = state.ocrIds.length; let current = 0;
    ocrProgress(0, 'Downloading text reader…');
    let worker = null;
    try {
      await loadScript(CDN.tesseract);
      worker = await window.Tesseract.createWorker(lang, 1, {
        logger: m => {
          if (m.status === 'recognizing text') ocrProgress((current + m.progress) / total, `Reading page ${current + 1} of ${total}… ${Math.round(m.progress * 100)}%`);
          else if (m.status) ocrProgress(0.02, m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…');
        },
      });
      const parts = [];
      for (; current < total; current++) {
        const r = await pageBlob(state.ocrIds[current]); if (!r) continue;
        const { data } = await worker.recognize(r.blob);
        parts.push((total > 1 ? `— Page ${current + 1} —\n` : '') + data.text.trim());
        $('#ocr-text').value = parts.join('\n\n');
      }
      state.ocrText = parts.join('\n\n');
      ocrProgress(1, state.ocrText.trim() ? '✅ Done' : '🤔 No text found');
    } catch (err) {
      ocrProgress(0, '⚠️ ' + (err && err.message ? err.message : 'Text reading failed'));
    } finally {
      if (worker) worker.terminate().catch(() => {});
      btn.disabled = false;
    }
  };
  $('#ocr-copy').onclick = async () => {
    const t = $('#ocr-text').value; if (!t) return;
    try { await navigator.clipboard.writeText(t); toast('📋 Copied'); }
    catch { $('#ocr-text').removeAttribute('readonly'); $('#ocr-text').select(); document.execCommand('copy'); $('#ocr-text').setAttribute('readonly', ''); toast('📋 Copied'); }
  };
  $('#ocr-share').onclick = () => {
    const t = $('#ocr-text').value; if (!t) return;
    if (navigator.share) navigator.share({ text: t }).catch(() => {});
    else $('#ocr-copy').click();
  };

  /* ---------------- home buttons, install hint, offline ---------------- */
  $('#btn-scan').onclick = () => startCamera(null);
  $('#btn-import').onclick = () => startPhotos(null);
  $('#btn-help').onclick = () => openSheet('sheet-help');

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !standalone && !lsGet('hideInstall')) $('#install-banner').classList.remove('hidden');
  $('#install-close').onclick = () => { $('#install-banner').classList.add('hidden'); lsSet('hideInstall', '1'); };

  // Android / Chrome: one-tap install using the browser's own install prompt
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    $('#tips-install').classList.remove('hidden');
    if (!lsGet('hideAndroidInstall')) $('#android-install').classList.remove('hidden');
  });
  async function doInstall() {
    if (!installPrompt) { openSheet('sheet-help'); return; }
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    installPrompt = null;
    $('#android-install').classList.add('hidden'); $('#tips-install').classList.add('hidden');
    if (outcome === 'accepted') toast('🎉 Installing Prism Scan…');
  }
  $('#android-install-btn').onclick = doInstall;
  $('#tips-install').onclick = () => { closeSheet($('#sheet-help')); doInstall(); };
  $('#android-install-close').onclick = () => { $('#android-install').classList.add('hidden'); lsSet('hideAndroidInstall', '1'); };
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('#android-install').classList.add('hidden'); $('#tips-install').classList.add('hidden');
    toast('🎉 Prism Scan installed');
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  renderHome().catch(err => toast('⚠️ Storage unavailable: ' + err.message, 4000));

  // exposed for automated testing only
  window.__prism = { warp, applyFilter, orderCorners, detectQuad, ensureCV, homography };
})();
