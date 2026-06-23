'use strict';

// ── Test definitions ─────────────────────────────────────────────────────────
const TESTS = {
  'ft-eo': {
    label:       'Pies Juntos',
    sublabel:    'Ojos Abiertos',
    stance:      'bilateral',
    eyes:        'open',
    threshold:   200,
    duration:    30,
    color:       '#38d9a9',
    difficulty:  1,
    instruction: 'Mantén el teléfono vertical apoyado contra el ombligo con ambas manos.',
    tip:         'Mantén los pies juntos y la vista al frente.'
  },
  'ft-ec': {
    label:       'Pies Juntos',
    sublabel:    'Ojos Cerrados',
    stance:      'bilateral',
    eyes:        'closed',
    threshold:   380,
    duration:    30,
    color:       '#4f9cf9',
    difficulty:  2,
    instruction: 'Mantén el teléfono vertical apoyado contra el ombligo con ambas manos.',
    tip:         'Mantén los pies juntos y cierra los ojos cuando empiece la cuenta atrás.'
  },
  'tn-eo': {
    label:       'Tándem',
    sublabel:    'Ojos Abiertos',
    stance:      'tandem',
    eyes:        'open',
    threshold:   320,
    duration:    30,
    color:       '#fb923c',
    difficulty:  3,
    instruction: 'Coloca un pie justo delante del otro (talón-punta) y apoya el teléfono contra el ombligo.',
    tip:         'Mantén la mirada fija en un punto al frente.'
  },
  'tn-ec': {
    label:       'Tándem',
    sublabel:    'Ojos Cerrados',
    stance:      'tandem',
    eyes:        'closed',
    threshold:   560,
    duration:    30,
    color:       '#ef4444',
    difficulty:  4,
    instruction: 'Coloca un pie justo delante del otro (talón-punta) y apoya el teléfono contra el ombligo.',
    tip:         'Cierra los ojos cuando empiece la cuenta atrás. Ten a alguien cerca por seguridad.'
  }
};

const COUNTDOWN_SECS  = 3;
const SAMPLE_RATE_MS  = 20; // 50 Hz
const G_TO_MG         = 1000 / 9.80665;

// ── State ────────────────────────────────────────────────────────────────────
let _phase      = 'home'; // 'home' | 'setup' | 'countdown' | 'testing' | 'results'
let _testId     = null;
let _samples    = [];
let _lastAccel  = null;
let _sampleInt  = null;
let _testTimer  = null;
let _cdTimer    = null;
let _secsLeft   = 30;
let _cdSecsLeft = COUNTDOWN_SECS;
let _lastResult = null; // computed metrics for current test
let _patient      = '';
let _sessionDate  = '';
let _sessionLabel = '';
let _balanceResults = {}; // { testId: savedResult }
let _sessionGen     = 0;
let _sessionCleared = false;
let _resultsPage    = 0;
let _swipeStartX    = 0;

const _sessionCh = new BroadcastChannel('physiq-session');

// ── DOM refs (set after DOMContentLoaded) ────────────────────────────────────
let $viewHome, $viewSetup, $measurementSheet, $msCountdown, $msTesting, $resultsOverlay;
let _$headerLogo, _$headerRight, _$setupSubHeader;
let _translateTimer = null;

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  $viewHome         = document.getElementById('view-home');
  $viewSetup        = document.getElementById('view-setup');
  $measurementSheet = document.getElementById('measurement-sheet');
  $msCountdown      = document.getElementById('msCountdown');
  $msTesting        = document.getElementById('msTesting');
  $resultsOverlay   = document.getElementById('results-overlay');

  // Hub integration
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

  // Header DOM refs
  _$headerLogo     = document.getElementById('headerLogo');
  _$headerRight    = document.getElementById('headerRight');
  _$setupSubHeader = document.getElementById('setupSubHeader');

  // Sensor check
  if (typeof DeviceMotionEvent === 'undefined') {
    document.getElementById('sensor-warning').hidden = false;
  }

  // Load session
  const session = await readSession();
  if (session) {
    _patient = session.patient || '';
    _sessionDate = session.date || _todayStr();
    _balanceResults = session.balance || {};
    _applySessionToUI(session);
  }

  // Render home
  _renderTestCards();
  _updateSessionChip();
  _showView('home');
  history.replaceState({ view: 'home' }, '');

  // BroadcastChannel
  _sessionCh.onmessage = _handleBC;

  // SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');
  }

  // Patient name input
  const patientInput = document.getElementById('patientInput');
  if (patientInput) {
    patientInput.value = _patient;
    patientInput.addEventListener('input', _onPatientInput);
  }

  // Setup swipe on results pages
  _initResultsSwipe();
});

