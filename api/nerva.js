// NERVA Decision Engine API
// Path in repo: api/nerva.js
// URL: https://nerva-globe.vercel.app/api/nerva
//
// The core NERVA quantum-inspired decision engine as a callable API.
// Any application can POST inputs and receive a NERVA decision state.
//
// No API key required for basic use.
// Rate limited to 100 requests/hour per IP on free tier.
//
// POST /api/nerva
// Content-Type: application/json
//
// ── RESIDENTIAL mode ──
// {
//   "mode": "residential",
//   "inputs": {
//     "homeValue": 664000,
//     "medianIncome": 180000,
//     "medianRent": 1790,
//     "daysOnMarket": 22,
//     "vacancyRate": 0.04,
//     "floodRisk": 0.2,        // 0-1 scale
//     "fireRisk": 0.1,
//     "mortgageRate": 6.11,
//     "priceYoY": 0.061        // 6.1% YoY appreciation
//   },
//   "horizon": 1               // 0=24h, 1=72h, 2=30d, 3=6mo, 4=2yr, 5=10yr
// }
//
// ── CORPORATE mode ──
// {
//   "mode": "corporate",
//   "inputs": {
//     "capRate": 0.052,         // 5.2% cap rate
//     "vacancy": 0.18,          // 18% vacancy
//     "noi": 2400000,           // Net Operating Income
//     "leaseTermAvg": 4.2,      // Average remaining lease term (years)
//     "anchorTenantRisk": 0.3,  // 0-1, probability of anchor tenant loss
//     "debtServiceRatio": 1.15, // DSCR
//     "climateExposure": 0.4,   // 0-1 composite climate risk
//     "marketVacancyTrend": 0.02 // +2% = vacancy rising
//   },
//   "horizon": 3
// }
//
// ── GEOPOLITICAL mode ──
// {
//   "mode": "geopolitical",
//   "inputs": {
//     "conflictIntensity": 0.8,  // 0-1
//     "institutionalStability": 0.3,
//     "economicStress": 0.7,
//     "externalShockProb": 0.5,
//     "timeToResolution": 0.6    // 0=imminent, 1=decade+
//   },
//   "horizon": 0
// }
//
// ── CUSTOM mode ──
// {
//   "mode": "custom",
//   "inputs": {
//     "entropy": 0.72,           // Direct entropy input (0-1)
//     "coherence": 0.28,         // Should sum to ~1 with entropy
//     "ev": true,                // Expected value gate
//     "rho01": 0.45,             // Off-diagonal density matrix element
//     "timeStates": [3,3,2,2,1,0] // Per-horizon state overrides (optional)
//   },
//   "horizon": 1
// }

