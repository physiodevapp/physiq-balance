# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

PhysiQ-Balance is a mobile-first postural stability measurement app for physiotherapy. It uses the phone's accelerometer (`DeviceMotionEvent`) to quantify balance by measuring postural sway during standardized standing tests. Results are saved to the shared PhysiQ session.

**Deployment:** GitHub Pages — push to `main` deploys automatically. The hub (`physiodevapp.github.io/physiq/`) is the primary entry point; this app is also accessible standalone.

## Development

No build step, no package manager, no dependencies. Static HTML/CSS/JS.

Run locally:
```
npx serve .
```

No unit tests yet.

## Commit format

Always use this format when committing:

```
git commit -m "short imperative title" -m "description when needed"
```

- First `-m` is the title (max ~72 characters)
- Second `-m` is only included when there is relevant context to add
- Never use `git commit` without flags or interactive editors
- **Never add co-authorship** (`Co-authored-by`) under any circumstance

## Pull request format

- PR body: plain description only — no `🤖 Generated with Claude Code` line, no session URLs, no co-authorship footers

## File Architecture

| File | Role |
|------|------|
| `index.html` | DOM structure + all embedded CSS |
| `app.js` | Sensor logic, state, measurement flow, UI updates |
| `lib/session.js` | Shared IDB session helpers (`openSessionDB`, `readSession`, `writeSession`, `updateSession`, `clearSession`) |
| `sw.js` | Service Worker (`physiq-balance-v3`, network-first) |
| `favicon.svg` | App icon |

## Design System

Identical to other PhysiQ satellites, with a balance-specific accent color:

- **Fonts:** Outfit (body), DM Mono (labels/data), DM Serif Display (titles/logo)
- **Background:** `--bg: #0a0d12`, `--surface: #111620`, `--surface2: #171e2e`
- **Accent:** `--accent: #4f9cf9` (blue), `--accent2: #38d9a9` (green)
- **Balance accent:** `#22d3ee` (cyan) — used for the "Balance" logo word, primary action buttons, and the reset/translate buttons' hover/active color
- **Header:** Fixed 64px, `backdrop-filter: blur(16px)`, `rgba(10,13,18,0.92)` bg
- **Cards:** `border-radius: 12px`, border `var(--border: #232d45)`

## Test Definitions

4 tests defined in `TESTS` (app.js:4). Each test has: `label`, `sublabel`, `stance`, `eyes`, `threshold` (sway threshold in mg), `duration` (30s), `color`, `difficulty` (1–4), `instruction`, and `tip`.

| ID | Label | Stance | Eyes | Threshold (mg) | Difficulty |
|----|-------|--------|------|----------------|-----------|
| `ft-eo` | Pies Juntos | bilateral | open | 200 | 1 |
| `ft-ec` | Pies Juntos | bilateral | closed | 380 | 2 |
| `tn-eo` | Tándem | tandem | open | 320 | 3 |
| `tn-ec` | Tándem | tandem | closed | 560 | 4 |

**Phone placement:** vertical, held against the navel with both hands.

## Sensor Architecture

Uses `DeviceMotionEvent`. Raw gravity vector comes from `e.accelerationIncludingGravity`. Values are converted from m/s² to milligravity (mg) using `G_TO_MG = 1000 / 9.80665`.

**Axes mapping** (phone held vertical against navel):
| Axis | Property | Direction |
|------|----------|-----------|
| `ml` | `ag.x` | Mediolateral (side-to-side) |
| `ud` | `ag.y` | Vertical (up-down) |
| `ap` | `ag.z` | Anterior-posterior (front-back) |

**Sampling:** 50 Hz via `setInterval(20ms)` — samples are pushed every 20ms from the latest `_lastAccel` received from `devicemotion`.

**iOS 13+** requires `DeviceMotionEvent.requestPermission()` triggered by a user gesture (the "Iniciar test" button tap). Android grants automatically.