// ── Session helpers ───────────────────────────────────────────────────────────
function _applySessionToUI(session) {
  if (session.patient) {
    const inp = document.getElementById('patientInput');
    if (inp) inp.value = session.patient;
  }
}

function _updateSessionChip() {
  const btn = document.getElementById('sessionBtn');
  if (!btn) return;
  btn.classList.toggle('active', !!_patient);
  _sessionLabel = _patient ? `${_patient} · ${_sessionDate || _todayStr()}` : '';
}

let _patientDebounce = null;
function _onPatientInput(e) {
  _patient = e.target.value.trim();
  _sessionCleared = false;
  clearTimeout(_patientDebounce);
  _patientDebounce = setTimeout(() => _persistPatient(), 800);
  _updateSessionChip();
}

async function _persistPatient() {
  _sessionDate = _todayStr();
  const gen = _sessionGen;
  const session = await writeSession({ patient: _patient, date: _sessionDate });
  if (_sessionGen !== gen) {
    await clearSession();
    return;
  }
  _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
}

function _todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// ── BroadcastChannel ─────────────────────────────────────────────────────────
function _handleBC(e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'SESSION_PATIENT') {
    _patient = msg.patient || '';
    const inp = document.getElementById('patientInput');
    if (inp) inp.value = _patient;
    _updateSessionChip();
  }
  if (msg.type === 'SESSION_CLEAR') {
    _softReset();
  }
}

// ── Header state ─────────────────────────────────────────────────────────────
function _updateHeader(name) {
  const showSub = (name === 'setup' || name === 'countdown' || name === 'testing');
  if (_$setupSubHeader) _$setupSubHeader.hidden = !showSub;
}

// ── View routing ──────────────────────────────────────────────────────────────
function _showView(name) {
  _phase = name === 'countdown' ? 'countdown' : name;
  const isMeasuring = (name === 'countdown' || name === 'testing');
  $viewHome.hidden          = (name !== 'home');
  $viewSetup.hidden         = !['setup', 'countdown', 'testing'].includes(name);
  $measurementSheet.hidden  = !isMeasuring;
  $resultsOverlay.hidden    = (name !== 'results');
  document.body.classList.toggle('measuring', isMeasuring);
  if (isMeasuring) {
    $msCountdown.hidden = (name !== 'countdown');
    $msTesting.hidden   = (name !== 'testing');
  }
  _updateHeader(name);
  if (name === 'setup') history.pushState({ view: 'setup' }, '');
}

window.addEventListener('popstate', (e) => {
  if (_phase === 'setup') {
    _showView('home');
  } else if (_phase === 'countdown' || _phase === 'testing') {
    _abortMeasurement();
    _showView('home');
  } else if (e.state?.view === 'home' && _phase !== 'home') {
    _showView('home');
  }
});