// Rate limiting store (in-memory, resets on cold start)
const rateLimitStore = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: return API documentation
  if (req.method === 'GET') {
    return res.status(200).json({
      name: 'NERVA Decision Engine API',
      version: '1.0',
      description: 'Quantum-inspired decision integrity engine. Returns COMMIT/HOLD/WAIT/ESCALATE/TOXIC signal with full entropy analysis.',
      built_by: 'Starpoint Enterprises LLC',
      modes: ['residential', 'corporate', 'geopolitical', 'custom'],
      horizons: { 0: '24h', 1: '72h', 2: '30d', 3: '6mo', 4: '2yr', 5: '10yr' },
      endpoint: 'POST /api/nerva',
      rateLimit: '100 requests/hour per IP (free tier)',
      example: {
        mode: 'residential',
        inputs: { homeValue: 664000, medianIncome: 180000, medianRent: 1790, daysOnMarket: 22 },
        horizon: 1,
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST required' });
  }

  // Basic rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 3600000; // 1 hour
  const limit = 100;
  if (!rateLimitStore.has(ip)) rateLimitStore.set(ip, []);
  const requests = rateLimitStore.get(ip).filter(t => now - t < windowMs);
  if (requests.length >= limit) {
    return res.status(429).json({
      ok: false,
      error: 'Rate limit exceeded',
      resetAt: new Date(Math.min(...requests) + windowMs).toISOString(),
      limit,
    });
  }
  requests.push(now);
  rateLimitStore.set(ip, requests);

  try {
    const body = req.body || await parseBody(req);
    const { mode = 'custom', inputs = {}, horizon = 1, context = {} } = body;

    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ ok: false, error: 'inputs object required' });
    }

    // Compute NERVA signal based on mode
    const result = computeNERVA(mode, inputs, horizon, context);

    res.setHeader('Cache-Control', 'no-store'); // decisions should never be cached
    return res.status(200).json({
      ok: true,
      ...result,
      meta: {
        mode,
        horizon,
        horizonLabel: ['24h', '72h', '30d', '6mo', '2yr', '10yr'][horizon] || '72h',
        computedAt: new Date().toISOString(),
        engine: 'NERVA v9 · Starpoint Enterprises LLC',
      },
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// NERVA CORE ENGINE
// Von Neumann entropy + Bloch sphere state machine
// ════════════════════════════════════════════════════════════════

function computeNERVA(mode, inputs, horizon, context) {
  let entropy, coherence, ev, rho01, why, signal;

  switch (mode) {
    case 'residential':
      ({ entropy, coherence, ev, rho01, why } = computeResidential(inputs, horizon));
      break;
    case 'corporate':
      ({ entropy, coherence, ev, rho01, why } = computeCorporate(inputs, horizon));
      break;
    case 'geopolitical':
      ({ entropy, coherence, ev, rho01, why } = computeGeopolitical(inputs, horizon));
      break;
    case 'custom':
    default:
      entropy  = clamp(inputs.entropy  ?? 0.5, 0, 1);
      coherence = clamp(inputs.coherence ?? (1 - entropy), 0, 1);
      ev       = inputs.ev ?? (entropy < 0.5);
      rho01    = clamp(inputs.rho01 ?? coherence * 0.5, 0, 1);
      why      = inputs.why || [];
      break;
  }

  // Apply horizon decay — entropy partially decays over longer horizons
  // Short-term volatility doesn't survive to 10yr
  const horizonDecayFactor = [1.0, 0.92, 0.80, 0.65, 0.50, 0.35][horizon] || 0.92;
  const baseEntropy = entropy;
  entropy = Math.min(0.95, Math.max(0.05, entropy * horizonDecayFactor));
  coherence = 1 - entropy;

  // Von Neumann entropy S(ρ) = -(p log₂p + q log₂q)
  const p = (1 + coherence) / 2;
  const q = 1 - p;
  const vonNeumannEntropy = p < 1 && q > 0
    ? -(p * Math.log2(p) + q * Math.log2(q))
    : 0;

  // Signal strength: inverse of entropy, modulated by coherence
  signal = parseFloat(((1 - entropy) * 100).toFixed(1));

  // Negative EV gate — if expected value is negative, cap signal
  if (!ev) signal = Math.min(signal, 35);

  // NERVA state from entropy thresholds
  const state = entropy < 0.25 ? 'COMMIT'
    : entropy < 0.42 ? 'HOLD'
    : entropy < 0.60 ? 'WAIT'
    : entropy < 0.78 ? 'ESCALATE'
    : 'TOXIC';

  // Opportunity surface: ESCALATE/TOXIC now but improving at longer horizons
  const opportunityScore = entropy > 0.6 && horizonDecayFactor < 0.7
    ? Math.round((entropy - 0.6) * 100 * (1 - horizonDecayFactor) * 2)
    : 0;

  // Semantic interpretation
  const semantics = {
    COMMIT:   'Decision surface coherent. Signal clear and actionable. Act with confidence.',
    HOLD:     'Fundamentals positive but timing uncertain. Position for entry, await catalyst.',
    WAIT:     'Genuine two-way risk. Insufficient signal clarity for commitment at this horizon.',
    ESCALATE: 'Decision pressure building. Coherence degrading. Reduce exposure or prepare exit.',
    TOXIC:    'Maximum entropy. No actionable signal. Stand aside — noise has overwhelmed the field.',
  }[state];

  return {
    state,
    signal,
    entropy:          parseFloat(entropy.toFixed(4)),
    coherence:        parseFloat(coherence.toFixed(4)),
    vonNeumannEntropy: parseFloat(vonNeumannEntropy.toFixed(4)),
    rho01:            parseFloat(rho01.toFixed(4)),
    evGate:           ev,
    opportunityScore,
    semantics,
    why,
    horizonEffect: {
      baseEntropy:    parseFloat(baseEntropy.toFixed(4)),
      decayFactor:    horizonDecayFactor,
      note: baseEntropy > entropy
        ? `Entropy decayed ${((baseEntropy-entropy)*100).toFixed(0)}% at ${['24h','72h','30d','6mo','2yr','10yr'][horizon]} horizon — short-term volatility not structural`
        : 'Entropy stable across horizon',
    },
  };
}

// ── RESIDENTIAL computation ──
function computeResidential(i, horizon) {
  const homeValue    = i.homeValue    || 0;
  const income       = i.medianIncome || i.income || 0;
  const rent         = i.medianRent   || i.rent   || 0;
  const dom          = i.daysOnMarket || 30;
  const vacancy      = i.vacancyRate  || 0;
  const flood        = clamp(i.floodRisk  || 0, 0, 1);
  const fire         = clamp(i.fireRisk   || 0, 0, 1);
  const mortgage     = i.mortgageRate || 6.5;
  const priceYoY     = i.priceYoY     || 0;

  // Price-to-income ratio → base entropy
  const pti = income > 0 ? homeValue / income : 5;
  const ptiEntropy = clamp((pti - 1) / 12, 0.05, 0.90);

  // Days on market → market velocity entropy
  const domEntropy = clamp(dom / 90, 0, 0.80);

  // Mortgage rate → affordability stress entropy
  const mortgageEntropy = mortgage > 7.5 ? 0.15 : mortgage > 7 ? 0.10 : mortgage > 6 ? 0.05 : 0;

  // Climate risk → insurance entropy
  const climateEntropy = (flood * 0.6 + fire * 0.4) * 0.25;

  // Vacancy → oversupply entropy
  const vacancyEntropy = clamp(vacancy / 0.20, 0, 0.15);

  // Combine
  const entropy = clamp(
    ptiEntropy * 0.45 +
    domEntropy * 0.25 +
    mortgageEntropy * 0.15 +
    climateEntropy * 0.10 +
    vacancyEntropy * 0.05,
    0.05, 0.92
  );

  // EV gate: rent yield > 4.5% for positive cash flow
  const rentYield = homeValue > 0 && rent > 0 ? (rent * 12) / homeValue : 0;
  const ev = rentYield > 0.045;

  // Coherence
  const coherence = 1 - entropy;
  const rho01 = coherence * 0.5 * (priceYoY > 0 ? 1.1 : 0.9);

  // Why bullets
  const why = [];
  if (pti > 8)   why.push(`P/I ratio ${pti.toFixed(1)}x — severe affordability stress, structural entropy`);
  if (pti < 3)   why.push(`P/I ratio ${pti.toFixed(1)}x — historically affordable, strong coherence signal`);
  if (dom > 60)  why.push(`${dom} days on market — absorption slowing, buyer leverage building`);
  if (dom < 15)  why.push(`${dom} days on market — tight supply, sellers commanding premium`);
  if (flood > 0.5) why.push(`Flood risk ${(flood*10).toFixed(0)}/10 — insurance market stress elevated`);
  if (fire > 0.5)  why.push(`Fire risk ${(fire*10).toFixed(0)}/10 — FAIR Plan dependency risk`);
  if (!ev && rent > 0) why.push(`Rent yield ${(rentYield*100).toFixed(1)}% — below 4.5% EV threshold for investment`);
  if (ev)        why.push(`Rent yield ${(rentYield*100).toFixed(1)}% — positive cash flow threshold cleared`);
  if (mortgage > 7) why.push(`Mortgage rate ${mortgage.toFixed(2)}% — affordability compressed, demand suppressed`);

  return { entropy, coherence, ev, rho01, why };
}

// ── CORPORATE RE computation ──
function computeCorporate(i, horizon) {
  const capRate      = i.capRate      || 0.05;
  const vacancy      = i.vacancy      || 0.10;
  const leaseTerm    = i.leaseTermAvg || 5;
  const anchorRisk   = clamp(i.anchorTenantRisk || 0, 0, 1);
  const dscr         = i.debtServiceRatio || 1.25;
  const climate      = clamp(i.climateExposure || 0, 0, 1);
  const vacTrend     = i.marketVacancyTrend || 0;

  // Cap rate compression entropy: low cap rate = overpriced = high entropy
  const capEntropy = capRate < 0.04 ? 0.70 : capRate < 0.055 ? 0.45 : capRate < 0.07 ? 0.25 : 0.15;

  // Vacancy entropy
  const vacEntropy = clamp(vacancy / 0.40, 0, 0.85);

  // Lease rollover risk: short remaining term = high entropy
  const leaseEntropy = leaseTerm < 2 ? 0.60 : leaseTerm < 4 ? 0.35 : leaseTerm < 7 ? 0.15 : 0.05;

  // Anchor tenant risk
  const anchorEntropy = anchorRisk * 0.40;

  // DSCR: below 1.0 = distress
  const dscrEntropy = dscr < 1.0 ? 0.80 : dscr < 1.15 ? 0.45 : dscr < 1.25 ? 0.20 : 0.05;

  // Climate exposure
  const climateEntropy = climate * 0.20;

  // Vacancy trend: rising vacancy = additional entropy
  const trendEntropy = vacTrend > 0.05 ? 0.15 : vacTrend > 0.02 ? 0.08 : 0;

  const entropy = clamp(
    capEntropy    * 0.25 +
    vacEntropy    * 0.25 +
    leaseEntropy  * 0.20 +
    anchorEntropy * 0.10 +
    dscrEntropy   * 0.10 +
    climateEntropy * 0.05 +
    trendEntropy  * 0.05,
    0.05, 0.92
  );

  // EV gate: DSCR > 1.15 and cap rate > 4%
  const ev = dscr > 1.15 && capRate > 0.04;
  const coherence = 1 - entropy;
  const rho01 = coherence * 0.45;

  const why = [];
  if (capRate < 0.04) why.push(`Cap rate ${(capRate*100).toFixed(1)}% — compressed below risk-free rate threshold`);
  if (vacancy > 0.20) why.push(`Vacancy ${(vacancy*100).toFixed(0)}% — above structural equilibrium, rollover pressure`);
  if (leaseTerm < 3)  why.push(`${leaseTerm.toFixed(1)}yr avg lease term — rollover cliff approaching`);
  if (anchorRisk > 0.4) why.push(`Anchor tenant loss probability ${(anchorRisk*100).toFixed(0)}% — value at risk`);
  if (dscr < 1.15)   why.push(`DSCR ${dscr.toFixed(2)} — thin debt coverage, refinancing risk elevated`);
  if (climate > 0.5) why.push(`Climate exposure ${(climate*100).toFixed(0)}% — insurance and physical risk material`);
  if (vacTrend > 0.02) why.push(`Market vacancy rising +${(vacTrend*100).toFixed(0)}% — demand destruction in progress`);

  return { entropy, coherence, ev, rho01, why };
}

// ── GEOPOLITICAL computation ──
function computeGeopolitical(i, horizon) {
  const conflict     = clamp(i.conflictIntensity        || 0, 0, 1);
  const stability    = clamp(i.institutionalStability   || 0.5, 0, 1);
  const econ         = clamp(i.economicStress           || 0, 0, 1);
  const shock        = clamp(i.externalShockProb        || 0, 0, 1);
  const resolution   = clamp(i.timeToResolution         || 0.5, 0, 1);

  const entropy = clamp(
    conflict  * 0.35 +
    (1 - stability) * 0.25 +
    econ      * 0.20 +
    shock     * 0.15 +
    (1 - resolution) * 0.05,
    0.05, 0.95
  );

  const ev = entropy < 0.65 && stability > 0.4;
  const coherence = 1 - entropy;
  const rho01 = stability * coherence * 0.6;

  const why = [];
  if (conflict > 0.6)    why.push(`Conflict intensity ${(conflict*10).toFixed(0)}/10 — kinetic risk structurally elevated`);
  if (stability < 0.4)   why.push(`Institutional stability ${(stability*100).toFixed(0)}% — governance breakdown risk`);
  if (econ > 0.6)        why.push(`Economic stress ${(econ*100).toFixed(0)}% — fiscal/monetary pressure acute`);
  if (shock > 0.5)       why.push(`External shock probability ${(shock*100).toFixed(0)}% — tail risk material`);

  return { entropy, coherence, ev, rho01, why };
}

// ── Utilities ──
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
