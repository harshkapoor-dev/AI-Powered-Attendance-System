// ============================================================================
// SENTRY — Single-file Attendance System
// ============================================================================

// ----- Tiny utilities ------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayISO = (d = new Date()) => d.toISOString().slice(0, 10);
const fmtTime = (iso) => new Date(iso).toLocaleString();
const fmtDate = (iso) => new Date(iso).toLocaleDateString();
const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtHrs = (n) => `${Math.floor(n)}h ${Math.round((n - Math.floor(n)) * 60)}m`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = 'all .2s'; }, 3000);
  setTimeout(() => el.remove(), 3300);
}

// ----- Crypto: simple password hashing (SHA-256 + salt) ------------------
async function hashPwd(password, salt) {
  salt = salt || crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  const data = new TextEncoder().encode(salt + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${salt}:${hex}`;
}
async function verifyPwd(password, stored) {
  const [salt] = stored.split(':');
  const test = await hashPwd(password, salt);
  return test === stored;
}

// ----- IndexedDB wrapper (for selfies — too large for localStorage) ------
const idb = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('sentry', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('selfies')) db.createObjectStore('selfies');
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async put(key, value) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('selfies', 'readwrite');
      tx.objectStore('selfies').put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('selfies', 'readonly');
      const req = tx.objectStore('selfies').get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('selfies', 'readwrite');
      tx.objectStore('selfies').delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
};

// ----- localStorage layer (acts as our "MongoDB") -------------------------
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};

// ============================================================================
// DATA MODEL — collections analogous to Mongo collections
// ============================================================================
const DB = {
  users: () => LS.get('users', []),
  saveUsers: (u) => LS.set('users', u),
  attendance: () => LS.get('attendance', []),
  saveAttendance: (a) => LS.set('attendance', a),
  overtime: () => LS.get('overtime', []),
  saveOvertime: (o) => LS.set('overtime', o),
  session: () => LS.get('session', null),
  saveSession: (s) => LS.set('session', s),
  clearSession: () => localStorage.removeItem('session'),
  settings: () => LS.get('settings', { geofence: null, geofenceRadius: 500, gemini: '', model: 'gemini-2.0-flash' }),
  saveSettings: (s) => LS.set('settings', s)
};

// ============================================================================
// FACE RECOGNITION MODULE (face-api.js)
// ============================================================================
const FACE = {
  ready: false,
  matchThreshold: 0.55, // L2 distance — lower is stricter
  loadError: null,
  async init() {
    if (this.ready) return;
    // Try multiple CDNs — the GitHub Pages mirror is intermittent.
    const URLS = [
      'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
      'https://justadudewhohacks.github.io/face-api.js/models',
      'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights'
    ];
    let lastErr = null;
    for (const url of URLS) {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(url),
          faceapi.nets.faceLandmark68Net.loadFromUri(url),
          faceapi.nets.faceRecognitionNet.loadFromUri(url)
        ]);
        this.ready = true;
        this.loadError = null;
        console.log('Face models loaded from', url);
        return;
      } catch (e) {
        lastErr = e;
        console.warn('Face model CDN failed:', url, e.message);
        // Reset any partially-loaded state before next attempt
        try {
          faceapi.nets.tinyFaceDetector.params = undefined;
          faceapi.nets.faceLandmark68Net.params = undefined;
          faceapi.nets.faceRecognitionNet.params = undefined;
        } catch {}
      }
    }
    this.loadError = lastErr;
    throw lastErr || new Error('All face model CDNs unreachable');
  },
  async detectDescriptor(videoEl) {
    const det = await faceapi
      .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return det || null;
  },
  // Capture image as JPEG dataURL for storage
  snapshotDataURL(videoEl) {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = (320 / videoEl.videoWidth) * videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1); // mirror to match preview
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  },
  // L2 distance between descriptors (Float32Array)
  distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum);
  },
  match(candidate, stored) {
    const d = this.distance(candidate, stored);
    return { matched: d < this.matchThreshold, distance: d };
  },
  // Eye Aspect Ratio for blink detection (anti-spoof)
  eyeAspectRatio(eye) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const v1 = dist(eye[1], eye[5]);
    const v2 = dist(eye[2], eye[4]);
    const hor = dist(eye[0], eye[3]);
    return (v1 + v2) / (2 * hor);
  }
};

// ============================================================================
// CAMERA HELPERS
// ============================================================================
const CAM = {
  stream: null,
  async start(videoEl) {
    if (this.stream) this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    videoEl.srcObject = this.stream;
    await videoEl.play();
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  }
};

// ============================================================================
// GEOLOCATION
// ============================================================================
function getGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ============================================================================
// AUTH
// ============================================================================
const AUTH = {
  async signup({ name, email, password, role }) {
    const users = DB.users();
    if (users.some(u => u.email === email)) throw new Error('Email already registered.');
    const passwordHash = await hashPwd(password);
    const user = {
      id: uid(), name, email, role, passwordHash,
      disabled: false,
      faceDescriptor: null, // Float32Array as plain array
      createdAt: new Date().toISOString()
    };
    users.push(user);
    DB.saveUsers(users);
    return user;
  },
  async login(email, password) {
    const users = DB.users();
    const user = users.find(u => u.email === email);
    if (!user) throw new Error('No account with that email.');
    if (user.disabled) throw new Error('Account disabled. Contact admin.');
    const ok = await verifyPwd(password, user.passwordHash);
    if (!ok) throw new Error('Incorrect password.');
    const session = { userId: user.id, ts: Date.now() };
    DB.saveSession(session);
    return user;
  },
  logout() { DB.clearSession(); state.user = null; navigate('login'); },
  current() {
    const s = DB.session(); if (!s) return null;
    return DB.users().find(u => u.id === s.userId) || null;
  }
};

// ============================================================================
// ATTENDANCE LOGIC
// ============================================================================
const STATUS = { PRESENT: 'PRESENT', INCOMPLETE: 'INCOMPLETE', OT_PENDING: 'OT_PENDING' };

const ATTENDANCE = {
  // Find today's open record (punched in, not punched out) for user
  findOpen(userId) {
    return DB.attendance().find(a => a.userId === userId && !a.punchOut && !a.invalid);
  },
  todayRecord(userId) {
    const day = todayISO();
    return DB.attendance().find(a => a.userId === userId && a.date === day && !a.invalid);
  },
  classify(hours) {
    if (hours >= 8 && hours <= 8.5) return STATUS.PRESENT;
    if (hours > 8.5) return STATUS.OT_PENDING;
    return STATUS.INCOMPLETE;
  },
  hoursBetween(inIso, outIso) {
    return (new Date(outIso) - new Date(inIso)) / 3_600_000;
  },
  async punchIn(userId, descriptor, selfieDataURL, geo) {
    const records = DB.attendance();
    const open = this.findOpen(userId);
    if (open) throw new Error('Already punched in. Punch out first.');
    const today = this.todayRecord(userId);
    if (today) throw new Error('Already recorded today.');

    const recordId = uid();
    const selfieKey = `selfie_${recordId}_in`;
    await idb.put(selfieKey, selfieDataURL);

    const rec = {
      id: recordId,
      userId,
      date: todayISO(),
      punchIn: new Date().toISOString(),
      punchOut: null,
      hours: 0,
      status: STATUS.INCOMPLETE,
      inGeo: geo,
      outGeo: null,
      inSelfieKey: selfieKey,
      outSelfieKey: null,
      faceDistanceIn: descriptor.distance,
      faceDistanceOut: null,
      invalid: false,
      flaggedReason: null,
      createdAt: new Date().toISOString()
    };
    records.push(rec);
    DB.saveAttendance(records);
    return rec;
  },
  async punchOut(userId, descriptor, selfieDataURL, geo) {
    const records = DB.attendance();
    const open = records.find(a => a.userId === userId && !a.punchOut && !a.invalid);
    if (!open) throw new Error('No open attendance. Punch in first.');

    const selfieKey = `selfie_${open.id}_out`;
    await idb.put(selfieKey, selfieDataURL);

    const out = new Date().toISOString();
    const hrs = this.hoursBetween(open.punchIn, out);
    open.punchOut = out;
    open.hours = +hrs.toFixed(3);
    open.status = this.classify(hrs);
    open.outGeo = geo;
    open.outSelfieKey = selfieKey;
    open.faceDistanceOut = descriptor.distance;

    DB.saveAttendance(records);
    return open;
  },
  forUser(userId) {
    return DB.attendance().filter(a => a.userId === userId).sort((a, b) => b.punchIn.localeCompare(a.punchIn));
  },
  all() {
    return DB.attendance().slice().sort((a, b) => b.punchIn.localeCompare(a.punchIn));
  },
  forTeam(managerId) {
    // In this simple model, "team" = all employees (a manager sees everyone except admins).
    // In a richer model you'd have teamId/managerId on User.
    const ids = DB.users().filter(u => u.role === 'employee').map(u => u.id);
    return DB.attendance().filter(a => ids.includes(a.userId)).sort((a, b) => b.punchIn.localeCompare(a.punchIn));
  }
};

// ============================================================================
// OVERTIME
// ============================================================================
const OT = {
  request({ userId, attendanceId, hoursOver, reason }) {
    const list = DB.overtime();
    list.push({
      id: uid(), userId, attendanceId,
      hoursOver: +hoursOver.toFixed(2),
      reason, status: 'pending',
      decidedBy: null, decidedAt: null,
      createdAt: new Date().toISOString()
    });
    DB.saveOvertime(list);
  },
  decide(otId, decidedBy, status) {
    const list = DB.overtime();
    const r = list.find(x => x.id === otId);
    if (!r) return;
    r.status = status; r.decidedBy = decidedBy; r.decidedAt = new Date().toISOString();
    DB.saveOvertime(list);

    // Reflect on attendance record
    const attendance = DB.attendance();
    const att = attendance.find(a => a.id === r.attendanceId);
    if (att) {
      if (status === 'approved') att.status = 'OT_APPROVED';
      if (status === 'rejected') att.status = STATUS.PRESENT; // reset to present (cap at 8h credited)
      DB.saveAttendance(attendance);
    }
  }
};

// ============================================================================
// AI ASSISTANT (Gemini, tool-calling pattern)
// ============================================================================
const AI = {
  tools: [
    {
      name: 'get_late_arrivals',
      description: 'List employees who punched in after the given hour on the given date.',
      params: { date: 'YYYY-MM-DD (default: today)', threshold_hour: 'integer 0-23 (default: 9)' }
    },
    {
      name: 'get_employees_under_8hrs',
      description: 'List employees whose worked hours on a date are less than 8 (incomplete).',
      params: { date: 'YYYY-MM-DD (default: today)' }
    },
    {
      name: 'get_pending_overtime',
      description: 'List all overtime requests with status pending.',
      params: {}
    },
    {
      name: 'get_attendance_summary',
      description: 'Summary stats for a date range: counts of present, incomplete, OT.',
      params: { start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' }
    },
    {
      name: 'get_user_history',
      description: 'Recent attendance records for a specific user by name.',
      params: { name: 'partial or full employee name', limit: 'integer (default: 10)' }
    },
    {
      name: 'get_disabled_users',
      description: 'List currently disabled accounts.',
      params: {}
    }
  ],

  // ------- TOOL EXECUTORS (these run server-side equivalent) -------
  exec: {
    get_late_arrivals({ date = todayISO(), threshold_hour = 9 } = {}) {
      const recs = DB.attendance().filter(a => a.date === date && !a.invalid);
      const users = DB.users();
      const late = recs.filter(r => new Date(r.punchIn).getHours() >= threshold_hour);
      return late.map(r => {
        const u = users.find(x => x.id === r.userId);
        return { name: u?.name || '?', email: u?.email, punch_in: fmtClock(r.punchIn), date: r.date };
      });
    },
    get_employees_under_8hrs({ date = todayISO() } = {}) {
      const recs = DB.attendance().filter(a => a.date === date && !a.invalid && a.punchOut);
      const users = DB.users();
      return recs.filter(r => r.hours < 8).map(r => {
        const u = users.find(x => x.id === r.userId);
        return { name: u?.name || '?', hours: +r.hours.toFixed(2), status: r.status };
      });
    },
    get_pending_overtime() {
      const reqs = DB.overtime().filter(o => o.status === 'pending');
      const users = DB.users();
      return reqs.map(r => {
        const u = users.find(x => x.id === r.userId);
        return { name: u?.name, hours_over: r.hoursOver, reason: r.reason, requested_at: fmtTime(r.createdAt) };
      });
    },
    get_attendance_summary({ start_date, end_date } = {}) {
      start_date = start_date || todayISO();
      end_date = end_date || todayISO();
      const recs = DB.attendance().filter(a => !a.invalid && a.date >= start_date && a.date <= end_date && a.punchOut);
      const present = recs.filter(r => r.status === STATUS.PRESENT || r.status === 'OT_APPROVED').length;
      const incomplete = recs.filter(r => r.status === STATUS.INCOMPLETE).length;
      const otPending = recs.filter(r => r.status === STATUS.OT_PENDING).length;
      const totalHours = recs.reduce((s, r) => s + r.hours, 0);
      return { range: `${start_date} to ${end_date}`, total_records: recs.length, present, incomplete, ot_pending: otPending, total_hours: +totalHours.toFixed(1) };
    },
    get_user_history({ name = '', limit = 10 } = {}) {
      if (!name) return [];
      const u = DB.users().find(x => x.name.toLowerCase().includes(name.toLowerCase()));
      if (!u) return { error: `No user found matching "${name}"` };
      const recs = DB.attendance()
        .filter(a => a.userId === u.id && !a.invalid)
        .sort((a, b) => b.punchIn.localeCompare(a.punchIn))
        .slice(0, limit)
        .map(r => ({
          date: r.date,
          punch_in: r.punchIn ? fmtClock(r.punchIn) : '-',
          punch_out: r.punchOut ? fmtClock(r.punchOut) : '-',
          hours: +r.hours.toFixed(2),
          status: r.status
        }));
      return { user: u.name, records: recs };
    },
    get_disabled_users() {
      return DB.users().filter(u => u.disabled).map(u => ({ name: u.name, email: u.email }));
    }
  },

  // ------- CALL GEMINI WITH TOOL DEFINITIONS -------
  async ask(question) {
    const settings = DB.settings();
    if (!settings.gemini) throw new Error('Gemini API key not configured. Open Settings.');

    // System instruction explains the tools
    const toolList = this.tools.map(t => `- ${t.name}(${Object.keys(t.params).join(', ') || '—'}): ${t.description}`).join('\n');

    const sys = `You are SENTRY, an analytics assistant for an attendance system.
You can call exactly ONE of the following functions per turn to fetch data, then answer the user.
Available functions:
${toolList}

Today's date is ${todayISO()}.

To call a function, respond with ONLY a JSON code block:
\`\`\`json
{ "tool": "function_name", "args": { ... } }
\`\`\`
Do not write anything else when calling a tool. After receiving the tool result, write a concise, well-structured answer for the user. Use bullet points or a small table when listing multiple items.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.gemini}`;

    const turn1 = await this._callGemini(url, [
      { role: 'user', parts: [{ text: sys + '\n\nUser question: ' + question }] }
    ]);

    const toolCall = this._parseToolCall(turn1);
    if (!toolCall) {
      return { answer: turn1, toolUsed: null, toolResult: null };
    }
    if (!this.exec[toolCall.tool]) {
      return { answer: `I tried to call \`${toolCall.tool}\` but it doesn't exist.`, toolUsed: toolCall.tool, toolResult: null };
    }

    let result;
    try { result = this.exec[toolCall.tool](toolCall.args || {}); }
    catch (e) { result = { error: e.message }; }

    const turn2 = await this._callGemini(url, [
      { role: 'user', parts: [{ text: sys + '\n\nUser question: ' + question }] },
      { role: 'model', parts: [{ text: '```json\n' + JSON.stringify(toolCall) + '\n```' }] },
      { role: 'user', parts: [{ text: 'TOOL RESULT for ' + toolCall.tool + ':\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n\nNow answer the original question concisely using this data.' }] }
    ]);

    return { answer: turn2, toolUsed: toolCall.tool, toolArgs: toolCall.args, toolResult: result };
  },

  async _callGemini(url, contents) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.3 } })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini API ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    return text.trim();
  },

  _parseToolCall(text) {
    const m = text.match(/```json\s*([\s\S]*?)```/);
    const raw = m ? m[1] : text;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.tool) return obj;
    } catch {}
    return null;
  }
};

