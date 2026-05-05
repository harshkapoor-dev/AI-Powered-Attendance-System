# SENTRY — Attendance Intelligence

> Single-file attendance management system with face recognition, geolocation, and an AI analytics agent. Works entirely client-side; data lives in the browser.

![status](https://img.shields.io/badge/status-demo-c0ff3e?style=flat-square)
![stack](https://img.shields.io/badge/stack-vanilla%20JS-1c1c22?style=flat-square)
![ai](https://img.shields.io/badge/AI-Gemini-blue?style=flat-square)
![face](https://img.shields.io/badge/face--api-0.22.2-orange?style=flat-square)

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Tech Stack](#tech-stack)
4. [Architecture](#architecture)
5. [Quick Start](#quick-start)
6. [Configuration & Environment](#configuration--environment)
7. [Roles & Permissions](#roles--permissions)
8. [Attendance Logic](#attendance-logic)
9. [AI Assistant — Tool API](#ai-assistant--tool-api)
10. [Data Model](#data-model)
11. [Browser Requirements](#browser-requirements)
12. [Deployment](#deployment)
13. [Troubleshooting](#troubleshooting)
14. [Limitations](#limitations)
15. [Production Migration Path](#production-migration-path)
16. [Project Structure](#project-structure)
17. [License](#license)

---

## Overview

SENTRY is a complete attendance management system packaged into a single HTML file. It supports three roles (Employee / Manager / Admin), authenticates users with face recognition, records geolocation with each punch, calculates overtime, and includes an AI assistant powered by Google Gemini that answers natural-language questions about attendance data via a tool-calling pattern.

It runs entirely in the browser — no backend, no installation, no build step. Data persists in `localStorage` and `IndexedDB`. This makes it ideal as a demo, prototype, or learning artifact, but **not** as a multi-user production deployment (see [Production Migration Path](#production-migration-path)).

---

## Features

**Authentication & Access Control**
- Salted SHA-256 password hashing (Web Crypto API)
- Three roles: Employee, Manager, Admin
- Role-based route gating — UI and routes both enforce permissions
- Session persisted across reloads

**Smart Attendance**
- Live webcam capture only — no file upload path exists
- Face descriptors computed locally with `face-api.js` (TinyFaceDetector → Landmark68 → FaceRecognition)
- L2-distance matching against enrolled descriptor (threshold `< 0.55`)
- Eye-Aspect-Ratio blink detection as an anti-spoof check (a still photo can't blink)
- Geolocation captured on every punch via `navigator.geolocation`
- Selfies stored as JPEG dataURLs in IndexedDB

**Workflow**
- Hours classified automatically: PRESENT (8–8.5h) · INCOMPLETE (<8h) · OT_PENDING (>8.5h)
- Overtime requires explicit request → manager/admin approval → status reflected on the record
- Admin can view both selfies + geo + face-distance for any record, mark as fake/invalid with reason, restore, or disable users

**Reports**
- PDF export (jsPDF + autotable, landscape)
- Excel export (SheetJS)
- Scoped per role: Employee → own data, Manager → team, Admin → all

**AI Assistant**
- Google Gemini integration (free tier, user provides key)
- Tool-calling pattern — Gemini picks one of six functions, server-side equivalent executes locally, Gemini formats the answer
- Six tools: late arrivals, under-8h, pending OT, summary, user history, disabled users

**Bonus features (assessment "Bonus" section)**
- Geofencing (configurable center + radius, default 500m, haversine distance)
- Anti-spoof via blink detection
- Dark theme (only theme — designed dark-first)

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Browser only | No Node, no build, no server |
| UI | Vanilla JS + Tailwind CDN | Single-file constraint; React via CDN+Babel was rejected as too heavy |
| Face recognition | [face-api.js](https://github.com/justadudewhohacks/face-api.js) `0.22.2` | TinyFaceDetector + FaceLandmark68 + FaceRecognitionNet |
| Storage | `localStorage` + `IndexedDB` | LS for records (analogous to Mongo collections), IDB for selfies (LS is too small) |
| Crypto | Web Crypto API | SHA-256 with random salt |
| AI | Google Gemini API (`v1beta/generateContent`) | Free tier; user supplies API key |
| Reports | jsPDF + jspdf-autotable + SheetJS | All via CDN |
| Geolocation | `navigator.geolocation` | + Haversine distance for geofencing |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       sentry-attendance.html                    │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   AUTH      │  │  FACE       │  │  ATTENDANCE             │  │
│  │  signup,    │  │  init,      │  │  punchIn, punchOut,     │  │
│  │  login,     │  │  detect,    │  │  classify, geofence     │  │
│  │  RBAC       │  │  match,     │  │                         │  │
│  │             │  │  blink      │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│         │              │                     │                  │
│  ┌──────┴──────────────┴─────────────────────┴───────────────┐  │
│  │              STORAGE LAYER                                │  │
│  │  localStorage: users, attendance, overtime, settings      │  │
│  │  IndexedDB:    selfies (binary-ish dataURLs)              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────┐  ┌─────────────────────────────────────────┐   │
│  │  REPORTS    │  │  AI (Gemini tool-calling)               │   │
│  │  PDF / XLSX │  │  ask → tool_call → exec → format        │   │
│  └─────────────┘  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The single file is organized in distinct logical sections (search for these comment headers in the source):

```
SENTRY — Single-file Attendance System
  ├── Tiny utilities
  ├── Crypto
  ├── IndexedDB wrapper
  ├── localStorage layer
  ├── DATA MODEL — collections
  ├── FACE RECOGNITION MODULE
  ├── CAMERA HELPERS
  ├── GEOLOCATION
  ├── AUTH
  ├── ATTENDANCE LOGIC
  ├── OVERTIME
  ├── AI ASSISTANT (Gemini, tool-calling pattern)
  ├── REPORTS — PDF / Excel
  ├── STATE + ROUTER
  ├── VIEW HELPERS
  ├── VIEWS — login / signup / dashboard / ...
  ├── MODALS — face capture, OT request, record detail
  ├── EVENT WIRING
  ├── ROUTER + RENDER
  └── INIT
```

---

## Quick Start

```bash
# 1. Download sentry-attendance.html

# 2. Open it directly in a modern browser:
#    macOS:    open sentry-attendance.html
#    Linux:    xdg-open sentry-attendance.html
#    Windows:  start sentry-attendance.html
```

> **Important:** Open the file as a **regular browser tab**, not inside an embedded iframe (some preview iframes sandbox external fetches and will block face-api.js model downloads).

On first load, the app downloads ~6 MB of face recognition models from CDN. This takes a few seconds.

**First-time setup flow:**

1. Sign up — pick role `Admin`
2. Settings → Enroll face (camera will activate; stay still for ~2 seconds)
3. Settings → Paste your Gemini API key (free, see below) → Save
4. Sign up another account as `Employee` in a different browser/incognito → enroll face → punch in
5. Switch back to Admin to see the punch in Today's punches and ask the AI Assistant about it

### Get a free Gemini API key

1. Go to <https://aistudio.google.com/apikey>
2. Sign in with a Google account
3. Click **Create API key** → copy the key starting with `AIza...`
4. Paste into Settings → Gemini API → Save

The free tier allows ~15 requests per minute on `gemini-2.0-flash`, more than enough for this demo.

---

## Configuration & Environment

This being a client-side app, configuration lives in `localStorage` under the `settings` key. There is no `.env` file. All settings are managed through the **Settings** view in the UI.

| Setting | UI location | Default | Notes |
|---|---|---|---|
| Gemini API key | Settings → Gemini API | `''` | Required for AI Assistant |
| Gemini model | Settings → Gemini API | `gemini-2.0-flash` | Also: `gemini-2.5-flash`, `gemini-1.5-flash` |
| Geofence center | Settings → Geofencing (admin only) | `null` (disabled) | Lat/lng pair |
| Geofence radius | Settings → Geofencing | `500` (meters) | Punches outside are flagged but allowed |

### Hard-coded constants (edit in source if needed)

| Constant | File location | Default | Purpose |
|---|---|---|---|
| `FACE.matchThreshold` | `FACE` module | `0.55` | L2 distance threshold for face match — lower is stricter |
| Blink EAR delta | inside detection loop | `0.08` | Eye-Aspect-Ratio change required to register a blink |
| Detection input size | `detectDescriptor` | `320` | TinyFaceDetector input size; larger = more accurate, slower |
| PRESENT range | `ATTENDANCE.classify` | `8 ≤ h ≤ 8.5` | Anything above triggers OT_PENDING |

---

## Roles & Permissions

| Capability | Employee | Manager | Admin |
|---|:-:|:-:|:-:|
| Sign up / log in | ✓ | ✓ | ✓ |
| Enroll own face | ✓ | ✓ | ✓ |
| Punch in / out | ✓ | — | — |
| View own attendance | ✓ | ✓ | ✓ |
| Request overtime | ✓ | — | — |
| Approve / reject overtime | — | ✓ | ✓ |
| View team attendance | — | ✓ | ✓ |
| Filter / search records | — | ✓ | ✓ |
| Export reports (PDF/XLSX) | own only | team | all |
| Use AI Assistant | — | ✓ | ✓ |
| Mark record as fake/invalid | — | — | ✓ |
| Restore invalidated record | — | — | ✓ |
| Disable / re-enable users | — | — | ✓ |
| Configure geofence | — | — | ✓ |

RBAC is enforced both in the sidebar (hidden items) and in the router (`render()` rejects unauthorized routes and falls back to `dashboard`).

---

## Attendance Logic

### Punch flow

```
User clicks "Punch In/Out"
  → Camera modal opens
  → Continuous detection loop:
      • Detect face → compute 128-dim descriptor
      • Match descriptor vs enrolled (L2 distance < 0.55)
      • Track Eye-Aspect-Ratio history → require blink (anti-spoof)
  → User clicks "Capture" (only enabled when match + blink confirmed)
  → Selfie dataURL saved to IndexedDB
  → Geolocation read (if permitted)
  → Geofence check (if configured) — flag if outside
  → Record written to localStorage
```

### Status classification

| Worked hours `h` | Status |
|---|---|
| `h < 8` | `INCOMPLETE` |
| `8 ≤ h ≤ 8.5` | `PRESENT` |
| `h > 8.5` | `OT_PENDING` (until OT request approved) |
| OT approved by manager/admin | `OT_APPROVED` |
| OT rejected | reverts to `PRESENT` (capped at 8h credited) |

### Anti-spoof (bonus)

Eye Aspect Ratio (EAR) is computed from face landmarks on each frame. A still photo or screen will have a constant EAR. A live face naturally varies as the person blinks. We require the (max EAR − min EAR) over a 30-frame rolling window to exceed `0.08` before allowing capture. This defeats trivial print/screen-replay attacks.

---

## AI Assistant — Tool API

The assistant uses a **tool-calling** pattern instead of letting Gemini write database queries directly. This is safer (no query injection), easier to evaluate, and easier to debug.

### Flow

```
User question
  → Gemini (with tool spec)
  → Gemini returns JSON: { tool, args }
  → Browser executes the tool against local data
  → Result fed back to Gemini
  → Gemini returns natural-language answer
```

### Tools

#### `get_late_arrivals(date?, threshold_hour?)`

List employees who punched in after a given hour on a given date.

| Param | Type | Default | Description |
|---|---|---|---|
| `date` | string | today | `YYYY-MM-DD` |
| `threshold_hour` | int | `9` | Hour cutoff (0–23) |

**Returns:** array of `{ name, email, punch_in, date }`

---

#### `get_employees_under_8hrs(date?)`

List employees whose worked hours on a date are less than 8 (incomplete).

| Param | Type | Default | Description |
|---|---|---|---|
| `date` | string | today | `YYYY-MM-DD` |

**Returns:** array of `{ name, hours, status }`

---

#### `get_pending_overtime()`

List all overtime requests with status `pending`. No parameters.

**Returns:** array of `{ name, hours_over, reason, requested_at }`

---

#### `get_attendance_summary(start_date?, end_date?)`

Aggregate counts of present, incomplete, OT_PENDING for a date range.

| Param | Type | Default | Description |
|---|---|---|---|
| `start_date` | string | today | `YYYY-MM-DD` |
| `end_date` | string | today | `YYYY-MM-DD` |

**Returns:** `{ range, total_records, present, incomplete, ot_pending, total_hours }`

---

#### `get_user_history(name, limit?)`

Recent attendance records for a specific user, matched by name (case-insensitive substring).

| Param | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Partial or full employee name |
| `limit` | int | `10` | Max records to return |

**Returns:** `{ user, records: [{ date, punch_in, punch_out, hours, status }] }` or `{ error }`

---

#### `get_disabled_users()`

List currently disabled accounts. No parameters.

**Returns:** array of `{ name, email }`

### Example Gemini API call

```http
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=YOUR_KEY
Content-Type: application/json

{
  "contents": [
    { "role": "user", "parts": [{ "text": "<system prompt + tool spec>\n\nUser question: who came late today" }] }
  ],
  "generationConfig": { "temperature": 0.3 }
}
```

### Sample interactions

```
You:  who came in late today
AI:   → called get_late_arrivals({"date":"2026-05-05","threshold_hour":9})
      Two employees punched in after 9 AM today: Riya Sharma (09:42) and
      Aman Verma (10:15).

You:  any pending OT requests?
AI:   → called get_pending_overtime()
      Yes, one request pending — Aman Verma is requesting 2.5h overtime
      for "client deployment", submitted 2 hours ago.

You:  give me a summary for this week
AI:   → called get_attendance_summary({"start_date":"2026-05-01","end_date":"2026-05-05"})
      This week so far: 23 records, 18 present, 4 incomplete, 1 OT pending,
      total 184.5 hours worked.
```

---

## Data Model

These schemas describe the shape of objects stored in `localStorage`. They map directly to MongoDB collections in a production migration — names are intentionally aligned.

### `users` (localStorage key: `users`)

```ts
{
  id: string,                    // "id_abc123def..."
  name: string,
  email: string,                 // unique
  role: "employee" | "manager" | "admin",
  passwordHash: string,          // "salt:sha256hex"
  disabled: boolean,
  faceDescriptor: number[] | null,  // 128 floats; null until enrolled
  createdAt: string              // ISO 8601
}
```

### `attendance` (localStorage key: `attendance`)

```ts
{
  id: string,
  userId: string,
  date: string,                  // "YYYY-MM-DD"
  punchIn: string,               // ISO 8601
  punchOut: string | null,
  hours: number,
  status: "PRESENT" | "INCOMPLETE" | "OT_PENDING" | "OT_APPROVED",
  inGeo: { lat: number, lng: number, accuracy: number } | null,
  outGeo: { lat: number, lng: number, accuracy: number } | null,
  inSelfieKey: string,           // IndexedDB key
  outSelfieKey: string | null,
  faceDistanceIn: number,        // L2 distance at match time
  faceDistanceOut: number | null,
  invalid: boolean,
  flaggedReason: string | null,
  createdAt: string
}
```

### `overtime` (localStorage key: `overtime`)

```ts
{
  id: string,
  userId: string,
  attendanceId: string,
  hoursOver: number,
  reason: string,
  status: "pending" | "approved" | "rejected",
  decidedBy: string | null,      // user id of approver
  decidedAt: string | null,
  createdAt: string
}
```

### `settings` (localStorage key: `settings`)

```ts
{
  geofence: { lat: number, lng: number } | null,
  geofenceRadius: number,        // meters
  gemini: string,                // API key
  model: string                  // "gemini-2.0-flash" | "gemini-2.5-flash" | "gemini-1.5-flash"
}
```

### `selfies` (IndexedDB store)

Key-value store where keys are `selfie_<recordId>_in` or `selfie_<recordId>_out`, values are JPEG dataURLs (`data:image/jpeg;base64,...`).

---

## Browser Requirements

| Requirement | Why | Tested on |
|---|---|---|
| `navigator.mediaDevices.getUserMedia` | Live camera capture | Chrome 110+, Firefox 110+, Edge 110+, Safari 16+ |
| `IndexedDB` | Selfie storage | All modern browsers |
| `crypto.subtle` | Password hashing | Requires HTTPS or `localhost` |
| WebGL | face-api.js inference | All modern browsers |
| `navigator.geolocation` | Punch location (optional) | All modern browsers |

> **HTTPS or `file://` or `localhost`** — `crypto.subtle` and `getUserMedia` require a secure context. Opening the file directly via `file://` works; serving over plain HTTP from a non-localhost address will not.

---

## Deployment

Because this is a static HTML file, deployment is trivial. Pick any of:

```bash
# Netlify drop
# → drag-and-drop the file at https://app.netlify.com/drop

# Vercel
vercel deploy

# GitHub Pages
git add sentry-attendance.html
git commit -m "deploy"
git push
# Then enable Pages on the repo, point to root or /docs

# Surge
npx surge ./

# Local dev
python3 -m http.server 8000
# → open http://localhost:8000/sentry-attendance.html
```

> The Gemini API key is stored in the user's `localStorage`. Each user provides their own key. **Do not embed your key in the file.**

---

## Troubleshooting

### "Failed to load face models"

The face-api.js model files are ~6 MB and load from CDN. The app tries three CDNs in order:
1. `cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights`
2. `justadudewhohacks.github.io/face-api.js/models`
3. `raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights`

If all fail:
- Open DevTools → Network → check which URL is failing and why
- The app will still load — you can use auth, AI assistant, and reports without face features
- Click **Settings → Retry loading models** to try again

### Camera doesn't activate

- Make sure you opened the file via `file://`, `http://localhost`, or `https://` — not via `http://` on a remote address
- Browser permissions: site-settings → camera → allow
- On Mac: System Settings → Privacy → Camera → enable for your browser

### "No match" even though it's me

- Lighting matters — try re-enrolling under similar lighting to where you'll punch
- Loosen the threshold by editing `FACE.matchThreshold` from `0.55` to `0.6`
- Make sure you blink during verification (anti-spoof requires it)

### AI Assistant says "Gemini API key not configured"

- Go to Settings → Gemini API → paste key → Save
- Verify the key works at <https://aistudio.google.com/apikey>

### Data is gone

- `localStorage` is per-origin. Opening from a different path or incognito mode = different storage
- "Clear browsing data" wipes it
- For multi-machine use, you'd need a real backend (see Production Migration Path below)

---

## Limitations

This is a single-file demo. It is **not** production-ready as-is:

- **Single-machine** — data lives in the browser, no sync across devices
- **No real backend** — no multi-user concurrency, no audit trail beyond what's in `localStorage`
- **Trust boundary** — face descriptors and password hashes are visible to any JS running on the same page
- **No password reset flow** — admin can disable accounts but can't reset passwords
- **Gemini key in localStorage** — fine for personal use, problematic for shared deployment
- **Geofencing is advisory** — flagged but not blocked, since geofence config is also client-side
- **Email is the username** — no separate handle/employee-id

---

## Production Migration Path

To match the original assessment spec (FastAPI + MongoDB + React/Vite + deployment), here's the conversion plan. Notably, the data model and AI tool-calling design transfer directly.

### Backend: FastAPI

```
backend/
├── app/
│   ├── main.py                 # FastAPI app, CORS, routers
│   ├── core/
│   │   ├── config.py           # pydantic-settings, reads .env
│   │   ├── security.py         # JWT, password hashing (passlib)
│   │   └── deps.py             # get_current_user, require_role
│   ├── db/
│   │   └── mongo.py            # motor.AsyncIOMotorClient
│   ├── models/
│   │   ├── user.py             # ← matches `users` schema above
│   │   ├── attendance.py       # ← matches `attendance` schema
│   │   └── overtime.py         # ← matches `overtime` schema
│   ├── routers/
│   │   ├── auth.py             # /signup, /login, /me
│   │   ├── face.py             # /enroll, /verify (face-recognition lib)
│   │   ├── attendance.py       # /punch-in, /punch-out, /history
│   │   ├── overtime.py         # /request, /decide, /list
│   │   ├── admin.py            # /users, /flag, /disable
│   │   ├── reports.py          # /export.{pdf,xlsx}
│   │   └── ai.py               # /ask — same tool-calling logic
│   └── services/
│       ├── face_service.py     # OpenCV + face-recognition
│       ├── ai_tools.py         # the 6 tool functions, server-side
│       └── geo_service.py      # geofence + haversine
├── requirements.txt
├── Dockerfile
└── .env.example
```

### Frontend: React + Vite + Redux Toolkit

```
frontend/
├── src/
│   ├── app/store.js            # configureStore
│   ├── features/
│   │   ├── auth/authSlice.js
│   │   ├── attendance/attendanceSlice.js
│   │   ├── overtime/overtimeSlice.js
│   │   └── ai/aiSlice.js
│   ├── api/client.js           # axios instance + JWT interceptor
│   ├── components/
│   │   ├── WebcamCapture.jsx   # getUserMedia, no upload
│   │   ├── AttendanceTable.jsx
│   │   ├── OTApproval.jsx
│   │   ├── AdminPanel.jsx
│   │   └── AIChat.jsx
│   └── pages/                  # one per route
├── vite.config.js
└── .env.example
```

### Environment variables (`.env`)

```ini
# backend/.env
MONGODB_URI=mongodb+srv://...mongodb.net/sentry
JWT_SECRET=change-me-to-something-long-and-random
JWT_ALGORITHM=HS256
JWT_EXPIRES_MINUTES=1440
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash
FACE_MATCH_THRESHOLD=0.55
GEOFENCE_LAT=
GEOFENCE_LNG=
GEOFENCE_RADIUS_M=500
CORS_ORIGINS=http://localhost:5173,https://your-frontend.netlify.app
```

```ini
# frontend/.env
VITE_API_BASE=https://your-backend.onrender.com
```

### Deployment

- **Backend** → Render (Docker or native Python), exposes `/api/*`
- **Frontend** → Netlify or Vercel, builds with `vite build`, serves `dist/`
- **Database** → MongoDB Atlas free tier (M0)
- **AI** → Gemini key lives only in backend env, frontend never sees it

### What transfers cleanly from this demo

- The 6 AI tools, almost line-for-line — port `AI.exec.*` from JS to Python
- The status classification logic (`classify(hours)`)
- The data schemas — already shaped like Mongo documents
- The blink-based anti-spoof concept (do it client-side as before, send a "liveness verified" flag to backend, OR move EAR computation to Python)
- The role-based UI (just port the route gating into a React `<RequireRole>` wrapper)

---

## Project Structure

```
.
├── sentry-attendance.html      # the entire app
└── README.md                   # this file
```

That's it. One file.

**Built for an AI-Powered Attendance assessment, by Siddhant.**