// ── Home ──────────────────────────────────────────────────────────────────────
function _renderTestCards() {
  const grid = document.getElementById('testGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let _cardIdx = 0;
  for (const [id, t] of Object.entries(TESTS)) {
    const saved = _balanceResults[id];
    const score = saved ? saved.score : null;

    const card = document.createElement('button');
    card.className = 'test-card';
    card.dataset.testId = id;
    card.style.setProperty('--card-accent', t.color);
    card.style.animationDelay = (_cardIdx++ * 0.05) + 's';
    card.addEventListener('click', () => _openSetup(id));

    const diffDots = Array.from({ length: 4 }, (_, i) =>
      `<span class="diff-dot${i < t.difficulty ? ' filled' : ''}"></span>`
    ).join('');

    const scoreHtml = score !== null
      ? `<span class="card-score" style="color:${_gradeColor(score)}">${score}<small>/100</small></span>`
      : `<span class="card-score-empty">—</span>`;

    card.innerHTML = `
      <div class="card-top">
        ${scoreHtml}
      </div>
      <div class="card-label">${t.label}</div>
      <div class="card-sublabel">${t.sublabel}</div>
      <div class="diff-dots">${diffDots}</div>
    `;
    grid.appendChild(card);
  }
  _renderInterpretation();
}

// ── Interpretation ───────────────────────────────────────────────────────────
function _computeInterpretation() {
  const ids = Object.keys(_balanceResults);
  if (!ids.length) return [];

  const items = [];
  const get = id => _balanceResults[id];
  const ftEO = get('ft-eo'), ftEC = get('ft-ec'), tnEO = get('tn-eo');

  // Global profile
  const scores = ids.map(id => _balanceResults[id].score);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const grade = _getGrade(avg);
  items.push({
    color: grade.color,
    title: `Perfil general: ${grade.label}`,
    text: avg >= 80
      ? 'Oscilación postural mínima. Control neuromuscular sobresaliente en las condiciones evaluadas.'
      : avg >= 60
      ? 'Equilibrio funcional. La oscilación está dentro del rango normal.'
      : avg >= 40
      ? 'Oscilación moderada. El entrenamiento de equilibrio puede mejorar la estabilidad.'
      : 'Oscilación elevada. Se recomienda trabajo específico de estabilización y valoración más detallada.'
  });

  // Visual dependency (Romberg-like): EC vs EO, misma posición
  if (ftEO && ftEC && ftEO.metrics.hRMS > 0.1) {
    const ratio = ftEC.metrics.hRMS / ftEO.metrics.hRMS;
    const high = ratio >= 2.5;
    items.push({
      color: high ? '#fb923c' : '#38d9a9',
      title: high ? 'Dependencia visual elevada' : 'Control propioceptivo normal',
      text: high
        ? `Al cerrar los ojos la oscilación aumentó ${ratio.toFixed(1)}× (umbral: 2.5×). Posible menor aportación del sistema propioceptivo o vestibular.`
        : `Al cerrar los ojos la oscilación aumentó ${ratio.toFixed(1)}× (< 2.5×). Los sistemas propioceptivo y vestibular contribuyen bien al equilibrio.`
    });
  }

  // Base de sustentación: pies juntos vs tándem
  if (ftEO && tnEO) {
    const drop = ftEO.score - tnEO.score;
    items.push({
      color: drop > 35 ? '#fb923c' : drop > 15 ? '#4f9cf9' : '#38d9a9',
      title: drop > 35 ? 'Dificultad con base de sustentación reducida'
           : drop > 15 ? 'Adaptación normal a base reducida'
           : 'Buena adaptación a base reducida',
      text: drop > 35
        ? `El equilibrio bajó ${drop} puntos al pasar a tándem. Trabajar la propiocepción de tobillo y el control de cadera puede mejorar este aspecto.`
        : drop > 15
        ? `Descenso de ${drop} puntos al estrechar la base (pies juntos → tándem), dentro de lo esperado.`
        : `Mínima pérdida de equilibrio al reducir la base (−${drop} pts). Excelente control postural con base estrecha.`
    });
  }

  // Dirección dominante del sway (referencia: ft-eo si disponible)
  const ref = ftEO || _balanceResults[ids[0]];
  if (ref?.metrics) {
    const { ap, ml } = ref.metrics;
    if (ap.rms > 0 && ml.rms > 0) {
      const r = ap.rms / ml.rms;
      if (r > 1.6) {
        items.push({
          color: '#4f9cf9',
          title: 'Oscilación predominantemente anteroposterior',
          text: 'Mayor movimiento hacia adelante y atrás que lateral. Puede relacionarse con la estrategia de tobillo o debilidad en esa dirección.'
        });
      } else if (r < 0.625) {
        items.push({
          color: '#4f9cf9',
          title: 'Oscilación predominantemente lateral',
          text: 'Mayor movimiento de lado a lado que anteroposterior. Puede indicar debilidad de abductores de cadera o asimetría en la carga.'
        });
      }
    }
  }

  return items;
}

function _renderInterpretation() {
  const card = document.getElementById('interpretationCard');
  if (!card) return;
  const items = _computeInterpretation();
  card.hidden = !items.length;
  if (!items.length) return;
  const container = document.getElementById('interpretationItems');
  container.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'interp-item';
    el.innerHTML = `<span class="interp-dot" style="background:${item.color}"></span><div class="interp-content"><div class="interp-title">${item.title}</div><div class="interp-text">${item.text}</div></div>`;
    container.appendChild(el);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function _openSetup(testId) {
  _testId = testId;
  const t = TESTS[testId];

  // Sub-header badge
  const nameEl  = document.getElementById('subHeaderName');
  const subEl   = document.getElementById('subHeaderSub');
  const colorEl = document.getElementById('subHeaderColor');
  if (nameEl)  nameEl.textContent  = t.label;
  if (subEl)   subEl.textContent   = t.sublabel;
  if (colorEl) colorEl.style.background = t.color;

  document.getElementById('setupInstruction').textContent = t.instruction;
  document.getElementById('setupTip').textContent      = t.tip;
  document.getElementById('setupDuration').textContent = `Duración: ${t.duration} segundos`;

  const startBtn = document.getElementById('startBtn');
  startBtn.disabled = false;

  _showView('setup');
}

function _stanceIllustration(stance) {
  if (stance === 'tandem') {
    return `<svg viewBox="0 0 160 260" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="80" cy="28" r="22" stroke="var(--accent2)" stroke-width="2.5"/>
      <rect x="68" y="52" width="24" height="60" rx="12" stroke="var(--accent2)" stroke-width="2.5"/>
      <path d="M68 68 Q50 78 54 96" stroke="var(--accent2)" stroke-width="3" stroke-linecap="round"/>
      <path d="M92 68 Q110 78 106 96" stroke="var(--accent2)" stroke-width="3" stroke-linecap="round"/>
      <rect x="72" y="86" width="16" height="26" rx="4" fill="var(--accent2)" opacity="0.9"/>
      <rect x="76" y="90" width="8" height="18" rx="2" fill="var(--bg)" opacity="0.6"/>
      <rect x="75" y="112" width="9" height="56" rx="4.5" stroke="var(--accent2)" stroke-width="2.5"/>
      <rect x="78" y="144" width="9" height="56" rx="4.5" stroke="var(--accent2)" stroke-width="2.5"/>
      <path d="M62 172 Q80 168 98 172" stroke="var(--accent2)" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
      <path d="M62 202 Q80 198 98 202" stroke="var(--accent2)" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 160 260" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="80" cy="28" r="22" stroke="var(--accent2)" stroke-width="2.5"/>
    <rect x="68" y="52" width="24" height="60" rx="12" stroke="var(--accent2)" stroke-width="2.5"/>
    <path d="M68 68 Q50 78 54 96" stroke="var(--accent2)" stroke-width="3" stroke-linecap="round"/>
    <path d="M92 68 Q110 78 106 96" stroke="var(--accent2)" stroke-width="3" stroke-linecap="round"/>
    <rect x="72" y="86" width="16" height="26" rx="4" fill="var(--accent2)" opacity="0.9"/>
    <rect x="76" y="90" width="8" height="18" rx="2" fill="var(--bg)" opacity="0.6"/>
    <rect x="70" y="112" width="10" height="58" rx="5" stroke="var(--accent2)" stroke-width="2.5"/>
    <rect x="80" y="112" width="10" height="58" rx="5" stroke="var(--accent2)" stroke-width="2.5"/>
    <ellipse cx="75" cy="176" rx="18" ry="7" stroke="var(--accent2)" stroke-width="2.5"/>
    <ellipse cx="85" cy="176" rx="18" ry="7" stroke="var(--accent2)" stroke-width="2.5"/>
  </svg>`;
}

function _abortMeasurement() {
  if (_cdTimer)   { clearInterval(_cdTimer);   _cdTimer   = null; }
  if (_testTimer) { clearInterval(_testTimer); _testTimer = null; }
  if (_sampleInt) { _stopSensor(); }
  _samples    = [];
  _lastResult = null;
}

window.goBack = function () {
  _abortMeasurement();
  _showView('home');
  // Consume the setup history entry so a subsequent swipe back exits cleanly
  history.back();
};

// ── Start test (permission + countdown) ──────────────────────────────────────
window.startTest = async function () {
  // iOS 13+ sensor permission
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') {
        _showSensorError('Permiso de movimiento denegado. Habilítalo en Ajustes › Privacidad.');
        return;
      }
    } catch (err) {
      _showSensorError('No se pudo solicitar permiso del sensor.');
      return;
    }
  }

  document.getElementById('startBtn').disabled = true;
  _cdSecsLeft = COUNTDOWN_SECS;
  document.getElementById('countdownNum').textContent = _cdSecsLeft;
  _showView('countdown');

  _cdTimer = setInterval(() => {
    _cdSecsLeft--;
    if (_cdSecsLeft <= 0) {
      clearInterval(_cdTimer);
      _cdTimer = null;
      _beginTest();
    } else {
      document.getElementById('countdownNum').textContent = _cdSecsLeft;
    }
  }, 1000);
};