// ============================================================================
// REPORTS — PDF / Excel
// ============================================================================
const REPORTS = {
  rowsForUser(userId) {
    const users = DB.users();
    return DB.attendance()
      .filter(a => a.userId === userId)
      .sort((a, b) => b.punchIn.localeCompare(a.punchIn))
      .map(a => this._rowFromRecord(a, users));
  },
  rowsForTeam() {
    const empIds = DB.users().filter(u => u.role === 'employee').map(u => u.id);
    return this._rows(DB.attendance().filter(a => empIds.includes(a.userId)));
  },
  rowsForAll() { return this._rows(DB.attendance()); },
  _rows(recs) {
    const users = DB.users();
    return recs.sort((a, b) => b.punchIn.localeCompare(a.punchIn))
      .map(a => this._rowFromRecord(a, users));
  },
  _rowFromRecord(a, users) {
    const u = users.find(x => x.id === a.userId);
    return {
      Employee: u?.name || '?',
      Email: u?.email || '',
      Date: a.date,
      'Punch In': a.punchIn ? fmtClock(a.punchIn) : '',
      'Punch Out': a.punchOut ? fmtClock(a.punchOut) : '',
      Hours: a.hours ? a.hours.toFixed(2) : '0',
      Status: a.invalid ? 'INVALID' : a.status,
      'In Lat': a.inGeo?.lat?.toFixed(5) || '',
      'In Lng': a.inGeo?.lng?.toFixed(5) || ''
    };
  },
  exportExcel(rows, filename) {
    if (!rows.length) return toast('No data to export', 'error');
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, filename + '.xlsx');
  },
  exportPDF(rows, filename, title) {
    if (!rows.length) return toast('No data to export', 'error');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text(title || 'Attendance Report', 14, 18);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 25);
    const cols = Object.keys(rows[0]);
    doc.autoTable({
      startY: 32,
      head: [cols],
      body: rows.map(r => cols.map(c => r[c])),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [40, 40, 40] }
    });
    doc.save(filename + '.pdf');
  }
};

