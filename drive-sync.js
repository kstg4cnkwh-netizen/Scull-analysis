/* ════════════════════════════════════════
   SCULL METRICS — GOOGLE DRIVE SYNC  v1.0
   Strategy: localStorage primary, Drive async backup
   Auth: Google Identity Services (GIS) token client
════════════════════════════════════════ */

const DriveSync = (() => {
  const CLIENT_ID  = '729480414852-kko8e7bi3r38tcg2rf6iiupptagoegpc.apps.googleusercontent.com';
  const SCOPE      = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'ScullMetrics';
  const API        = 'https://www.googleapis.com/';

  let tokenClient  = null;
  let accessToken  = null;
  let tokenExpiry  = 0;
  let folderId     = null;
  let pendingResolve = null;
  let pendingReject  = null;

  // ── Init ────────────────────────────────────────────────────────────────
  // Call once on page load. Resolves when GIS is ready.
  function init() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) { _setup(); resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload  = () => { _setup(); resolve(); };
      s.onerror = () => reject(new Error('GIS script failed to load'));
      document.head.appendChild(s);
    });
  }

  function _setup() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          const err = new Error(resp.error_description || resp.error || 'Auth failed');
          if (pendingReject) { pendingReject(err); pendingReject = null; pendingResolve = null; }
          _updateUI(false);
          return;
        }
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        // Pre-warm folder lookup on fresh sign-in
        ensureFolder().catch(() => {});
        if (pendingResolve) { pendingResolve(accessToken); pendingResolve = null; pendingReject = null; }
        _updateUI(true);
      },
      error_callback: (err) => {
        // User closed the popup or network error
        if (pendingReject) { pendingReject(new Error(err.type || 'popup_closed')); pendingReject = null; pendingResolve = null; }
      }
    });
    // Restore login hint so returning users skip account picker
    const hint = localStorage.getItem('_drive_hint');
    if (hint) tokenClient.login_hint = hint;
    _updateUI(false);
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  // REPLACE the existing signIn() with:
async function signIn() {
  if (!tokenClient) await init();
  return new Promise((resolve, reject) => {
    if (isSignedIn()) { resolve(accessToken); return; }
    pendingResolve = resolve;
    pendingReject  = reject;
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });
}


  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiry = 0;
    folderId    = null;
    localStorage.removeItem('_drive_hint');
    _updateUI(false);
    toast('Drive unlinked');
  }

  function isSignedIn() {
    return !!accessToken && Date.now() < tokenExpiry;
  }

  // ── Drive REST helpers ──────────────────────────────────────────────────
  // REPLACE the existing _ensureToken() with:
async function _ensureToken() {
  if (!tokenClient) await init();
  if (!isSignedIn()) await signIn();
  if (!accessToken) throw new Error('Not authenticated');
}


  async function _req(method, path, { params, jsonBody } = {}) {
    await _ensureToken();
    let url = API + path;
    if (params) url += '?' + new URLSearchParams(params);
    const opts = {
      method,
      headers: { Authorization: 'Bearer ' + accessToken }
    };
    if (jsonBody !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(jsonBody);
    }
    const r = await fetch(url, opts);
    if (r.status === 401) { accessToken = null; throw new Error('Token expired — please re-link Drive'); }
    if (!r.ok) {
      const msg = await r.text().catch(() => r.status);
      throw new Error(`Drive API ${r.status}: ${msg}`);
    }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }

  // Multipart upload: metadata + JSON content in one request
  async function _multipart(method, path, meta, content) {
    await _ensureToken();
    const boundary = 'scull_' + Math.random().toString(36).slice(2);
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`,
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}`,
      `--${boundary}--`
    ].join('\r\n');
    const r = await fetch(`${API}upload/drive/v3/files${path}?uploadType=multipart`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => r.status);
      throw new Error(`Drive upload ${r.status}: ${msg}`);
    }
    return r.json();
  }

  // ── Folder ──────────────────────────────────────────────────────────────
  async function ensureFolder() {
    if (folderId) return folderId;
    const res = await _req('GET', 'drive/v3/files', {
      params: {
        q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive'
      }
    });
    if (res.files?.length) {
      folderId = res.files[0].id;
      return folderId;
    }
    const created = await _req('POST', 'drive/v3/files', {
      jsonBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }
    });
    folderId = created.id;
    return folderId;
  }

  // ── Session filename ────────────────────────────────────────────────────
  function _filename(session) {
    const d = new Date(session.startTime);
    const p = n => String(n).padStart(2, '0');
    return `RowSess_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
  }

  // ── Upload (create or update) ───────────────────────────────────────────
  async function upload(session) {
    await _ensureToken();
    const folder  = await ensureFolder();
    const name    = _filename(session);
    const content = JSON.stringify(session);

    // Check for existing file to decide create vs update
    const found = await _req('GET', 'drive/v3/files', {
      params: {
        q: `name='${name}' and '${folder}' in parents and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive'
      }
    });

    if (found.files?.length) {
      // Simple media update — no need to re-send metadata
      const fileId = found.files[0].id;
      await _ensureToken();
      const r = await fetch(`${API}upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: content
      });
      if (!r.ok) throw new Error(`Drive update ${r.status}`);
    } else {
      await _multipart('POST', '', { name, parents: [folder] }, content);
    }
  }

  // ── List sessions on Drive ──────────────────────────────────────────────
  async function list() {
    await _ensureToken();
    const folder = await ensureFolder();
    const res = await _req('GET', 'drive/v3/files', {
      params: {
        q: `'${folder}' in parents and name contains 'RowSess_' and trashed=false`,
        fields: 'files(id,name,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: '200'
      }
    });
    return res.files || [];
  }

  // ── Download a session by Drive file ID ─────────────────────────────────
  async function fetchSession(fileId) {
    const raw = await _req('GET', `drive/v3/files/${fileId}`, {
      params: { alt: 'media' }
    });
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  // ── UI helpers ──────────────────────────────────────────────────────────
  function _updateUI(signedIn) {
    const btn = document.getElementById('drive-btn');
    const dot = document.getElementById('drive-dot');
    if (btn) btn.textContent = signedIn ? '⊟ Drive' : '⊞ Drive';
    if (dot) { dot.style.display = signedIn ? 'inline-block' : 'none'; }
  }

    // ── Public ──────────────────────────────────────────────────────────────
  return { init, signIn, signOut, isSignedIn, upload, list, fetchSession, ensureFolder };
})();


/* ════════════════════════════════════════
   SYNC QUEUE
════════════════════════════════════════ */
function queuePending(sessionId) {
  const q = JSON.parse(localStorage.getItem('_drive_queue') || '[]');
  if (!q.includes(sessionId)) q.push(sessionId);
  localStorage.setItem('_drive_queue', JSON.stringify(q));
}

async function flushQueue() {
  if (!DriveSync.isSignedIn()) return;
  const q = JSON.parse(localStorage.getItem('_drive_queue') || '[]');
  if (!q.length) return;
  const sessions = loadSess();
  for (const id of q) {
    const s = sessions.find(s => s.id === id);
    if (!s) continue;
    try {
      await DriveSync.upload(s);
      const remaining = JSON.parse(localStorage.getItem('_drive_queue') || '[]');
      localStorage.setItem('_drive_queue', JSON.stringify(remaining.filter(x => x !== id)));
    } catch { break; }
  }
}

/* ════════════════════════════════════════
   DRIVE SYNC HOOKS
   Drop these replacements into scull.html
════════════════════════════════════════ */

// Replace existing addSess() with this version.
// localStorage write is synchronous (unchanged).
// Drive upload is fire-and-forget — never blocks the UI.
function addSess(s) {
  try {
    const a = loadSess();
    a.unshift(s);
    saveSess(a);
  } catch(e) { /* ignore */ }

  if (DriveSync.isSignedIn()) {
    DriveSync.upload(s)
      .then(() => toast('✓ Saved to Drive'))
      .catch(err => {
        console.warn('Drive upload failed:', err);
        toast('Drive sync failed — saved locally');
      });
  }
}

// Call this from the Drive button in settings/header.
function toggleDrive() {
  if (!DriveSync.isSignedIn()) {
    DriveSync.signIn()
      .then(() => toast('Drive linked'))
      .catch(() => toast('Drive sign-in cancelled'));
  } else {
    if (confirm('Unlink Google Drive?')) DriveSync.signOut();
  }
}


/* ════════════════════════════════════════
   ANALYSER — LOAD FROM DRIVE
   Converts raw session JSON → analyser format,
   bypassing CSV export entirely.
════════════════════════════════════════ */

// Converts a saved session object to the same shape parseCSV() returns.
function sessionToAnalyserFmt(s) {
  const sum = {
    start_time:             new Date(s.startTime).toISOString(),
    end_time:               new Date(s.endTime || s.startTime + (s.duration||0)*1000).toISOString(),
    duration_s:             s.duration,
    distance_m:             s.distance,
    stroke_count:           s.strokeCount,
    avg_pace_s_per_500m:    s.avgPace,
    avg_rate_spm:           s.avgRate,
    max_rate_spm:           s.maxRate,
    catch_peak_sess_ms3:    s.catchPeakSess,
    avg_catch_ms3:          s.avgCatch,
    avg_dps_m:              s.avgDPS,
    avg_run_loss_pct:       s.avgRunLoss,
    avg_efficiency_vmin_vmax: s.avgEfficiency,
    avg_impulse:            s.avgImpulse,
    avg_stroke_char_pct:    s.avgChar,
    avg_catch_consistency_stdev: s.avgConsistency,
    detected_axis:          s.detectedAxis,
    cal_noise_floor_ms2:    s.calNoiseFloor,
    cal_jerk_thresh_ms3:    s.calThresh,
  };

  const t0 = s.startTime;
  const strokes = (s.strokes || []).map((r, i) => ({
    n:           i + 1,
    ms:          r.t,
    elapsed:     (r.t - t0) / 1000,
    jerk:        r.catchPeak,
    schar:       r.char,
    rate:        r.rate,
    pace:        r.pace,
    dist:        r.dist,
    dps:         r.dps,
    rloss:       r.runLossPct,
    impulse:     r.driveImpulse,
    consistency: r.catchConsistency,
    runeff:      r.runEfficiency,
    rdi:         r.rdi,
  }));

  const hr = (s.hrTrace || []).map(h => ({
    ts: new Date(h.t).toISOString(),
    bpm: h.hr
  }));

  const laps = (s.laps || []).map(l => ({
    lap:              l.n,
    distance_m:       l.dist,
    time_s:           l.time,
    pace_s_per_500m:  l.pace,
    stroke_rate_spm:  l.rate,
  }));

  const glaps = (s.garminLaps || []).map(l => ({
    lap:              l.n,
    distance_m:       l.dist,
    time_s:           l.time,
    pace_s_per_500m:  l.pace,
    avg_hr_bpm:       l.avgHr,
    max_hr_bpm:       l.maxHr,
    calories:         l.cal,
    strokes:          l.garminStrokes,
    avg_spm:          l.garminAvgSpm,
    avg_stroke_dist_m: l.avgStrokeDist,
  }));

  return { sum, strokes, hr, laps, glaps };
}

// Call from analyser "Load from Drive" button.
// Renders a session picker, then loads the selected session.
async function loadFromDrive() {
  try {
    if (!DriveSync.isSignedIn()) {
      toast('Signing in to Drive…');
      await DriveSync.signIn();
    }
    toast('Loading session list…');
    const files = await DriveSync.list();
    if (!files.length) { toast('No sessions found on Drive'); return; }

    // Build a simple modal picker
    _showDrivePicker(files, async (fileId, fileName) => {
      toast('Loading ' + fileName + '…');
      try {
        const session = await DriveSync.fetchSession(fileId);
        const data    = sessionToAnalyserFmt(session);
        // Hand off to whatever the analyser uses after parseCSV()
        // Replace renderAnalysis with your actual analyser render function
        renderAnalysis(data, fileName);
      } catch(err) {
        toast('Load failed: ' + err.message);
      }
    });
  } catch(err) {
    if (err.message !== 'popup_closed') toast('Drive error: ' + err.message);
  }
}

function _showDrivePicker(files, onSelect) {
  // Remove any existing picker
  document.getElementById('_drive_picker')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_drive_picker';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.72);
    display:flex;align-items:center;justify-content:center;z-index:9999;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    background:#1a1a2e;border:1px solid #334;border-radius:10px;
    padding:18px;max-width:420px;width:92%;max-height:80vh;
    overflow-y:auto;color:#e0e0e0;font-family:monospace;
  `;

  const title = document.createElement('div');
  title.textContent = 'Drive Sessions';
  title.style.cssText = 'font-size:1rem;font-weight:700;margin-bottom:12px;color:#7ec8e3;';
  panel.appendChild(title);

  files.forEach(f => {
    // Parse display name from filename: RowSess_2026-04-30_0630.json
    const label = f.name.replace('RowSess_','').replace('.json','').replace('_',' ');
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      display:block;width:100%;text-align:left;padding:9px 12px;
      margin-bottom:6px;background:#252540;border:1px solid #334;
      border-radius:6px;color:#e0e0e0;font-family:monospace;
      font-size:.85rem;cursor:pointer;
    `;
    btn.onmouseenter = () => btn.style.background = '#2e2e58';
    btn.onmouseleave = () => btn.style.background = '#252540';
    btn.onclick = () => { overlay.remove(); onSelect(f.id, label); };
    panel.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = `
    display:block;width:100%;padding:8px;margin-top:8px;
    background:transparent;border:1px solid #556;border-radius:6px;
    color:#888;cursor:pointer;font-family:monospace;
  `;
  cancel.onclick = () => overlay.remove();
  panel.appendChild(cancel);

  overlay.appendChild(panel);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}


/* ════════════════════════════════════════
   INSERTION GUIDE
════════════════════════════════════════ */
/*

1. SCRIPT TAG — add before </body> in scull.html AND analyser.html:

   <script src="drive-sync.js"></script>

   OR inline the entire file contents into each HTML file.


2. INIT — in your DOMContentLoaded / app init block:

   DriveSync.init().catch(console.warn);


3. DRIVE BUTTON HTML — add wherever suits (settings panel, header):

   <button id="drive-btn" onclick="toggleDrive()">⊞ Drive</button>
   <span id="drive-dot" style="display:none;width:7px;height:7px;
     border-radius:50%;background:#27ae60;display:inline-block;margin-left:4px;"></span>

   The button label auto-toggles between "⊞ Drive" and "⊟ Drive".
   The dot goes green when linked.


4. addSess() — replace the existing function with the one above.
   No other changes to saveSess() / loadSess() needed.


5. ANALYSER — add a "Load from Drive" button alongside the CSV import:

   <button onclick="loadFromDrive()">⊞ Load from Drive</button>

   Then ensure renderAnalysis(data, label) is whatever your analyser calls
   after parseCSV() returns — just swap parseCSV(text) for sessionToAnalyserFmt(session).


6. GOOGLE CLOUD CONSOLE — confirm these are set:
   Authorised JavaScript origins:
     https://kstg4cnkwh-netizen.github.io
   Authorised redirect URIs:
     (none needed for implicit/token flow)

*/