function _showSensorError(msg) {
  document.getElementById('startBtn').disabled = false;
  const el = document.getElementById('sensor-warning');
  el.textContent = msg;
  el.hidden = false;
}

// ── Test in progress ──────────────────────────────────────────────────────────
function _beginTest() {
  const t = TESTS[_testId];
  _samples  = [];
  _lastAccel = null;
  _secsLeft  = t.duration;

  document.getElementById('timerDisplay').textContent = _secsLeft;
  document.getElementById('stopBtn').style.background = '#ef4444';

  _showView('testing');
  _startSensor();
  _startTestTimer(t.duration);
}

function _startSensor() {
  window.addEventListener('devicemotion', _onMotion);
  _sampleInt = setInterval(() => {
    if (_lastAccel) _samples.push({ ..._lastAccel });
  }, SAMPLE_RATE_MS);
}

function _stopSensor() {
  clearInterval(_sampleInt);
  _sampleInt = null;
  window.removeEventListener('devicemotion', _onMotion);
}

function _onMotion(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag) return;
  _lastAccel = {
    ml: (ag.x || 0) * G_TO_MG, // mediolateral (side-side)
    ud: (ag.y || 0) * G_TO_MG, // vertical (up-down)
    ap: (ag.z || 0) * G_TO_MG  // anterior-posterior (front-back)
  };
}