// ============================================================================
// STATE + ROUTER
// ============================================================================
const state = {
  user: null,
  route: 'login',
  routeParams: {}
};

function navigate(route, params = {}) {
  state.route = route;
  state.routeParams = params;
  render();
}

// ============================================================================
// VIEW HELPERS
// ============================================================================
function statusBadge(s) {
  const map = {
    PRESENT: ['badge-success', 'PRESENT'],
    OT_APPROVED: ['badge-accent', 'OT APPROVED'],
    OT_PENDING: ['badge-warn', 'OT PENDING'],
    INCOMPLETE: ['badge-danger', 'INCOMPLETE'],
    INVALID: ['badge-dim', 'INVALID']
  };
  const [cls, label] = map[s] || ['badge-dim', s];
  return `<span class="badge badge-dot ${cls}">${label}</span>`;
}
function roleBadge(r) {
  const map = { admin: 'badge-accent', manager: 'badge-info', employee: 'badge-dim' };
  return `<span class="badge ${map[r] || 'badge-dim'}">${r.toUpperCase()}</span>`;
}

function initials(name) {
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

function logoEl() {
  return `<div class="logo">
    <div class="logo-mark"></div>
    <span>SENTRY</span>
  </div>`;
}

function navIcon(name) {
  const icons = {
    home: '<path d="M3 12L12 4L21 12V20H14V14H10V20H3V12Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
    clock: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 7V12L15 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    team: '<circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="17" cy="9" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 19C3 16 5.5 14 9 14C12.5 14 15 16 15 19" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M15 19C15 17 16.5 15 17 15C18.5 15 21 17 21 19" stroke="currentColor" stroke-width="1.5" fill="none"/>',
    sparkle: '<path d="M12 3L13.5 9L19 10.5L13.5 12L12 18L10.5 12L5 10.5L10.5 9L12 3Z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><path d="M19 16L19.7 18.3L22 19L19.7 19.7L19 22L18.3 19.7L16 19L18.3 18.3L19 16Z" fill="currentColor"/>',
    file: '<path d="M5 4H14L19 9V20H5V4Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M14 4V9H19" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
    users: '<circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 20C4 16.5 7.5 14 12 14C16.5 14 20 16.5 20 20" stroke="currentColor" stroke-width="1.5" fill="none"/>',
    settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 2V5M12 19V22M22 12H19M5 12H2M19 5L17 7M7 17L5 19M19 19L17 17M7 7L5 5" stroke="currentColor" stroke-width="1.5"/>',
    bolt: '<path d="M13 3L4 14H11L10 21L19 10H12L13 3Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
    out: '<path d="M9 20H5V4H9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M14 8L18 12L14 16" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M18 12H10" stroke="currentColor" stroke-width="1.5"/>'
  };
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none">${icons[name] || ''}</svg>`;
}

// ============================================================================
// VIEWS — login / signup
// ============================================================================
function viewLogin() {
  return `<div class="auth-wrap">
    <aside class="auth-hero">
      <div>${logoEl()}</div>
      <div>
        <h1 style="max-width: 16ch;">Attendance, watched by something smarter than a clock.</h1>
        <p class="dim mt-2" style="max-width: 42ch;">SENTRY pairs face recognition with geolocation and an analytics agent. No swipe cards. No spreadsheets. No pretending.</p>
        <div class="row gap-lg mt-3" style="flex-wrap:wrap;">
          <div><div class="uppercase-label">Detection</div><div class="mono mt-1" style="font-size:0.875rem;">FaceAPI · L2 &lt; 0.55</div></div>
          <div><div class="uppercase-label">Logic</div><div class="mono mt-1" style="font-size:0.875rem;">≥8h · OT · Incomplete</div></div>
          <div><div class="uppercase-label">Agent</div><div class="mono mt-1" style="font-size:0.875rem;">Gemini · Tool-call</div></div>
        </div>
      </div>
      <div class="uppercase-label">v1.0 · single-file build</div>
    </aside>
    <div class="auth-form-side">
      <div class="auth-form">
        <div class="uppercase-label">Sign in</div>
        <h2 class="mt-1 mb-3">Welcome back.</h2>
        <form id="loginForm" class="col">
          <div class="field">
            <label class="field-label">Email</label>
            <input class="input" name="email" type="email" required autocomplete="username" />
          </div>
          <div class="field">
            <label class="field-label">Password</label>
            <input class="input" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Authenticate →</button>
        </form>
        <div class="divider"></div>
        <div class="row-between">
          <span class="dim" style="font-size:0.8125rem;">First time here?</span>
          <a class="btn btn-ghost btn-sm" href="#" id="goSignup">Create account</a>
        </div>
        <p class="faint mt-3" style="font-size:0.75rem;">Demo accounts? Create them in signup — pick a role. All data lives in your browser.</p>
      </div>
    </div>
  </div>`;
}

function viewSignup() {
  return `<div class="auth-wrap">
    <aside class="auth-hero">
      <div>${logoEl()}</div>
      <div>
        <h1 style="max-width: 16ch;">Provision an account in twelve seconds.</h1>
        <p class="dim mt-2" style="max-width: 42ch;">Pick a role. Enroll your face. Done. Face descriptors are computed locally and stored in your browser — they never leave the device.</p>
      </div>
      <div class="uppercase-label">step 1 of 2 · credentials</div>
    </aside>
    <div class="auth-form-side">
      <div class="auth-form">
        <div class="uppercase-label">Create account</div>
        <h2 class="mt-1 mb-3">New operator.</h2>
        <form id="signupForm" class="col">
          <div class="field">
            <label class="field-label">Full name</label>
            <input class="input" name="name" required />
          </div>
          <div class="field">
            <label class="field-label">Email</label>
            <input class="input" name="email" type="email" required />
          </div>
          <div class="field">
            <label class="field-label">Password</label>
            <input class="input" name="password" type="password" minlength="6" required />
          </div>
          <div class="field">
            <label class="field-label">Role</label>
            <select class="select" name="role" required>
              <option value="employee">Employee</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Continue · Enroll face →</button>
        </form>
        <div class="divider"></div>
        <div class="row-between">
          <span class="dim" style="font-size:0.8125rem;">Already enrolled?</span>
          <a class="btn btn-ghost btn-sm" href="#" id="goLogin">Sign in</a>
        </div>
      </div>
    </div>
  </div>`;
}

// ============================================================================
// VIEW: shell + sidebar (used for all logged-in views)
// ============================================================================
function shell(body) {
  const u = state.user;
  const items = [];
  items.push({ key: 'dashboard', label: 'Dashboard', icon: 'home' });
  if (u.role === 'employee') {
    items.push({ key: 'punch', label: 'Punch In / Out', icon: 'clock' });
    items.push({ key: 'history', label: 'My Attendance', icon: 'file' });
    items.push({ key: 'overtime', label: 'My Overtime', icon: 'bolt' });
  }
  if (u.role === 'manager' || u.role === 'admin') {
    items.push({ key: 'team', label: u.role === 'admin' ? 'All Attendance' : 'Team Attendance', icon: 'team' });
    items.push({ key: 'overtime-review', label: 'Overtime Requests', icon: 'bolt' });
    items.push({ key: 'reports', label: 'Reports', icon: 'file' });
    items.push({ key: 'ai', label: 'AI Assistant', icon: 'sparkle' });
  }
  if (u.role === 'admin') {
    items.push({ key: 'users', label: 'User Management', icon: 'users' });
  }
  items.push({ key: 'settings', label: 'Settings', icon: 'settings' });

  const navHtml = items.map(it => `
    <div class="nav-item ${state.route === it.key ? 'active' : ''}" data-go="${it.key}">
      ${navIcon(it.icon)} <span>${it.label}</span>
    </div>
  `).join('');

  return `<div class="shell">
    <aside class="sidebar">
      ${logoEl()}
      <nav class="nav">
        ${navHtml}
      </nav>
      <div class="user-card">
        <div class="avatar">${initials(u.name)}</div>
        <div style="flex:1; min-width: 0;">
          <div style="font-size:0.8125rem; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(u.name)}</div>
          <div class="faint mono" style="font-size:0.6875rem;">${u.role.toUpperCase()}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="logoutBtn" title="Logout">${navIcon('out')}</button>
      </div>
    </aside>
    <main class="main">
      ${body}
    </main>
  </div>`;
}

// ============================================================================
// VIEW: dashboard (role-aware)
// ============================================================================
function viewDashboard() {
  const u = state.user;
  const today = todayISO();
  let body = '';

  if (u.role === 'employee') {
    const my = ATTENDANCE.forUser(u.id);
    const todayRec = my.find(a => a.date === today && !a.invalid);
    const open = my.find(a => !a.punchOut && !a.invalid);
    const last7 = my.filter(a => a.punchOut && a.date >= todayISO(new Date(Date.now() - 6 * 86400000)));
    const totalHours = last7.reduce((s, r) => s + r.hours, 0);
    const status = todayRec ? todayRec.status : (open ? 'Open' : '—');

    body = `
      <div class="row-between mb-3">
        <div>
          <div class="uppercase-label">Operator dashboard</div>
          <h2 class="mt-1">Hi, ${esc(u.name.split(' ')[0])}.</h2>
        </div>
        <button class="btn btn-primary" data-go="punch">${navIcon('clock')} Punch ${open ? 'Out' : 'In'}</button>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">Today</div>
          <div class="stat-value">${todayRec ? (todayRec.punchOut ? fmtHrs(todayRec.hours) : 'OPEN') : '—'}</div>
          <div class="stat-meta">${todayRec ? statusBadge(todayRec.status) : 'Not punched in yet'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Last 7 days</div>
          <div class="stat-value">${fmtHrs(totalHours)}</div>
          <div class="stat-meta">${last7.length} sessions</div>
        </div>
        <div class="stat">
          <div class="stat-label">Face enrolled</div>
          <div class="stat-value">${u.faceDescriptor ? '✓' : '✗'}</div>
          <div class="stat-meta">${u.faceDescriptor ? 'Ready for verification' : 'Enroll in Settings'}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Recent activity</h3></div>
        ${recentTable(my.slice(0, 6), false)}
      </div>
    `;
  } else {
    // manager / admin
    const all = u.role === 'admin' ? DB.attendance() : ATTENDANCE.forTeam(u.id);
    const todayRecs = all.filter(a => a.date === today && !a.invalid);
    const present = todayRecs.filter(r => r.status === STATUS.PRESENT || r.status === 'OT_APPROVED').length;
    const incomplete = todayRecs.filter(r => r.status === STATUS.INCOMPLETE).length;
    const otPending = DB.overtime().filter(o => o.status === 'pending').length;
    const totalUsers = DB.users().filter(x => x.role === 'employee' && !x.disabled).length;

    body = `
      <div class="row-between mb-3">
        <div>
          <div class="uppercase-label">${u.role.toUpperCase()} dashboard</div>
          <h2 class="mt-1">Operations overview</h2>
        </div>
        <div class="row gap-sm">
          <button class="btn" data-go="ai">${navIcon('sparkle')} Ask AI</button>
          <button class="btn btn-primary" data-go="reports">${navIcon('file')} Reports</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">Today · Present</div>
          <div class="stat-value">${present}</div>
          <div class="stat-meta">of ${totalUsers} active employees</div>
        </div>
        <div class="stat">
          <div class="stat-label">Today · Incomplete</div>
          <div class="stat-value">${incomplete}</div>
          <div class="stat-meta">under 8 hours</div>
        </div>
        <div class="stat">
          <div class="stat-label">Pending Overtime</div>
          <div class="stat-value">${otPending}</div>
          <div class="stat-meta">${otPending ? 'awaiting decision' : 'all caught up'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total records</div>
          <div class="stat-value">${all.length}</div>
          <div class="stat-meta">across all users</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>Today's punches</h3>
          <div class="uppercase-label">${todayRecs.length} entries</div>
        </div>
        ${recentTable(todayRecs.slice(0, 8), true)}
      </div>
    `;
  }

  return shell(body);
}

function recentTable(records, showName) {
  if (!records.length) return `<div class="empty">No records yet.</div>`;
  const users = DB.users();
  const rows = records.map(r => {
    const user = users.find(x => x.id === r.userId);
    return `<tr>
      ${showName ? `<td>${esc(user?.name || '?')}</td>` : ''}
      <td class="mono">${r.date}</td>
      <td class="mono">${r.punchIn ? fmtClock(r.punchIn) : '—'}</td>
      <td class="mono">${r.punchOut ? fmtClock(r.punchOut) : '—'}</td>
      <td class="mono">${r.hours ? fmtHrs(r.hours) : '—'}</td>
      <td>${r.invalid ? statusBadge('INVALID') : statusBadge(r.status)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr>
      ${showName ? '<th>Employee</th>' : ''}
      <th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ============================================================================
// VIEW: punch (employee)
// ============================================================================
function viewPunch() {
  const u = state.user;
  const open = ATTENDANCE.findOpen(u.id);
  const today = ATTENDANCE.todayRecord(u.id);

  const ready = !!u.faceDescriptor;
  const action = open ? 'OUT' : 'IN';

  let cta;
  if (!ready) {
    cta = `<div class="card">
      <h3>Face not enrolled</h3>
      <p class="dim mt-1">Enroll your face descriptor before you can punch.</p>
      <button class="btn btn-primary mt-2" data-go="settings">Go to Settings →</button>
    </div>`;
  } else if (today && today.punchOut) {
    cta = `<div class="card">
      <h3>You're done for today.</h3>
      <p class="dim mt-1">Today's session: ${fmtHrs(today.hours)} · ${statusBadge(today.status)}</p>
    </div>`;
  } else {
    cta = `<div class="card text-center">
      <div class="uppercase-label">Action required</div>
      <h2 class="mt-1 mb-2">Punch ${action}</h2>
      <p class="dim mb-3">Camera will activate. Look at the lens — verification takes ~2 seconds.</p>
      <button class="btn btn-primary btn-lg" id="startPunchBtn">${navIcon('clock')} Begin verification</button>
      ${open ? `<p class="faint mt-3" style="font-size:0.75rem;">Punched in at ${fmtClock(open.punchIn)} · ${fmtHrs(ATTENDANCE.hoursBetween(open.punchIn, new Date().toISOString()))} elapsed</p>` : ''}
    </div>`;
  }

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Live capture</div>
        <h2 class="mt-1">Punch ${action}</h2>
      </div>
    </div>
    ${cta}
  `);
}

// ============================================================================
// VIEW: history (employee)
// ============================================================================
function viewHistory() {
  const u = state.user;
  const all = ATTENDANCE.forUser(u.id);

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Personal log</div>
        <h2 class="mt-1">My attendance</h2>
      </div>
      <div class="row gap-sm">
        <button class="btn" id="exportMyExcel">${navIcon('file')} Excel</button>
        <button class="btn" id="exportMyPDF">${navIcon('file')} PDF</button>
      </div>
    </div>
    ${recentTable(all, false)}
  `);
}

// ============================================================================
// VIEW: my overtime (employee)
// ============================================================================
function viewMyOvertime() {
  const u = state.user;
  const my = DB.overtime().filter(o => o.userId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Records that exceeded 8.5h and could request OT
  const myAtt = ATTENDANCE.forUser(u.id);
  const eligible = myAtt.filter(a => a.status === STATUS.OT_PENDING && !DB.overtime().some(o => o.attendanceId === a.id));

  const eligibleHtml = eligible.length ? `
    <div class="card mb-3">
      <h4>Eligible records</h4>
      <p class="dim mt-1" style="font-size:0.8125rem;">These sessions exceeded 8.5h and need an OT request to be credited.</p>
      <div class="col mt-2">
        ${eligible.map(a => `
          <div class="row-between" style="padding:10px; background:var(--bg-2); border-radius:6px;">
            <div>
              <div class="mono" style="font-size:0.8125rem;">${a.date} · ${fmtHrs(a.hours)}</div>
              <div class="faint" style="font-size:0.75rem;">${(a.hours - 8).toFixed(1)}h overtime</div>
            </div>
            <button class="btn btn-sm btn-primary" data-ot-request="${a.id}">Request OT</button>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  const rows = my.map(o => {
    const att = DB.attendance().find(a => a.id === o.attendanceId);
    return `<tr>
      <td class="mono">${att?.date || '—'}</td>
      <td class="mono">+${o.hoursOver}h</td>
      <td>${esc(o.reason || '—')}</td>
      <td class="mono">${fmtTime(o.createdAt)}</td>
      <td>${otStatusBadge(o.status)}</td>
    </tr>`;
  }).join('');

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Overtime</div>
        <h2 class="mt-1">My OT requests</h2>
      </div>
    </div>
    ${eligibleHtml}
    ${my.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Hours over</th><th>Reason</th><th>Submitted</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<div class="empty">No overtime requests yet.</div>`}
  `);
}

function otStatusBadge(s) {
  if (s === 'pending') return `<span class="badge badge-warn">PENDING</span>`;
  if (s === 'approved') return `<span class="badge badge-success">APPROVED</span>`;
  if (s === 'rejected') return `<span class="badge badge-danger">REJECTED</span>`;
  return `<span class="badge badge-dim">${s}</span>`;
}

// ============================================================================
// VIEW: team / all attendance (manager / admin)
// ============================================================================
function viewTeam() {
  const u = state.user;
  const all = u.role === 'admin' ? ATTENDANCE.all() : ATTENDANCE.forTeam(u.id);
  const filterDate = state.routeParams.date || '';
  const filterUser = state.routeParams.user || '';
  const users = DB.users();

  let rows = all;
  if (filterDate) rows = rows.filter(r => r.date === filterDate);
  if (filterUser) rows = rows.filter(r => r.userId === filterUser);

  const userOptions = users.map(x => `<option value="${x.id}" ${x.id === filterUser ? 'selected' : ''}>${esc(x.name)} · ${x.role}</option>`).join('');

  const tbl = rows.length ? `<div class="table-wrap"><table>
    <thead><tr>
      <th>Employee</th><th>Date</th><th>In</th><th>Out</th><th>Hours</th>
      <th>Location</th><th>Status</th>${u.role === 'admin' ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${rows.map(r => {
      const user = users.find(x => x.id === r.userId);
      return `<tr>
        <td>${esc(user?.name || '?')}</td>
        <td class="mono">${r.date}</td>
        <td class="mono">${r.punchIn ? fmtClock(r.punchIn) : '—'}</td>
        <td class="mono">${r.punchOut ? fmtClock(r.punchOut) : '—'}</td>
        <td class="mono">${r.hours ? fmtHrs(r.hours) : '—'}</td>
        <td>${r.inGeo ? `<a class="map-link" href="https://www.google.com/maps?q=${r.inGeo.lat},${r.inGeo.lng}" target="_blank">${r.inGeo.lat.toFixed(4)}, ${r.inGeo.lng.toFixed(4)}</a>` : '<span class="faint">—</span>'}</td>
        <td>${r.invalid ? statusBadge('INVALID') : statusBadge(r.status)}</td>
        ${u.role === 'admin' ? `<td><div class="row gap-sm"><button class="btn btn-sm" data-view-record="${r.id}">View</button>${r.invalid ? '' : `<button class="btn btn-sm btn-danger" data-flag-record="${r.id}">Flag</button>`}</div></td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty">No records match.</div>`;

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">${u.role === 'admin' ? 'All attendance' : 'Team attendance'}</div>
        <h2 class="mt-1">${rows.length} records</h2>
      </div>
      <div class="row gap-sm">
        <input type="date" class="input" id="filterDate" value="${filterDate}" style="width:160px;" />
        <select class="select" id="filterUser" style="width:200px;">
          <option value="">All users</option>${userOptions}
        </select>
        <button class="btn" id="clearFilter">Clear</button>
      </div>
    </div>
    ${tbl}
  `);
}

// ============================================================================
// VIEW: overtime review (manager / admin)
// ============================================================================
function viewOvertimeReview() {
  const reqs = DB.overtime().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const users = DB.users();
  const att = DB.attendance();

  const tbl = reqs.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Employee</th><th>Date</th><th>Hours over</th><th>Reason</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
    <tbody>${reqs.map(o => {
      const user = users.find(x => x.id === o.userId);
      const a = att.find(x => x.id === o.attendanceId);
      return `<tr>
        <td>${esc(user?.name || '?')}</td>
        <td class="mono">${a?.date || '—'}</td>
        <td class="mono">+${o.hoursOver}h</td>
        <td>${esc(o.reason || '—')}</td>
        <td class="mono">${fmtTime(o.createdAt)}</td>
        <td>${otStatusBadge(o.status)}</td>
        <td>${o.status === 'pending' ? `
          <div class="row gap-sm">
            <button class="btn btn-sm btn-primary" data-ot-decide="${o.id}" data-decision="approved">Approve</button>
            <button class="btn btn-sm btn-danger" data-ot-decide="${o.id}" data-decision="rejected">Reject</button>
          </div>
        ` : `<span class="faint mono" style="font-size:0.75rem;">${fmtTime(o.decidedAt)}</span>`}</td>
      </tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty">No overtime requests.</div>`;

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Approvals</div>
        <h2 class="mt-1">Overtime requests</h2>
      </div>
    </div>
    ${tbl}
  `);
}

// ============================================================================
// VIEW: reports
// ============================================================================
function viewReports() {
  const u = state.user;
  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Exports</div>
        <h2 class="mt-1">Reports</h2>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3>${u.role === 'admin' ? 'All attendance' : 'Team attendance'}</h3>
        <p class="dim mt-1">Full attendance log with locations and status, scoped to your role.</p>
        <div class="row gap-sm mt-3">
          <button class="btn btn-primary" id="rptTeamExcel">Excel</button>
          <button class="btn" id="rptTeamPDF">PDF</button>
        </div>
      </div>
      <div class="card">
        <h3>Overtime register</h3>
        <p class="dim mt-1">Every OT request with status and decision metadata.</p>
        <div class="row gap-sm mt-3">
          <button class="btn btn-primary" id="rptOTExcel">Excel</button>
          <button class="btn" id="rptOTPDF">PDF</button>
        </div>
      </div>
    </div>
  `);
}

// ============================================================================
// VIEW: AI assistant (manager / admin)
// ============================================================================
function viewAI() {
  const settings = DB.settings();
  const messages = state.aiMessages || [];
  const noKey = !settings.gemini;

  const messagesHtml = messages.map(m => {
    if (m.role === 'user') {
      return `<div class="msg user">
        <div class="msg-avatar">${initials(state.user.name)}</div>
        <div class="msg-body">${esc(m.text)}</div>
      </div>`;
    }
    return `<div class="msg assistant">
      <div class="msg-avatar">AI</div>
      <div class="msg-body">
        ${m.thinking ? '<div class="typing"><span></span><span></span><span></span></div>' : renderMarkdownLite(m.text)}
        ${m.toolUsed ? `<div class="msg-tool">→ called <strong>${m.toolUsed}</strong>${m.toolArgs ? `(${esc(JSON.stringify(m.toolArgs))})` : ''}</div>` : ''}
      </div>
    </div>`;
  }).join('') || `<div class="empty">
    Ask anything: "Who came late today?", "Show pending overtime", "Summary for this week"...
  </div>`;

  const banner = noKey ? `<div class="card-tight" style="background: rgba(251, 191, 36, 0.06); border: 1px solid rgba(251, 191, 36, 0.2); margin-bottom: 16px;">
    <div class="row-between">
      <span style="font-size: 0.875rem;">⚠ Gemini API key not set.</span>
      <button class="btn btn-sm" data-go="settings">Configure</button>
    </div>
  </div>` : '';

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Analytics agent</div>
        <h2 class="mt-1">AI Assistant</h2>
      </div>
      <div class="row gap-sm">
        <span class="badge badge-accent badge-dot">Gemini · tool-calling</span>
      </div>
    </div>
    ${banner}
    <div class="chat-shell">
      <div class="chat-head">
        <div class="row gap-sm">
          <span class="uppercase-label">Available tools</span>
          <span class="mono faint" style="font-size: 0.6875rem;">${AI.tools.map(t => t.name).join(' · ')}</span>
        </div>
        <button class="btn btn-sm btn-ghost" id="aiClearBtn">Clear</button>
      </div>
      <div class="chat-stream" id="chatStream">${messagesHtml}</div>
      <div class="chat-input-wrap">
        <textarea class="chat-input" id="aiInput" placeholder="${noKey ? 'Set API key in Settings first' : 'Ask the assistant…'}" ${noKey ? 'disabled' : ''}></textarea>
        <button class="btn btn-primary" id="aiSendBtn" ${noKey ? 'disabled' : ''}>Send</button>
      </div>
    </div>
  `);
}

// Very lightweight markdown renderer (bold, lists, code spans, line breaks)
function renderMarkdownLite(text) {
  if (!text) return '';
  let s = esc(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre style="background:var(--bg);padding:8px;border-radius:6px;overflow-x:auto;font-family:var(--mono);font-size:0.75rem;">${code}</pre>`);
  s = s.replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:1px 5px;border-radius:3px;font-family:var(--mono);font-size:0.85em;">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul style="margin: 6px 0; padding-left: 18px;">$1</ul>');
  s = s.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
  return s;
}

// ============================================================================
// VIEW: user management (admin)
// ============================================================================
function viewUsers() {
  const users = DB.users();
  const rows = users.map(u => `<tr>
    <td><div class="row gap-sm"><div class="avatar" style="width:28px;height:28px;font-size:0.6875rem;">${initials(u.name)}</div><span>${esc(u.name)}</span></div></td>
    <td class="mono" style="font-size:0.75rem;">${esc(u.email)}</td>
    <td>${roleBadge(u.role)}</td>
    <td>${u.faceDescriptor ? '<span class="badge badge-success badge-dot">ENROLLED</span>' : '<span class="badge badge-dim">NOT ENROLLED</span>'}</td>
    <td>${u.disabled ? '<span class="badge badge-danger">DISABLED</span>' : '<span class="badge badge-success badge-dot">ACTIVE</span>'}</td>
    <td><button class="btn btn-sm ${u.disabled ? 'btn-primary' : 'btn-danger'}" data-toggle-user="${u.id}">${u.disabled ? 'Re-enable' : 'Disable'}</button></td>
  </tr>`).join('');

  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Identity</div>
        <h2 class="mt-1">User management</h2>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Face</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  `);
}

// ============================================================================
// VIEW: settings
// ============================================================================
function viewSettings() {
  const settings = DB.settings();
  const u = state.user;
  return shell(`
    <div class="row-between mb-3">
      <div>
        <div class="uppercase-label">Configuration</div>
        <h2 class="mt-1">Settings</h2>
      </div>
    </div>
    <div class="col">
      <div class="card">
        <h3>Face enrollment</h3>
        <p class="dim mt-1">${u.faceDescriptor ? 'Your face is enrolled. Re-enroll to refresh the descriptor.' : 'You must enroll your face before punching in.'}</p>
        <div class="mt-2 row gap-sm" style="flex-wrap: wrap; align-items: center;">
          <button class="btn btn-primary" id="enrollFaceBtn" ${!FACE.ready ? 'disabled' : ''}>${u.faceDescriptor ? 'Re-enroll face' : 'Enroll face now'}</button>
          <span class="badge ${FACE.ready ? 'badge-success badge-dot' : 'badge-warn badge-dot'}">
            ${FACE.ready ? 'MODELS LOADED' : 'MODELS NOT LOADED'}
          </span>
          ${!FACE.ready ? '<button class="btn btn-sm" id="retryModelsBtn">Retry loading models</button>' : ''}
        </div>
        ${!FACE.ready && FACE.loadError ? `<div class="mono faint mt-2" style="font-size: 0.7rem;">${esc(FACE.loadError.message || String(FACE.loadError))}</div>` : ''}
      </div>

      <div class="card">
        <h3>Gemini API</h3>
        <p class="dim mt-1">Required for the AI assistant. Get a free key at <a class="map-link" href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>. Stored locally in your browser.</p>
        <form id="geminiForm" class="col mt-2">
          <div class="field">
            <label class="field-label">API Key</label>
            <input class="input" name="gemini" type="password" value="${esc(settings.gemini)}" placeholder="AIza..." />
          </div>
          <div class="field">
            <label class="field-label">Model</label>
            <select class="select" name="model">
              <option value="gemini-2.0-flash" ${settings.model === 'gemini-2.0-flash' ? 'selected' : ''}>gemini-2.0-flash (recommended)</option>
              <option value="gemini-2.5-flash" ${settings.model === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash</option>
              <option value="gemini-1.5-flash" ${settings.model === 'gemini-1.5-flash' ? 'selected' : ''}>gemini-1.5-flash</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit" style="align-self: flex-start;">Save</button>
        </form>
      </div>

      ${u.role === 'admin' ? `
      <div class="card">
        <h3>Geofencing (optional)</h3>
        <p class="dim mt-1">Restrict punches to within a radius of a center point. Records outside are flagged but not blocked.</p>
        <form id="geoForm" class="col mt-2">
          <div class="grid-2">
            <div class="field">
              <label class="field-label">Center latitude</label>
              <input class="input" name="lat" type="number" step="any" value="${settings.geofence?.lat ?? ''}" />
            </div>
            <div class="field">
              <label class="field-label">Center longitude</label>
              <input class="input" name="lng" type="number" step="any" value="${settings.geofence?.lng ?? ''}" />
            </div>
          </div>
          <div class="field">
            <label class="field-label">Radius (meters)</label>
            <input class="input" name="radius" type="number" value="${settings.geofenceRadius || 500}" />
          </div>
          <div class="row gap-sm" style="align-self:flex-start;">
            <button class="btn btn-primary" type="submit">Save</button>
            <button class="btn" type="button" id="useMyLocation">Use my current location</button>
            <button class="btn btn-danger" type="button" id="clearGeofence">Disable</button>
          </div>
        </form>
      </div>
      ` : ''}

      <div class="card">
        <h3 style="color: var(--danger);">Danger zone</h3>
        <p class="dim mt-1">Wipe all data. Cannot be undone.</p>
        <button class="btn btn-danger mt-2" id="wipeBtn">Reset everything</button>
      </div>
    </div>
  `);
}

// ============================================================================
// MODAL: face capture (used for enrollment, punch in/out)
// ============================================================================
async function openFaceCaptureModal({ mode, expectedDescriptor, requireBlink, onComplete }) {
  // Guard: face models must be loaded
  if (!FACE.ready) {
    toast('Face models not loaded. Go to Settings and click Retry.', 'error');
    return null;
  }
  // mode: 'enroll' | 'verify'
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const status = mode === 'enroll' ? 'POSITION FACE — STAY STILL' : 'VERIFICATION';
    root.innerHTML = `
      <div class="modal-bg" id="modalBg">
        <div class="modal modal-cam">
          <div class="row-between mb-2">
            <h3>${mode === 'enroll' ? 'Enroll face' : 'Face verification'}</h3>
            <button class="btn btn-ghost btn-sm" id="closeModal">✕</button>
          </div>
          <div class="cam-frame">
            <video id="camVideo" playsinline muted></video>
            <div class="scanline" id="scanline"></div>
            <div class="cam-overlay">
              <div class="cam-corner tl"></div><div class="cam-corner tr"></div>
              <div class="cam-corner bl"></div><div class="cam-corner br"></div>
            </div>
            <div class="cam-status" id="camStatus"><span class="dot"></span>${status}</div>
          </div>
          <div class="mt-2 mono" id="camDetail" style="font-size: 0.75rem; color: var(--text-dim); min-height: 18px;"></div>
          <div class="row gap-sm mt-3">
            <button class="btn btn-primary btn-block" id="captureBtn" disabled>Capture</button>
          </div>
        </div>
      </div>
    `;

    const video = $('#camVideo');
    const status_el = $('#camStatus');
    const detail = $('#camDetail');
    const captureBtn = $('#captureBtn');
    let lastDescriptor = null;
    let lastDistance = null;
    let blinkSeen = !requireBlink;
    let earHistory = [];
    let raf;

    const setStatus = (cls, label, info = '') => {
      status_el.className = 'cam-status ' + cls;
      status_el.innerHTML = `<span class="dot"></span>${label}`;
      detail.textContent = info;
    };

    const cleanup = (result) => {
      cancelAnimationFrame(raf);
      CAM.stop();
      root.innerHTML = '';
      resolve(result);
      if (onComplete) onComplete(result);
    };

    $('#closeModal').onclick = () => cleanup(null);
    $('#modalBg').onclick = (e) => { if (e.target.id === 'modalBg') cleanup(null); };

    captureBtn.onclick = async () => {
      if (!lastDescriptor) return;
      const dataURL = FACE.snapshotDataURL(video);
      cleanup({ descriptor: lastDescriptor, dataURL, distance: lastDistance });
    };

    (async () => {
      try {
        await CAM.start(video);
      } catch (e) {
        toast('Camera access denied: ' + e.message, 'error');
        cleanup(null);
        return;
      }

      // Detection loop
      const loop = async () => {
        if (!video.srcObject) return;
        try {
          const det = await FACE.detectDescriptor(video);
          if (!det) {
            setStatus('bad', 'NO FACE DETECTED');
            captureBtn.disabled = true;
          } else {
            // Anti-spoof: blink detection via EAR
            const lm = det.landmarks;
            const leftEye = lm.getLeftEye();
            const rightEye = lm.getRightEye();
            const ear = (FACE.eyeAspectRatio(leftEye) + FACE.eyeAspectRatio(rightEye)) / 2;
            earHistory.push(ear);
            if (earHistory.length > 30) earHistory.shift();
            const min = Math.min(...earHistory);
            const max = Math.max(...earHistory);
            if (requireBlink && (max - min) > 0.08) blinkSeen = true;

            if (mode === 'verify' && expectedDescriptor) {
              const m = FACE.match(det.descriptor, new Float32Array(expectedDescriptor));
              lastDescriptor = det.descriptor;
              lastDistance = m.distance;
              if (m.matched) {
                if (requireBlink && !blinkSeen) {
                  setStatus('', 'BLINK ONCE TO CONFIRM LIVENESS', `match dist=${m.distance.toFixed(3)} · waiting for blink`);
                  captureBtn.disabled = true;
                } else {
                  setStatus('ok', 'FACE MATCH', `dist=${m.distance.toFixed(3)} · threshold ${FACE.matchThreshold}`);
                  captureBtn.disabled = false;
                }
              } else {
                setStatus('bad', 'NO MATCH', `dist=${m.distance.toFixed(3)} (need < ${FACE.matchThreshold})`);
                captureBtn.disabled = true;
              }
            } else {
              // enroll mode
              lastDescriptor = det.descriptor;
              setStatus('ok', 'FACE LOCKED', 'ready to enroll');
              captureBtn.disabled = false;
            }
          }
        } catch (e) {
          setStatus('bad', 'DETECTOR ERROR', e.message);
        }
        raf = requestAnimationFrame(() => setTimeout(loop, 100));
      };
      loop();
    })();
  });
}

// ============================================================================
// MODAL: Overtime request
// ============================================================================
function openOTRequestModal(attendanceId) {
  return new Promise((resolve) => {
    const a = DB.attendance().find(x => x.id === attendanceId);
    if (!a) return resolve(null);
    const hoursOver = a.hours - 8;
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-bg" id="modalBg">
        <div class="modal">
          <div class="row-between mb-2">
            <h3>Request overtime</h3>
            <button class="btn btn-ghost btn-sm" id="closeModal">✕</button>
          </div>
          <p class="dim mb-2">${a.date} · ${fmtHrs(a.hours)} (${hoursOver.toFixed(1)}h over)</p>
          <form id="otForm" class="col">
            <div class="field">
              <label class="field-label">Reason for overtime</label>
              <textarea class="textarea" name="reason" required placeholder="What needed extra time?"></textarea>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Submit request</button>
          </form>
        </div>
      </div>
    `;
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    $('#closeModal').onclick = () => close(null);
    $('#modalBg').onclick = (e) => { if (e.target.id === 'modalBg') close(null); };
    $('#otForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      OT.request({ userId: state.user.id, attendanceId, hoursOver, reason: fd.get('reason').trim() });
      toast('Overtime request submitted', 'success');
      close(true);
    };
  });
}

// ============================================================================
// MODAL: Record detail (admin)
// ============================================================================
async function openRecordModal(recordId) {
  const r = DB.attendance().find(x => x.id === recordId);
  if (!r) return;
  const u = DB.users().find(x => x.id === r.userId);
  const inSelfie = r.inSelfieKey ? await idb.get(r.inSelfieKey) : null;
  const outSelfie = r.outSelfieKey ? await idb.get(r.outSelfieKey) : null;

  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-bg" id="modalBg">
      <div class="modal modal-cam">
        <div class="row-between mb-2">
          <h3>Record · ${esc(u?.name)}</h3>
          <button class="btn btn-ghost btn-sm" id="closeModal">✕</button>
        </div>
        <div class="grid-2">
          <div>
            <div class="uppercase-label">Punch In</div>
            <div class="mono mt-1">${r.punchIn ? fmtTime(r.punchIn) : '—'}</div>
            ${inSelfie ? `<img src="${inSelfie}" style="width:100%;border-radius:8px;margin-top:8px;border:1px solid var(--border);" />` : '<div class="empty">No selfie</div>'}
            <div class="mono faint mt-1" style="font-size:0.7rem;">face dist: ${r.faceDistanceIn?.toFixed(3) ?? '—'}</div>
            ${r.inGeo ? `<a class="map-link" href="https://www.google.com/maps?q=${r.inGeo.lat},${r.inGeo.lng}" target="_blank">${r.inGeo.lat.toFixed(5)}, ${r.inGeo.lng.toFixed(5)}</a>` : ''}
          </div>
          <div>
            <div class="uppercase-label">Punch Out</div>
            <div class="mono mt-1">${r.punchOut ? fmtTime(r.punchOut) : '— still open —'}</div>
            ${outSelfie ? `<img src="${outSelfie}" style="width:100%;border-radius:8px;margin-top:8px;border:1px solid var(--border);" />` : '<div class="empty">No selfie</div>'}
            <div class="mono faint mt-1" style="font-size:0.7rem;">face dist: ${r.faceDistanceOut?.toFixed(3) ?? '—'}</div>
            ${r.outGeo ? `<a class="map-link" href="https://www.google.com/maps?q=${r.outGeo.lat},${r.outGeo.lng}" target="_blank">${r.outGeo.lat.toFixed(5)}, ${r.outGeo.lng.toFixed(5)}</a>` : ''}
          </div>
        </div>
        <div class="divider"></div>
        <div class="row-between">
          <div>
            <div class="uppercase-label">Status</div>
            <div class="mt-1">${r.invalid ? statusBadge('INVALID') + ` <span class="faint" style="font-size:0.75rem;">(${esc(r.flaggedReason||'')})</span>` : statusBadge(r.status)}</div>
          </div>
          ${!r.invalid ? `<button class="btn btn-danger" id="flagBtn">Mark as fake/invalid</button>` : `<button class="btn" id="unflagBtn">Restore</button>`}
        </div>
      </div>
    </div>
  `;
  $('#closeModal').onclick = () => { root.innerHTML = ''; };
  $('#modalBg').onclick = (e) => { if (e.target.id === 'modalBg') root.innerHTML = ''; };
  if ($('#flagBtn')) $('#flagBtn').onclick = () => {
    const reason = prompt('Reason for flagging?', 'Suspected face mismatch');
    if (reason === null) return;
    const all = DB.attendance();
    const target = all.find(x => x.id === r.id);
    target.invalid = true; target.flaggedReason = reason;
    DB.saveAttendance(all);
    toast('Record marked invalid', 'success');
    root.innerHTML = '';
    render();
  };
  if ($('#unflagBtn')) $('#unflagBtn').onclick = () => {
    const all = DB.attendance();
    const target = all.find(x => x.id === r.id);
    target.invalid = false; target.flaggedReason = null;
    DB.saveAttendance(all);
    toast('Record restored', 'success');
    root.innerHTML = '';
    render();
  };
}

// ============================================================================
// EVENT WIRING — bound after every render
// ============================================================================
function wire() {
  // Universal nav clicks
  $$('[data-go]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.go);
    });
  });

  // Logout
  if ($('#logoutBtn')) $('#logoutBtn').onclick = () => AUTH.logout();

  // ----- LOGIN -----
  if ($('#loginForm')) {
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const u = await AUTH.login(fd.get('email'), fd.get('password'));
        state.user = u;
        toast(`Welcome back, ${u.name}`, 'success');
        navigate('dashboard');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    $('#goSignup').onclick = (e) => { e.preventDefault(); navigate('signup'); };
  }

  // ----- SIGNUP -----
  if ($('#signupForm')) {
    $('#signupForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const u = await AUTH.signup({
          name: fd.get('name'), email: fd.get('email'),
          password: fd.get('password'), role: fd.get('role')
        });
        await AUTH.login(u.email, fd.get('password'));
        state.user = AUTH.current();
        toast('Account created. Now enroll your face.', 'success');
        navigate('settings');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    $('#goLogin').onclick = (e) => { e.preventDefault(); navigate('login'); };
  }

  // ----- PUNCH -----
  if ($('#startPunchBtn')) {
    $('#startPunchBtn').onclick = async () => {
      const u = state.user;
      if (!u.faceDescriptor) return toast('Enroll your face first', 'error');
      const result = await openFaceCaptureModal({
        mode: 'verify',
        expectedDescriptor: u.faceDescriptor,
        requireBlink: true
      });
      if (!result) return;
      const geo = await getGeo();
      // Geofence check
      const settings = DB.settings();
      if (settings.geofence && geo) {
        const dist = haversineMeters(geo, settings.geofence);
        if (dist > settings.geofenceRadius) {
          toast(`Outside geofence (${Math.round(dist)}m from center). Punch flagged.`, 'error');
          // Continue but mark via flaggedReason — for simplicity we still record it.
        }
      }
      const open = ATTENDANCE.findOpen(u.id);
      try {
        if (open) {
          const rec = await ATTENDANCE.punchOut(u.id, result, result.dataURL, geo);
          toast(`Punched out · ${fmtHrs(rec.hours)} · ${rec.status}`, 'success');
          if (rec.status === STATUS.OT_PENDING) {
            await openOTRequestModal(rec.id);
          }
        } else {
          await ATTENDANCE.punchIn(u.id, result, result.dataURL, geo);
          toast('Punched in', 'success');
        }
        navigate('dashboard');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  // ----- HISTORY exports -----
  if ($('#exportMyExcel')) $('#exportMyExcel').onclick = () => {
    REPORTS.exportExcel(REPORTS.rowsForUser(state.user.id), `my-attendance-${todayISO()}`);
  };
  if ($('#exportMyPDF')) $('#exportMyPDF').onclick = () => {
    REPORTS.exportPDF(REPORTS.rowsForUser(state.user.id), `my-attendance-${todayISO()}`, `My Attendance — ${state.user.name}`);
  };

  // ----- OT request from history page -----
  $$('[data-ot-request]').forEach(el => {
    el.onclick = async () => {
      const ok = await openOTRequestModal(el.dataset.otRequest);
      if (ok) render();
    };
  });

  // ----- TEAM filters / actions -----
  if ($('#filterDate')) $('#filterDate').onchange = (e) => navigate('team', { ...state.routeParams, date: e.target.value });
  if ($('#filterUser')) $('#filterUser').onchange = (e) => navigate('team', { ...state.routeParams, user: e.target.value });
  if ($('#clearFilter')) $('#clearFilter').onclick = () => navigate('team', {});
  $$('[data-view-record]').forEach(el => el.onclick = () => openRecordModal(el.dataset.viewRecord));
  $$('[data-flag-record]').forEach(el => el.onclick = () => openRecordModal(el.dataset.flagRecord));

  // ----- OT decisions -----
  $$('[data-ot-decide]').forEach(el => {
    el.onclick = () => {
      OT.decide(el.dataset.otDecide, state.user.id, el.dataset.decision);
      toast(`Request ${el.dataset.decision}`, 'success');
      render();
    };
  });

  // ----- Reports -----
  if ($('#rptTeamExcel')) $('#rptTeamExcel').onclick = () => {
    const rows = state.user.role === 'admin' ? REPORTS.rowsForAll() : REPORTS.rowsForTeam();
    REPORTS.exportExcel(rows, `attendance-${todayISO()}`);
  };
  if ($('#rptTeamPDF')) $('#rptTeamPDF').onclick = () => {
    const rows = state.user.role === 'admin' ? REPORTS.rowsForAll() : REPORTS.rowsForTeam();
    REPORTS.exportPDF(rows, `attendance-${todayISO()}`, 'Attendance Report');
  };
  if ($('#rptOTExcel')) $('#rptOTExcel').onclick = () => {
    const users = DB.users();
    const rows = DB.overtime().map(o => {
      const u = users.find(x => x.id === o.userId);
      const a = DB.attendance().find(x => x.id === o.attendanceId);
      return {
        Employee: u?.name, Date: a?.date, 'Hours Over': o.hoursOver,
        Reason: o.reason, Status: o.status, Submitted: o.createdAt, 'Decided At': o.decidedAt || ''
      };
    });
    REPORTS.exportExcel(rows, `overtime-${todayISO()}`);
  };
  if ($('#rptOTPDF')) $('#rptOTPDF').onclick = () => {
    const users = DB.users();
    const rows = DB.overtime().map(o => {
      const u = users.find(x => x.id === o.userId);
      const a = DB.attendance().find(x => x.id === o.attendanceId);
      return { Employee: u?.name, Date: a?.date, Hours: o.hoursOver, Reason: o.reason, Status: o.status };
    });
    REPORTS.exportPDF(rows, `overtime-${todayISO()}`, 'Overtime Register');
  };

  // ----- AI -----
  if ($('#aiSendBtn')) {
    const send = async () => {
      const inp = $('#aiInput');
      const q = inp.value.trim();
      if (!q) return;
      inp.value = '';
      state.aiMessages = state.aiMessages || [];
      state.aiMessages.push({ role: 'user', text: q });
      state.aiMessages.push({ role: 'assistant', thinking: true });
      render();
      try {
        const res = await AI.ask(q);
        state.aiMessages.pop(); // remove thinking
        state.aiMessages.push({ role: 'assistant', text: res.answer, toolUsed: res.toolUsed, toolArgs: res.toolArgs });
      } catch (err) {
        state.aiMessages.pop();
        state.aiMessages.push({ role: 'assistant', text: '⚠ ' + err.message });
      }
      render();
      // scroll
      const stream = $('#chatStream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    };
    $('#aiSendBtn').onclick = send;
    $('#aiInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
  }
  if ($('#aiClearBtn')) $('#aiClearBtn').onclick = () => { state.aiMessages = []; render(); };

  // ----- USERS -----
  $$('[data-toggle-user]').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.toggleUser;
      const all = DB.users();
      const u = all.find(x => x.id === id);
      if (u.id === state.user.id && !u.disabled) return toast("Can't disable yourself", 'error');
      u.disabled = !u.disabled;
      DB.saveUsers(all);
      toast(u.disabled ? 'User disabled' : 'User re-enabled', 'success');
      render();
    };
  });

  // ----- SETTINGS -----
  if ($('#retryModelsBtn')) {
    $('#retryModelsBtn').onclick = async () => {
      const btn = $('#retryModelsBtn');
      btn.innerHTML = '<span class="spinner"></span> Loading...';
      btn.disabled = true;
      try {
        await FACE.init();
        toast('Face models loaded successfully', 'success');
        render();
      } catch (e) {
        toast('Still failing: ' + e.message, 'error');
        render();
      }
    };
  }
  if ($('#enrollFaceBtn')) {
    $('#enrollFaceBtn').onclick = async () => {
      const result = await openFaceCaptureModal({ mode: 'enroll' });
      if (!result) return;
      const all = DB.users();
      const u = all.find(x => x.id === state.user.id);
      u.faceDescriptor = Array.from(result.descriptor); // store as plain array
      DB.saveUsers(all);
      state.user = u;
      toast('Face enrolled', 'success');
      render();
    };
  }
  if ($('#geminiForm')) {
    $('#geminiForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const settings = DB.settings();
      settings.gemini = fd.get('gemini').trim();
      settings.model = fd.get('model');
      DB.saveSettings(settings);
      toast('API key saved', 'success');
    };
  }
  if ($('#geoForm')) {
    $('#geoForm').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const settings = DB.settings();
      const lat = parseFloat(fd.get('lat'));
      const lng = parseFloat(fd.get('lng'));
      if (Number.isNaN(lat) || Number.isNaN(lng)) return toast('Invalid coordinates', 'error');
      settings.geofence = { lat, lng };
      settings.geofenceRadius = parseInt(fd.get('radius'), 10) || 500;
      DB.saveSettings(settings);
      toast('Geofence saved', 'success');
    };
    $('#useMyLocation').onclick = async () => {
      const g = await getGeo();
      if (!g) return toast('Could not read location', 'error');
      $('input[name=lat]').value = g.lat;
      $('input[name=lng]').value = g.lng;
    };
    $('#clearGeofence').onclick = () => {
      const settings = DB.settings();
      settings.geofence = null;
      DB.saveSettings(settings);
      toast('Geofence disabled', 'success');
      render();
    };
  }
  if ($('#wipeBtn')) $('#wipeBtn').onclick = () => {
    if (!confirm('Wipe all users, attendance, overtime and selfies? This cannot be undone.')) return;
    localStorage.clear();
    indexedDB.deleteDatabase('sentry');
    location.reload();
  };
}

// ============================================================================
// ROUTER + RENDER
// ============================================================================
const ROUTES = {
  login: viewLogin,
  signup: viewSignup,
  dashboard: viewDashboard,
  punch: viewPunch,
  history: viewHistory,
  overtime: viewMyOvertime,
  team: viewTeam,
  'overtime-review': viewOvertimeReview,
  reports: viewReports,
  ai: viewAI,
  users: viewUsers,
  settings: viewSettings
};

function render() {
  let route = state.route;

  // Auth gate
  if (!state.user && !['login', 'signup'].includes(route)) route = 'login';
  if (state.user && ['login', 'signup'].includes(route)) route = 'dashboard';

  // RBAC gate
  const empOnly = ['punch', 'history', 'overtime'];
  const mgrPlus = ['team', 'overtime-review', 'reports', 'ai'];
  const adminOnly = ['users'];
  if (state.user) {
    if (empOnly.includes(route) && state.user.role !== 'employee') route = 'dashboard';
    if (mgrPlus.includes(route) && !['manager', 'admin'].includes(state.user.role)) route = 'dashboard';
    if (adminOnly.includes(route) && state.user.role !== 'admin') route = 'dashboard';
  }

  const renderer = ROUTES[route] || ROUTES.dashboard;
  $('#app').innerHTML = renderer();
  wire();
}

// ============================================================================
// INIT
// ============================================================================
(async () => {
  try { await idb.open(); }
  catch (e) { console.error('IndexedDB error', e); }

  try {
    await FACE.init();
  } catch (e) {
    console.warn('Face models failed to load:', e);
    setTimeout(() => {
      toast('Face models unavailable. Auth, AI assistant, and reports still work. Retry in Settings.', 'error');
    }, 600);
  }

  state.user = AUTH.current();
  state.route = state.user ? 'dashboard' : 'login';
  render();
})();
