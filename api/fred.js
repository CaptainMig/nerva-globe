// NERVA Globe — FRED API Proxy
// Path in repo: api/fred.js
// URL when deployed: https://nerva-globe.vercel.app/api/fred
//
// Add FRED_API_KEY to Vercel Environment Variables.
// Get your free key (no card): fred.stlouisfed.org/docs/api/api_key.html
//
// Query params:
//   ?series=mortgage30   30yr fixed mortgage rate
//   ?series=fedFunds     Federal funds rate
//   ?series=cpi          Consumer Price Index
//   ?series=caseshiller  Case-Shiller Home Price Index
//   ?series=unemployment Unemployment rate
//   ?series=housingStarts New housing starts

const SERIES_MAP = {
  mortgage30:    { id: 'MORTGAGE30US', name: '30yr Mortgage',     unit: '%'     },
  fedFunds:      { id: 'FEDFUNDS',     name: 'Fed Funds Rate',    unit: '%'     },
  cpi:           { id: 'CPIAUCSL',     name: 'CPI',               unit: 'index' },
  caseshiller:   { id: 'CSUSHPINSA',   name: 'Case-Shiller HPI',  unit: 'index' },
  unemployment:  { id: 'UNRATE',       name: 'Unemployment',      unit: '%'     },
  housingStarts: { id: 'HOUST',        name: 'Housing Starts',    unit: 'K'     },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Check API key
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: 'FRED_API_KEY not set',
      action: 'Add FRED_API_KEY in Vercel Dashboard → Project → Settings → Environment Variables',
      freeKey: 'https://fred.stlouisfed.org/docs/api/api_key.html',
    });
  }

  const series = req.query.series || 'mortgage30';
  const def = SERIES_MAP[series];
  if (!def) {
    return res.status(400).json({
      ok: false,
      error: `Unknown series "${series}"`,
      valid: Object.keys(SERIES_MAP),
    });
  }

  try {
    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', def.id);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('sort_order', 'desc');
    url.searchParams.set('limit', '13'); // 13 months = 1yr of history + current

    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': 'NERVAGlobe/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) {
      throw new Error(`FRED returned HTTP ${upstream.status}`);
    }

    const raw = await upstream.json();
    const obs = (raw.observations || []).filter(o => o.value !== '.');

    if (!obs.length) throw new Error('No observations returned');

    const latest = parseFloat(obs[0].value);
    const prev   = parseFloat(obs[1]?.value ?? obs[0].value);
    const yrAgo  = parseFloat(obs[12]?.value ?? obs[obs.length - 1].value);

    const momChange  = latest - prev;             // month-over-month
    const yoyChange  = latest - yrAgo;            // year-over-year
    const yoyPct     = yrAgo !== 0 ? (yoyChange / yrAgo) * 100 : 0;

    // NERVA entropy signal:
    // Large YoY moves = high entropy on affected nodes
    // Mortgage rate above 7% = structural affordability stress
    let entDelta = 0;
    let nervaNote = '';

    if (series === 'mortgage30') {
      if (latest > 7.5)       { entDelta = 0.18; nervaNote = `${latest.toFixed(2)}% mortgage — severe affordability constraint`; }
      else if (latest > 7.0)  { entDelta = 0.12; nervaNote = `${latest.toFixed(2)}% mortgage — elevated, compressing RE demand`; }
      else if (latest > 6.0)  { entDelta = 0.06; nervaNote = `${latest.toFixed(2)}% mortgage — above neutral, monitoring`; }
      else if (latest < 5.5)  { entDelta = -0.05; nervaNote = `${latest.toFixed(2)}% mortgage — rate relief, demand expanding`; }
      else                    { entDelta = 0.02;  nervaNote = `${latest.toFixed(2)}% mortgage — near neutral`; }
    } else if (series === 'fedFunds') {
      if (latest > 5.0)       { entDelta = 0.10; nervaNote = `Fed funds ${latest.toFixed(2)}% — restrictive policy active`; }
      else if (latest > 3.0)  { entDelta = 0.04; nervaNote = `Fed funds ${latest.toFixed(2)}% — normalizing`; }
      else                    { entDelta = -0.03; nervaNote = `Fed funds ${latest.toFixed(2)}% — accommodative`; }
    } else if (series === 'cpi') {
      if (yoyPct > 5)         { entDelta = 0.12; nervaNote = `CPI +${yoyPct.toFixed(1)}% YoY — inflation elevated`; }
      else if (yoyPct > 3)    { entDelta = 0.06; nervaNote = `CPI +${yoyPct.toFixed(1)}% YoY — above target`; }
      else                    { entDelta = 0;     nervaNote = `CPI +${yoyPct.toFixed(1)}% YoY — near target`; }
    } else if (series === 'caseshiller') {
      if (yoyPct > 8)         { entDelta = 0.10; nervaNote = `Case-Shiller +${yoyPct.toFixed(1)}% YoY — price acceleration`; }
      else if (yoyPct < -5)   { entDelta = 0.08; nervaNote = `Case-Shiller ${yoyPct.toFixed(1)}% YoY — correction in progress`; }
      else                    { entDelta = 0.02;  nervaNote = `Case-Shiller +${yoyPct.toFixed(1)}% YoY — moderate appreciation`; }
    }

    return res.status(200).json({
      ok: true,
      series,
      seriesId: def.id,
      name: def.name,
      unit: def.unit,
      latest: {
        value: latest,
        date: obs[0].date,
        formatted: def.unit === '%' ? `${latest.toFixed(2)}%` : latest.toFixed(1),
      },
      change: {
        mom: parseFloat(momChange.toFixed(3)),
        yoy: parseFloat(yoyChange.toFixed(3)),
        yoyPct: parseFloat(yoyPct.toFixed(2)),
        direction: momChange > 0 ? 'up' : momChange < 0 ? 'down' : 'flat',
      },
      nerva: {
        entDelta: parseFloat(entDelta.toFixed(4)),
        note: nervaNote,
        // Which NERVA layers this series affects
        affects: series === 'mortgage30' || series === 'caseshiller'
          ? ['re_metro', 're_hood', 're_multifamily', 'finance']
          : series === 'fedFunds' || series === 'cpi'
          ? ['finance', 'resources', 'trade']
          : ['finance'],
      },
      // Sparkline: last 12 months oldest→newest
      history: obs.slice(0, 13).reverse().map(o => ({
        date: o.date,
        value: parseFloat(o.value),
      })),
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      series,
    });
  }
}