## Metrics Computation (`_computeMetrics`)

Requires at least 10 samples. All metrics are mean-centered (DC offset removed) before calculation.

| Metric | Description |
|--------|-------------|
| `hRMS` | Horizontal RMS sway: `√(apRMS² + mlRMS²)` — primary stability indicator |
| `hSD` | Std dev of the horizontal magnitude time series `√(ap² + ml²)` |
| `totalSway` | 2D path length in the horizontal plane (sum of step distances) |
| `stabilityRate` | `totalSway / measuredDuration` (mg/s) — displayed in the summary circle |
| `ap.rms/sd/npl` | Per-axis RMS, std dev, and normalized path length for anterior-posterior |
| `ml.rms/sd/npl` | Per-axis metrics for mediolateral |
| `ud.rms/sd/npl` | Per-axis metrics for vertical |

**Score formula:**
```js
score = max(0, min(100, round(100 * (1 - hRMS / threshold))))
```
A lower hRMS relative to the test's threshold yields a higher score.

**Grade thresholds:**
| Score | Grade | Color |
|-------|-------|-------|
| ≥ 80 | EXCELENTE | `#38d9a9` |
| ≥ 60 | BUENO | `#4f9cf9` |
| ≥ 40 | REGULAR | `#fb923c` |
| < 40 | DÉFICIT | `#ef4444` |

## View State Machine

```
home ──[_openSetup(id)]──► setup ──[startTest()]──► countdown ──► testing ──[timer=0: _endTest()]──► results
 ▲         ▲                            │                │                                              │
 │         └────────────[goBack()]──────┘      [stopTest(): discard]                    [discardResult()]
 └───────────────────────────────────────────────────────────────────────────────────────[saveResult()]
```

**Early stop rule:** `stopTest()` (user taps DETENER TEST before the timer finishes) always discards — it stops the sensor, clears samples, and returns to home without analyzing. Only the natural timer expiry (`_secsLeft <= 0`) triggers `_endTest()` and shows results.

`_phase` holds the current view name: `'home'`, `'setup'`, `'countdown'`, `'testing'`, `'results'`.

`_showView(name)` sets `hidden` on all view elements and calls `_updateHeader(name)`.

The results overlay has 3 swipeable pages (touchstart/touchend, also dot-navigable):
1. **Summary** — score circle, stability rate, grade badge, feedback text
2. **Test Metrics** — duration, totalSway, hRMS, hSD
3. **Advanced** — per-axis rms/sd/npl for ap, ml, ud

## Header State Machine

Single fixed header (64px). `_updateHeader(name)` toggles which header elements are visible:

| View | Logo + Header-right | Back button | Test info |
|------|-------------------|-------------|-----------|
| `home`, `results` | ✓ | — | — |
| `setup`, `countdown` | — | ✓ | ✓ |
| `testing` | — | — | ✓ |

Header DOM elements:
- `#headerLogo` — "PhysiQ — Balance" logo
- `#headerBack` — `‹` back button (calls `goBack()`)
- `#headerTestInfo` — test title + subtitle (set by `_openSetup`, persists into testing view)
- `#headerRight` — contains session button, reset button, translate button

**In-hub:** `document.body.classList.add('in-hub')` enables the `‹` animation on `.logo-main::before` and clicking the logo sends `PHYSIQ_GO_HOME` to the parent.

## Session Persistence

IDB (`lib/session.js`) is the only persistence layer — no localStorage.

**IDB schema** — DB `'physiq'` v3, store `'session'`, key `'active'`:
```js
{
  sessionId:  timestamp,
  patient:    string,
  date:       string,       // 'DD/MM/YYYY'
  createdAt:  timestamp,
  updatedAt:  timestamp,
  balance:    object | null // { [testId]: { testId, label, sublabel, score, metrics } }
}
```

