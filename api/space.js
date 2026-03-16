// NERVA Globe — Space Intelligence API
// Path in repo: api/space.js
// URL: https://nerva-globe.vercel.app/api/space
//
// No API key required — all sources use DEMO_KEY or are fully public
//
// Sources:
//   wheretheiss.at     ISS real-time position (no key, CORS open)
//   NASA DONKI         Solar flares, CMEs, geomagnetic storms (DEMO_KEY)
//   NASA NeoWs         Near-Earth asteroid close approaches (DEMO_KEY)
//   NOAA SWPC          Geomagnetic Kp index, solar wind (no key)
//
// Query params:
//   ?series=all        All space feeds (default)
//   ?series=iss        ISS position only
//   ?series=solar      Solar weather only
//   ?series=asteroids  Near-Earth objects only
//   ?series=moon       Lunar phase + Artemis status

const NASA_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60'); // 5min cache
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { series = 'all' } = req.query;

  try {
    const results = {};
    const nodeMods = {};
    const events = [];

    const fetch_iss      = series === 'all' || series === 'iss';
    const fetch_solar    = series === 'all' || series === 'solar';
    const fetch_asteroids = series === 'all' || series === 'asteroids';
    const fetch_moon     = series === 'all' || series === 'moon';

    const [issR, solarR, asterR, moonR] = await Promise.allSettled([
      fetch_iss       ? fetchISS()       : null,
      fetch_solar     ? fetchSolar()     : null,
      fetch_asteroids ? fetchAsteroids() : null,
      fetch_moon      ? fetchMoon()      : null,
    ]);

    // ── ISS ──
    if (issR.value) {
      results.iss = issR.value;
      if (issR.value.nerva.entDelta > 0) {
        nodeMods['ISS'] = { entDelta: issR.value.nerva.entDelta, reason: issR.value.nerva.note };
        events.push({ type: 'info', node: 'ISS', message: issR.value.nerva.note });
      }
    }

    // ── Solar Weather ──
    if (solarR.value) {
      results.solar = solarR.value;
      const sd = solarR.value;
      if (sd.nerva.entDelta > 0) {
        // Solar activity affects: GPS, Starlink, satellite nodes
        ['GPS Constellation', 'Starlink', 'Solar Activity'].forEach(n => {
          nodeMods[n] = { entDelta: Math.min(0.90, sd.nerva.entDelta), reason: sd.nerva.note };
        });
        if (sd.maxFlareClass >= 'M') {
          events.push({ type: 'extreme', node: 'Solar Activity',
            message: `🌞 Solar flare ${sd.latestFlare?.classType||'?'} — satellite/GPS disruption risk elevated` });
        }
      }
    }

    // ── Asteroids ──
    if (asterR.value) {
      results.asteroids = asterR.value;
      const ad = asterR.value;
      if (ad.nerva.entDelta > 0) {
        nodeMods['Asteroid Belt'] = { entDelta: ad.nerva.entDelta, reason: ad.nerva.note };
        if (ad.hazardous.length > 0) {
          events.push({ type: 'notable', node: 'Asteroid Belt',
            message: `☄️ ${ad.hazardous[0].name} — close approach ${ad.hazardous[0].closeApproach} · ${ad.hazardous[0].distanceLd} LD` });
        }
      }
    }

    // ── Moon ──
    if (moonR.value) {
      results.moon = moonR.value;
      const md = moonR.value;
      nodeMods['Moon'] = { entDelta: md.nerva.entDelta, reason: md.nerva.note };
      nodeMods['Artemis Program'] = { entDelta: md.nerva.artemisEntropy, reason: 'US-China lunar competition — Artemis vs Chang\'e trajectory' };
    }

    return res.status(200).json({
      ok: true,
      series,
      results,
      nodeMods,
      events,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ── ISS Real-Time Position ──
async function fetchISS() {
  const res = await fetch('https://api.wheretheiss.at/v1/satellites/25544', {
    headers: { 'User-Agent': 'NERVAGlobe/1.0' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`ISS API ${res.status}`);
  const d = await res.json();

  const lat  = parseFloat(d.latitude);
  const lng  = parseFloat(d.longitude);
  const alt  = parseFloat(d.altitude);   // km
  const vel  = parseFloat(d.velocity);   // km/h
  const vis  = d.visibility;             // daylight | eclipsed

  // Nominal altitude: 408km. Deviation > 10km = entropy signal
  const nominalAlt = 408;
  const altDeviation = Math.abs(alt - nominalAlt);
  const altEntropy = Math.min(0.40, altDeviation / 50);

  // Velocity deviation from nominal ~27,600 km/h
  const nominalVel = 27635;
  const velDeviation = Math.abs(vel - nominalVel);
  const velEntropy = Math.min(0.20, velDeviation / 5000);

  const entropy = altEntropy * 0.7 + velEntropy * 0.3;
  const entDelta = entropy > 0.05 ? parseFloat(entropy.toFixed(4)) : 0;

  return {
    position: { lat, lng, altitude: parseFloat(alt.toFixed(2)), velocity: parseFloat(vel.toFixed(0)) },
    visibility: vis,
    nerva: {
      entropy: parseFloat(entropy.toFixed(4)),
      entDelta,
      signal: parseFloat(((1-entropy)*100).toFixed(1)),
      note: `ISS at ${alt.toFixed(0)}km altitude · ${vel.toFixed(0)} km/h · ${vis}`,
      position: { lat, lng }, // for globe marker
    },
  };
}

// ── Solar Weather (NASA DONKI + NOAA SWPC) ──
async function fetchSolar() {
  const today = new Date();
  const start = new Date(today - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const end   = today.toISOString().split('T')[0];

  // Fetch solar flares and geomagnetic storms in parallel
  const [flareRes, gstRes, kpRes] = await Promise.allSettled([
    fetch(`https://api.nasa.gov/DONKI/FLR?startDate=${start}&endDate=${end}&api_key=${NASA_KEY}`, {
      signal: AbortSignal.timeout(8000) }),
    fetch(`https://api.nasa.gov/DONKI/GST?startDate=${start}&endDate=${end}&api_key=${NASA_KEY}`, {
      signal: AbortSignal.timeout(8000) }),
    fetch('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', {
      signal: AbortSignal.timeout(6000) }),
  ]);

  const flares = flareRes.status === 'fulfilled' && flareRes.value.ok
    ? await flareRes.value.json().catch(() => []) : [];
  const storms = gstRes.status === 'fulfilled' && gstRes.value.ok
    ? await gstRes.value.json().catch(() => []) : [];
  const kpData = kpRes.status === 'fulfilled' && kpRes.value.ok
    ? await kpRes.value.json().catch(() => []) : [];

  // Latest Kp index (0-9 scale, >5 = storm)
  const latestKp = Array.isArray(kpData) && kpData.length > 0
    ? parseFloat(kpData[kpData.length - 1]?.kp_index || 0) : 0;

  // Max flare class in last 7 days
  const flareClasses = { B:1, C:2, M:3, X:4 };
  let maxFlareNum = 0;
  let maxFlareClass = 'B';
  let latestFlare = null;

  flares.forEach(f => {
    const cls = f.classType?.[0] || 'B';
    const num = parseFloat(f.classType?.slice(1)) || 1;
    const score = (flareClasses[cls] || 1) * num;
    if (score > maxFlareNum) {
      maxFlareNum = score;
      maxFlareClass = f.classType;
      latestFlare = f;
    }
  });

  // NERVA entropy from space weather
  // X-class flare → 0.80+ entropy on satellite/GPS nodes
  // M-class → 0.50+
  // C-class → 0.25
  // Kp > 7 → geomagnetic storm entropy
  const flareEntropy = maxFlareNum >= 4 ? 0.80   // X-class
    : maxFlareNum >= 3 ? 0.50                      // M-class
    : maxFlareNum >= 2 ? 0.25                      // C-class
    : 0.10;                                        // B-class

  const kpEntropy = latestKp >= 7 ? 0.70 : latestKp >= 5 ? 0.45 : latestKp >= 3 ? 0.20 : 0.05;

  const entropy = Math.min(0.92, flareEntropy * 0.6 + kpEntropy * 0.4);
  const entDelta = entropy > 0.15 ? parseFloat((entropy - 0.10).toFixed(4)) : 0;

  const stormCount = storms.length;
  const note = `Solar: ${maxFlareClass||'B-class'} flare · Kp ${latestKp.toFixed(1)} · ${stormCount} storm(s) in 7d`;

  return {
    flares: {
      count: flares.length,
      maxClass: maxFlareClass || 'None',
      latestFlare: latestFlare ? {
        classType: latestFlare.classType,
        beginTime: latestFlare.beginTime,
        sourceLocation: latestFlare.sourceLocation,
      } : null,
    },
    geomagnetic: {
      stormCount,
      kpIndex: parseFloat(latestKp.toFixed(2)),
      kpLabel: latestKp >= 7 ? 'SEVERE STORM' : latestKp >= 5 ? 'STORM' : latestKp >= 3 ? 'ACTIVE' : 'QUIET',
    },
    maxFlareClass: maxFlareClass || 'B',
    latestFlare,
    nerva: {
      entropy: parseFloat(entropy.toFixed(4)),
      entDelta,
      signal: parseFloat(((1-entropy)*100).toFixed(1)),
      state: entropy < 0.25 ? 'COMMIT' : entropy < 0.42 ? 'HOLD' : entropy < 0.60 ? 'WAIT' : entropy < 0.78 ? 'ESCALATE' : 'TOXIC',
      note,
      affectedNodes: ['GPS Constellation', 'Starlink', 'Solar Activity', 'ISS', 'Deep Space Comms'],
    },
  };
}

// ── Near-Earth Asteroids ──
async function fetchAsteroids() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.nasa.gov/neo/rest/v1/feed?start_date=${today}&end_date=${today}&api_key=${NASA_KEY}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`NeoWs API ${res.status}`);
  const data = await res.json();

  const allNeos = Object.values(data.near_earth_objects || {}).flat();
  const hazardous = allNeos.filter(n => n.is_potentially_hazardous_asteroid);
  const closest = allNeos
    .map(n => ({
      name: n.name,
      hazardous: n.is_potentially_hazardous_asteroid,
      diameterKm: parseFloat(n.estimated_diameter?.kilometers?.estimated_diameter_max?.toFixed(3)) || 0,
      closeApproach: n.close_approach_data?.[0]?.close_approach_date_full,
      distanceLd: parseFloat(n.close_approach_data?.[0]?.miss_distance?.lunar || 999).toFixed(1),
      distanceKm: parseFloat(n.close_approach_data?.[0]?.miss_distance?.kilometers || 999999999).toFixed(0),
      velocityKmh: parseFloat(n.close_approach_data?.[0]?.relative_velocity?.kilometers_per_hour || 0).toFixed(0),
    }))
    .sort((a,b) => parseFloat(a.distanceLd) - parseFloat(b.distanceLd))
    .slice(0, 5);

  // NERVA entropy: hazardous NEO < 10 LD = significant signal
  const minDist = closest.length > 0 ? parseFloat(closest[0].distanceLd) : 999;
  const entropy = minDist < 5 ? 0.75
    : minDist < 10 ? 0.55
    : minDist < 20 ? 0.35
    : minDist < 50 ? 0.20
    : 0.10;

  // Hazardous count adds entropy
  const hazardEntropy = Math.min(0.20, hazardous.length * 0.04);
  const totalEntropy = Math.min(0.90, entropy + hazardEntropy);
  const entDelta = totalEntropy > 0.15 ? parseFloat((totalEntropy - 0.10).toFixed(4)) : 0;

  return {
    count: allNeos.length,
    hazardousCount: hazardous.length,
    closest,
    hazardous: hazardous.slice(0,3).map(n => ({
      name: n.name,
      closeApproach: n.close_approach_data?.[0]?.close_approach_date_full,
      distanceLd: parseFloat(n.close_approach_data?.[0]?.miss_distance?.lunar || 999).toFixed(1),
      diameterKm: parseFloat(n.estimated_diameter?.kilometers?.estimated_diameter_max?.toFixed(3)) || 0,
    })),
    nerva: {
      entropy: parseFloat(totalEntropy.toFixed(4)),
      entDelta,
      signal: parseFloat(((1-totalEntropy)*100).toFixed(1)),
      note: `${allNeos.length} NEOs today · ${hazardous.length} potentially hazardous · closest ${minDist} LD`,
    },
  };
}

// ── Lunar Phase + Artemis/Chang'e Competition ──
async function fetchMoon() {
  // Lunar phase: compute from known reference (new moon Jan 11, 2024)
  const refNewMoon = new Date('2024-01-11T11:57:00Z').getTime();
  const synodicMonth = 29.53058867 * 24 * 60 * 60 * 1000; // ms
  const now = Date.now();
  const elapsed = (now - refNewMoon) % synodicMonth;
  const phase = elapsed / synodicMonth; // 0=new, 0.5=full, 1=new again

  const phaseAngle = phase * 360;
  const phaseName = phase < 0.0625 ? 'New Moon'
    : phase < 0.1875 ? 'Waxing Crescent'
    : phase < 0.3125 ? 'First Quarter'
    : phase < 0.4375 ? 'Waxing Gibbous'
    : phase < 0.5625 ? 'Full Moon'
    : phase < 0.6875 ? 'Waning Gibbous'
    : phase < 0.8125 ? 'Last Quarter'
    : phase < 0.9375 ? 'Waning Crescent'
    : 'New Moon';

  const illumination = Math.round(Math.abs(Math.cos(phase * 2 * Math.PI) * 50 - 50));

  // Days until next new moon (optimal for Artemis lunar surface ops)
  const daysUntilNew = Math.round((1 - phase) * 29.53);
  const daysUntilFull = Math.round(Math.abs(0.5 - phase) * 29.53);

  // Lunar NERVA: Full moon = max illumination = COMMIT for surface ops
  // New moon = dark = ESCALATE for navigation
  const lunarEntropy = phase < 0.1 || phase > 0.9 ? 0.65  // new moon: dark, hard to navigate
    : phase > 0.45 && phase < 0.55 ? 0.15                  // full moon: COMMIT, max visibility
    : 0.35;                                                  // quarters: HOLD

  // Artemis/China competition entropy — structural, based on program status
  // Artemis III target was 2026, now slipping to 2027+
  // China Chang'e 7 targeting 2026 south pole
  const artemisEntropy = 0.55; // WAIT — both programs active, outcome uncertain

  const note = `${phaseName} · ${illumination}% illuminated · ${daysUntilNew}d until new moon`;

  return {
    phase: {
      value: parseFloat(phase.toFixed(4)),
      angle: parseFloat(phaseAngle.toFixed(1)),
      name: phaseName,
      illumination,
      daysUntilNew,
      daysUntilFull,
    },
    competition: {
      artemisStatus: 'Artemis III targeting 2027 — lunar south pole crewed landing',
      changeStatus: "Chang'e 7 targeting 2026 — lunar south pole robotic mission",
      note: 'US-China lunar south pole competition — water ice resource at stake',
    },
    nerva: {
      entropy: parseFloat(lunarEntropy.toFixed(4)),
      entDelta: parseFloat((lunarEntropy * 0.5).toFixed(4)),
      artemisEntropy,
      signal: parseFloat(((1-lunarEntropy)*100).toFixed(1)),
      state: lunarEntropy < 0.25 ? 'COMMIT' : lunarEntropy < 0.42 ? 'HOLD' : lunarEntropy < 0.60 ? 'WAIT' : 'ESCALATE',
      note,
    },
  };
}