function _startTestTimer(duration) {
  _testTimer = setInterval(() => {
    _secsLeft--;
    document.getElementById('timerDisplay').textContent = _secsLeft;
    if (_secsLeft <= 0) {
      clearInterval(_testTimer);
      _testTimer = null;
      _endTest();
    }
  }, 1000);
}

window.stopTest = function () {
  if (_testTimer) { clearInterval(_testTimer); _testTimer = null; }
  _stopSensor();
  _samples = [];
  _lastResult = null;
  _showView('home');
};

function _endTest() {
  _stopSensor();
  const metrics = _computeMetrics(_samples);
  _lastResult = { testId: _testId, metrics };
  _showResults(metrics);
}

// ── Metrics computation ───────────────────────────────────────────────────────
function _computeMetrics(samples) {
  const n = samples.length;
  if (n < 10) return null;

  const ap = samples.map(s => s.ap);
  const ml = samples.map(s => s.ml);
  const ud = samples.map(s => s.ud);

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const mAP = mean(ap), mML = mean(ml), mUD = mean(ud);

  const apC = ap.map(v => v - mAP);
  const mlC = ml.map(v => v - mML);
  const udC = ud.map(v => v - mUD);

  const rms = arr => Math.sqrt(arr.reduce((a, b) => a + b * b, 0) / arr.length);
  const sd  = arr => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  };
  const npl = arr => {
    let sum = 0;
    for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]);
    return sum;
  };

  const apRMS = rms(apC), mlRMS = rms(mlC), udRMS = rms(udC);
  const apSD  = sd(apC),  mlSD  = sd(mlC),  udSD  = sd(udC);
  const apNPL = npl(apC), mlNPL = npl(mlC), udNPL = npl(udC);

  const hRMS = Math.sqrt(apRMS * apRMS + mlRMS * mlRMS);

  // H-SD: std of the horizontal magnitude time series
  const hSeries = apC.map((v, i) => Math.sqrt(v * v + mlC[i] * mlC[i]));
  const hSD = sd(hSeries);

  // 2D path length in horizontal plane
  let totalSway = 0;
  for (let i = 1; i < n; i++) {
    const dAP = apC[i] - apC[i - 1];
    const dML = mlC[i] - mlC[i - 1];
    totalSway += Math.sqrt(dAP * dAP + dML * dML);
  }

  const measuredDuration = n * SAMPLE_RATE_MS / 1000;
  const stabilityRate    = measuredDuration > 0 ? totalSway / measuredDuration : 0;

  const threshold = TESTS[_testId].threshold;
  const score     = Math.max(0, Math.min(100, Math.round(100 * (1 - hRMS / threshold))));

  return {
    plannedDuration: TESTS[_testId].duration,
    measuredDuration,
    hRMS,
    hSD,
    totalSway,
    stabilityRate,
    score,
    ap: { rms: apRMS, sd: apSD, npl: apNPL },
    ml: { rms: mlRMS, sd: mlSD, npl: mlNPL },
    ud: { rms: udRMS, sd: udSD, npl: udNPL }
  };
}