**Session helpers** (`lib/session.js` — same contract in every physiq repo):
- `openSessionDB()` — opens DB v3, creates `'session'` store on upgrade
- `readSession()` — reads `'active'`, returns null if expired (TTL 24h)
- `writeSession(patch)` — merge-writes into `'active'`, **creates if absent**
- `updateSession(patch)` — atomic read-modify-write; **returns null if no session exists** (never creates one)
- `clearSession()` — deletes `'active'`

**Write triggers:**
- Patient name `input` → debounced 800ms → `_persistPatient()` → `writeSession({ patient, date })`
- `saveResult()` → `writeSession({ balance, [patient, date] })` — only if patient or any result exists
- `promptSoftResetBalance()` confirm → `updateSession({ balance: {} })` — no-op if no session
- `promptClearSession()` confirm → `clearSession()`

**Ghost-write protection** — two guards prevent stale async `writeSession` from recreating a deleted session:
- `_sessionGen` (integer) — incremented on every clear. Captured before the async call; if `_sessionGen !== gen` at resolve time, `clearSession()` is called to undo the stale write.
- `_sessionCleared` (boolean) — set `true` synchronously on clear; blocks new writes from starting until genuine new data appears (patient name typed or result saved), then resets to `false`.

**On startup:** `readSession()` restores `_patient` and `_balanceResults` if a session exists, then renders the test cards with any saved scores.

**Session button** in the header (`#sessionBtn`) is a person-silhouette SVG icon, shown with `.active` class when a session is active (`_patient` non-empty or any balance result saved). Clicking calls `promptClearSession()`.

**Reset button** (`#headerResetBtn`, "↺ Reiniciar") appears only when `_balanceResults` has at least one entry. It calls `promptSoftResetBalance()` which clears only balance data without touching other satellites' session data.

## BroadcastChannel protocol

All satellites use `const _sessionCh = new BroadcastChannel('physiq-session')`.

Messages emitted by physiq-balance:

| Type | When | Payload |
|------|------|---------|
| `SESSION_PATIENT` | after `_persistPatient()` | `{ patient: string }` |
| `SESSION_BALANCE` | after `saveResult()`, `promptSoftResetBalance()`, or `_softReset()` | `{ balance: object \| {} }` |
| `SESSION_CLEAR` | after `promptClearSession()` full clear | — |

Messages received:

| Type | Action |
|------|--------|
| `SESSION_PATIENT` | Updates `_patient` in memory and input field — no IDB write |
| `SESSION_CLEAR` | Calls `_softReset()` (non-full-clear path, no `clearSession()` re-called) |

## Dialogs

Use `showConfirmBanner(title, text, actionLabel, callback)` — never use the native `confirm()` or `alert()`.

The confirm dialog's action button (`#confirmAction`) is styled `background: #22d3ee; color: #0a0d12`.

## Hub integration

physiq-balance runs inside an iframe in the PhysiQ hub. On load:

```js
try {
  if (window.self !== window.top) {
    document.body.classList.add('in-hub');
    document.querySelector('.logo-main').addEventListener('click', () => {
      window.parent.postMessage({ type: 'PHYSIQ_GO_HOME' }, '*');
    });
  }
} catch (_) {
  document.body.classList.add('in-hub');
}
```

`showConfirmBanner` calls `_hubWidgetHide()` when opening and `_hubWidgetShow()` when closing, so the hub recorder widget is hidden during modals. `_showResults()` also calls `_hubWidgetHide()` (restored on save or discard).

## Sibling repos

The hub at `physiodevapp.github.io/physiq/` is the primary entry point for the ecosystem.

| Repo | Hub path | Role |
|------|----------|------|
| physiq-assessment | /physiq/assessment/ | 5-phase clinical assessment |
| physiq-motion | /physiq/motion/ | Joint ROM measurement |
| physiq-report | /physiq/report/ | Audio transcription + Claude report generation |
| physiq-force | /physiq/force/ | Web Bluetooth force measurement |
