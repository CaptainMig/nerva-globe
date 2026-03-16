# NERVA Globe
### Signal Intelligence Surface · v9

**[nerva-globe.vercel.app](https://nerva-globe.vercel.app)**

> *A quantum-inspired decision engine that reads where the world is coherent, where it is unstable, and where acting on the signal would be a mistake.*

Built by **[Starpoint Enterprises LLC](https://starpointenterprises.com)** · AMDG

---

## What It Is

NERVA is not a dashboard. It is a **decision integrity engine**.

Every node on the globe — a country, a market, a ZIP code, a commodity — is modeled as a quantum state on the Bloch sphere. Von Neumann entropy governs the framework. High entropy means the decision surface is incoherent: too much noise, no actionable signal. Low entropy means the field is coherent: act with confidence.

The output is one of five states:

| State | Meaning | Action |
|-------|---------|--------|
| **COMMIT** | Signal clear. Low entropy. | Act with confidence |
| **HOLD** | Fundamentals positive, timing uncertain | Position for entry |
| **WAIT** | Two-way risk. No clear signal | Observe |
| **ESCALATE** | Coherence degrading. Pressure building | Reduce exposure |
| **TOXIC** | Maximum entropy. Noise dominates | Stand aside |

---

## The Math

NERVA uses the **von Neumann entropy** of a 2×2 density matrix:

```
S(ρ) = -(p log₂p + q log₂q)
```

Where `p` and `q` are eigenvalues derived from the coherence-entropy pair of each node. The off-diagonal element `ρ₀₁` represents quantum coherence — the degree to which a signal carries actionable information across time horizons.

Six time horizons decay entropy differently:
- **24h / 72h**: Event-driven volatility dominates
- **30d / 6mo**: Structural factors emerge  
- **2yr / 10yr**: Only physics and demographics survive

---

## Live Data Stack

| Feed | Source | Updates | NERVA Signal |
|------|--------|---------|--------------|
| Seismic | USGS Earthquake Feed | Real-time | Entropy on quake nodes |
| Weather | NOAA Alerts API | 5 min | Storm/flood node entropy |
| Flood Claims | FEMA NFIP | Daily | Insurance layer entropy |
| Climate | Open-Meteo | Hourly | Temperature anomaly → climate nodes |
| Mortgage Rates | FRED (St. Louis Fed) | Weekly | RE node affordability entropy |
| Oil Prices | EIA | Daily | WTI/Brent/Gas → resources/energy entropy |
| Property Data | Census ACS + Realty | Annual/Live | ZIP-level decision signals |
| Corporate RE | CBRE/CoStar Q1 2026 | Quarterly | Office/multifamily/industrial signals |

---

## API

NERVA exposes a public decision engine API. Any application can POST inputs and receive a decision state.

```
GET  https://nerva-globe.vercel.app/api/nerva
POST https://nerva-globe.vercel.app/api/nerva
```

### Example — Residential

```json
POST /api/nerva
{
  "mode": "residential",
  "inputs": {
    "homeValue": 664000,
    "medianIncome": 180000,
    "medianRent": 1790,
    "daysOnMarket": 22,
    "mortgageRate": 6.11
  },
  "horizon": 1
}
```

### Response

```json
{
  "state": "COMMIT",
  "signal": 78.4,
  "entropy": 0.2164,
  "coherence": 0.7836,
  "evGate": false,
  "semantics": "Decision surface coherent. Signal clear and actionable.",
  "why": ["P/I ratio 3.7x — historically affordable entry"],
  "meta": { "mode": "residential", "horizonLabel": "72h", "engine": "NERVA v9" }
}
```

### Modes

| Mode | Use Case | Key Inputs |
|------|----------|-----------|
| `residential` | Home purchase decision | homeValue, income, rent, DOM, floodRisk |
| `corporate` | CRE asset underwriting | capRate, vacancy, leaseTerm, DSCR |
| `geopolitical` | Country/conflict risk | conflictIntensity, stability, economicStress |
| `custom` | Any decision surface | entropy, coherence, ev, rho01 |

**Rate limit**: 100 requests/hour per IP · Free · No key required

### All Endpoints

```
GET  /api/nerva              Decision engine + docs
POST /api/nerva              Decision signal for any inputs

GET  /api/fred?series=mortgage30    FRED economic data
GET  /api/noaa?severity=all         NOAA weather alerts + node mapping
GET  /api/energy?series=all         EIA oil/gas prices
GET  /api/census?zip=10001          Census ACS ZIP intelligence
GET  /api/corporate?metro=NYC&type=office   Corporate RE signals
GET  /api/realty?zip=07076          Live property listings
```

---

## Architecture

Single-file deployment. No build step. No framework.

```
nerva-globe/
├── index.html          # Full application (284KB, self-contained)
└── api/
    ├── nerva.js        # Decision engine API
    ├── fred.js         # FRED economic data proxy
    ├── noaa.js         # NOAA weather alerts + node mapping
    ├── energy.js       # EIA energy prices
    ├── census.js       # Census ACS ZIP intelligence
    ├── corporate.js    # Corporate RE signals
    └── realty.js       # Live property listings
```

**Stack**: Three.js · MapLibre GL · Vercel Serverless · OpenFreeMap tiles

**Deploy**: Push to GitHub → Vercel auto-deploys. No build command. No output directory.

---

## The Thesis

Every decision — buy this property, enter this market, allocate to this region — requires reading the signal beneath the noise. Traditional tools give you data. NERVA gives you a decision state.

The decision layer is the missing infrastructure in the AI stack. Models can retrieve, summarize, and generate. What they cannot do is tell you whether to act. NERVA does that — for any domain, at any time horizon, with verifiable math.

**NERVA is to decision-making what a GPS is to navigation: it doesn't tell you where to go, it tells you whether the road ahead is clear.**

---

## Built With

- **Three.js r128** — 3D globe rendering
- **MapLibre GL JS v4** — Street-level map (no API key required)  
- **OpenFreeMap** — Free tile source, no account needed
- **Vercel** — Serverless deployment
- **FRED API** — Federal Reserve economic data
- **NOAA Weather API** — Real-time weather alerts
- **EIA Open Data** — Energy price feeds
- **Census Bureau ACS** — Property and demographic data
- **Realty in US** — Live property listings

---

## Status

🟢 **Live** · [nerva-globe.vercel.app](https://nerva-globe.vercel.app)

Built and maintained by Anthony · Starpoint Enterprises LLC  
Contact: via GitHub issues

---

*NERVA v9 · Signal Intelligence Surface · Starpoint Enterprises LLC · AMDG*