// ── Results display ───────────────────────────────────────────────────────────
function _showResults(metrics) {
  if (!metrics) {
    _showView('home');
    return;
  }

  const t     = TESTS[_testId];
  const grade = _getGrade(metrics.score);

  // Header
  document.getElementById('resultsTestName').textContent = `${t.label} · ${t.sublabel}`;
  const gradeBadge = document.getElementById('gradeBadge');
  gradeBadge.textContent   = grade.label;
  gradeBadge.style.background = grade.color;

  // Page 1 — Summary
  const circle = document.getElementById('stabilityCircle');
  circle.style.borderColor = grade.color;
  document.getElementById('stabilityRateVal').textContent = _fmt1(metrics.stabilityRate);
  document.getElementById('scoreDisplay').textContent     = `${metrics.score}/100`;
  document.getElementById('feedbackText').textContent     = _getFeedback(metrics.score);

  // Page 2 — Test Metrics
  document.getElementById('metDuration').textContent   = `${metrics.plannedDuration}s`;
  document.getElementById('metMeasured').textContent   = `Medido: ${_fmt1(metrics.measuredDuration)}s`;
  document.getElementById('metTotalSway').textContent  = _fmt1(metrics.totalSway);
  document.getElementById('metHRMS').textContent       = _fmt1(metrics.hRMS);
  document.getElementById('metHSD').textContent        = _fmt1(metrics.hSD);

  // Page 3 — Advanced
  document.getElementById('advApNPL').textContent = _fmt1(metrics.ap.npl);
  document.getElementById('advApRMS').textContent = _fmt1(metrics.ap.rms);
  document.getElementById('advApSD').textContent  = _fmt1(metrics.ap.sd);
  document.getElementById('advMlNPL').textContent = _fmt1(metrics.ml.npl);
  document.getElementById('advMlRMS').textContent = _fmt1(metrics.ml.rms);
  document.getElementById('advMlSD').textContent  = _fmt1(metrics.ml.sd);
  document.getElementById('advUdNPL').textContent = _fmt1(metrics.ud.npl);
  document.getElementById('advUdRMS').textContent = _fmt1(metrics.ud.rms);
  document.getElementById('advUdSD').textContent  = _fmt1(metrics.ud.sd);

  // Reset to page 1
  _resultsPage = 0;
  _updateResultsPage();

  _showView('results');
  _hubWidgetHide();
}

function _getGrade(score) {
  if (score >= 80) return { label: 'EXCELENTE', color: '#38d9a9' };
  if (score >= 60) return { label: 'BUENO',     color: '#4f9cf9' };
  if (score >= 40) return { label: 'REGULAR',   color: '#fb923c' };
  return                  { label: 'DÉFICIT',   color: '#ef4444' };
}

function _gradeColor(score) {
  return _getGrade(score).color;
}

function _getFeedback(score) {
  if (score >= 80) return 'Equilibrio excelente. La oscilación postural mínima indica un control neuromuscular y una estabilidad sobresalientes.';
  if (score >= 60) return 'Buen equilibrio. La oscilación postural está dentro del rango normal para esta condición de test.';
  if (score >= 40) return 'Oscilación moderada detectada. El entrenamiento de equilibrio puede ayudar a mejorar la estabilidad.';
  return 'Oscilación significativa detectada. Se recomienda evaluación por un fisioterapeuta.';
}

function _fmt1(v) {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}

// ── Results swipe ─────────────────────────────────────────────────────────────
function _initResultsSwipe() {
  const track = document.getElementById('resultPagesTrack');
  if (!track) return;

  track.addEventListener('touchstart', e => { _swipeStartX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    if (dx < -50 && _resultsPage < 2) _resultsPage++;
    else if (dx > 50 && _resultsPage > 0) _resultsPage--;
    _updateResultsPage();
  }, { passive: true });

  // Dot click
  document.querySelectorAll('.page-dot').forEach((dot, i) => {
    dot.addEventListener('click', () => { _resultsPage = i; _updateResultsPage(); });
  });

  // Swipe-down to dismiss
  const card = document.querySelector('.results-card');
  if (!card) return;
  const _dragZone = card.querySelector('.results-header');
  const _handle   = card.querySelector('.sheet-handle');
  let startY = 0, startTime = 0, dragging = false, delta = 0, snapTimer = null;
  const EASE = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';

  card.addEventListener('touchstart', e => {
    const t = e.target;
    if (!_dragZone.contains(t) && !_handle.contains(t) && t !== _handle) return;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    delta = 0;
    dragging = true;
    clearTimeout(snapTimer);
    card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (!dragging) return;
    delta = Math.max(0, e.touches[0].clientY - startY);
    card.style.transform = delta > 0 ? `translateY(${delta}px)` : 'translateY(0)';
  }, { passive: true });

  function onRelease() {
    if (!dragging) return;
    dragging = false;
    const velocity = delta / (Date.now() - startTime);
    if (delta > 80 || velocity > 0.3) {
      card.style.transition = EASE;
      card.style.transform = 'translateY(110%)';
      setTimeout(() => {
        card.style.transition = 'none';
        card.style.transform = '';
        discardResult();
      }, 300);
    } else {
      card.style.transition = EASE;
      card.style.transform = 'translateY(0)';
      snapTimer = setTimeout(() => {
        card.style.transform = '';
        card.style.transition = '';
      }, 310);
    }
  }

  card.addEventListener('touchend', onRelease, { passive: true });
  card.addEventListener('touchcancel', () => {
    if (!dragging) return;
    dragging = false;
    card.style.transform = '';
    card.style.transition = '';
  }, { passive: true });
}

function _updateResultsPage() {
  const track = document.getElementById('resultPagesTrack');
  if (track) track.style.transform = `translateX(-${_resultsPage * 100}%)`;
  document.querySelectorAll('.page-dot').forEach((d, i) => {
    d.classList.toggle('active', i === _resultsPage);
  });
}

// ── Results actions ───────────────────────────────────────────────────────────
window.discardResult = function () {
  _lastResult = null;
  _showView('home');
  _hubWidgetShow();
};

window.saveResult = async function () {
  if (!_lastResult) { _showView('home'); return; }

  const { testId, metrics } = _lastResult;
  _balanceResults[testId] = {
    testId,
    label:    TESTS[testId].label,
    sublabel: TESTS[testId].sublabel,
    score:    metrics.score,
    metrics
  };

  _sessionDate = _todayStr();
  const patch = { balance: _balanceResults };
  if (_patient) {
    patch.patient = _patient;
    patch.date    = _sessionDate;
  }

  const gen = _sessionGen;
  if (_patient || Object.keys(_balanceResults).length > 0) {
    _sessionCleared = false;
    const session = await writeSession(patch);
    if (_sessionGen !== gen) { await clearSession(); }
    else if (session) {
      _sessionCh.postMessage({ type: 'SESSION_BALANCE', balance: _balanceResults });
      if (_patient) _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
    }
  }

  _lastResult = null;
  _renderTestCards();
  _updateSessionChip();
  _updateResetBtn();
  _showView('home');
  _hubWidgetShow();
};

// ── Session clear ─────────────────────────────────────────────────────────────
window.promptClearSession = function () {
  _hubWidgetHide();
  showConfirmBanner(
    'Sesión en curso',
    `${_sessionLabel}<br>¿Borrar y empezar de nuevo?`,
    'Borrar sesión',
    async () => {
      _hubWidgetShow();
      await _softReset(true);
    }
  );
};

async function _softReset(fullClear = false) {
  _sessionGen++;
  _sessionCleared = true;
  _balanceResults = {};
  _patient = '';
  _sessionDate = '';
  _sessionLabel = '';

  const inp = document.getElementById('patientInput');
  if (inp) inp.value = '';

  _renderTestCards();
  _updateSessionChip();
  _updateResetBtn();

  if (fullClear) {
    await clearSession();
    _sessionCh.postMessage({ type: 'SESSION_CLEAR' });
  } else {
    _sessionCh.postMessage({ type: 'SESSION_BALANCE', balance: {} });
  }
}

// ── Reset button visibility ───────────────────────────────────────────────────
function _updateResetBtn() {
  const btn = document.getElementById('headerResetBtn');
  if (!btn) return;
  btn.style.display = Object.keys(_balanceResults).length > 0 ? '' : 'none';
}

// ── Soft reset (balance data only) ───────────────────────────────────────────
window.promptSoftResetBalance = function () {
  _hubWidgetHide();
  showConfirmBanner(
    '↺ Borrar mediciones',
    'Se eliminarán las mediciones de balance. Los datos de otros satélites se conservarán.',
    'Borrar',
    async () => {
      _hubWidgetShow();
      _balanceResults = {};
      _renderTestCards();
      _updateSessionChip();
      _updateResetBtn();
      await updateSession({ balance: {} });
      _sessionCh.postMessage({ type: 'SESSION_BALANCE', balance: {} });
    }
  );
};

// ── Translate banner (mobile) ─────────────────────────────────────────────────
function handleTranslateClick() {
  if (window.innerWidth > 768) return;
  const banner = document.getElementById('translateBanner');
  if (!banner) return;
  banner.classList.add('visible');
  clearTimeout(_translateTimer);
  _translateTimer = setTimeout(hideTranslateBanner, 4000);
}
function hideTranslateBanner() {
  clearTimeout(_translateTimer);
  const banner = document.getElementById('translateBanner');
  if (banner) banner.classList.remove('visible');
}
window.handleTranslateClick = handleTranslateClick;
window.hideTranslateBanner  = hideTranslateBanner;

// ── Hub widget ────────────────────────────────────────────────────────────────
function _hubWidgetHide() {
  try { window.parent.postMessage({ type: 'PHYSIQ_WIDGET_HIDE' }, '*'); } catch (_) {}
}
function _hubWidgetShow() {
  try { window.parent.postMessage({ type: 'PHYSIQ_WIDGET_SHOW' }, '*'); } catch (_) {}
}

// ── Metric info dialog ────────────────────────────────────────────────────────
const METRIC_INFO = {
  duration:  { title: 'Duración', body: 'Tiempo de grabación efectivo del sensor. Puede diferir ligeramente de los 30 s nominales si el sistema tardó en iniciar la captura.' },
  totalSway: { title: 'Sway Total', body: 'Longitud total del trayecto de oscilación en el plano horizontal (AP + ML). Equivale al camino que el centro de presión recorrería en ese plano. Valores menores indican mayor estabilidad.' },
  hrms:      { title: 'H-RMS — Sway Horizontal', body: 'Raíz cuadrática media del balanceo horizontal combinado (AP + ML). Es el indicador principal de estabilidad postural: valores menores corresponden a mejor equilibrio. Se usa para calcular la puntuación y comparar con el umbral de referencia del test.' },
  hsd:       { title: 'H-SD — Desviación Estándar Horizontal', body: 'Variabilidad del balanceo horizontal a lo largo del test. Refleja la consistencia del equilibrio: una SD baja indica oscilaciones regulares, mientras que una SD alta puede sugerir estrategias de corrección frecuentes.' },
  npl:       { title: 'NPL — Longitud de Trayecto Normalizada', body: 'Longitud total del trayecto de oscilación dividida por la duración del test (mG/s). Permite comparar tests de diferente duración y facilita el seguimiento longitudinal del paciente.' },
  rms:       { title: 'RMS — Raíz Cuadrática Media', body: 'Amplitud media de las oscilaciones en este eje. Un valor bajo indica poco desplazamiento en esa dirección y, por tanto, mejor control en ese plano.' },
  sd:        { title: 'SD — Desviación Estándar', body: 'Variabilidad de las oscilaciones en este eje durante el test. Valores elevados reflejan mayor irregularidad del balanceo, lo que puede indicar estrategias de corrección frecuentes o menor control motor.' },
};

function showMetricInfo(key) {
  const info = METRIC_INFO[key];
  if (!info) return;
  document.getElementById('metricInfoTitle').textContent = info.title;
  document.getElementById('metricInfoBody').textContent  = info.body;
  document.getElementById('metricInfoDialog').removeAttribute('hidden');
}

function hideMetricInfo() {
  document.getElementById('metricInfoDialog').setAttribute('hidden', '');
}

window.showMetricInfo = showMetricInfo;
window.hideMetricInfo = hideMetricInfo;

// ── Confirm banner ────────────────────────────────────────────────────────────
function showConfirmBanner(title, text, actionLabel, onConfirm) {
  const el = document.getElementById('confirmBanner');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').innerHTML    = text;
  document.getElementById('confirmAction').textContent = actionLabel;
  el.hidden = false;

  const onAction = () => { el.hidden = true; cleanup(); onConfirm(); };
  const onCancel = () => { el.hidden = true; cleanup(); _hubWidgetShow(); };

  document.getElementById('confirmAction').addEventListener('click', onAction, { once: true });
  document.getElementById('confirmCancel').addEventListener('click', onCancel, { once: true });

  function cleanup() {
    document.getElementById('confirmAction').removeEventListener('click', onAction);
    document.getElementById('confirmCancel').removeEventListener('click', onCancel);
  }
}
