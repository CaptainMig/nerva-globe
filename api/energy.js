// NERVA Globe — EIA Energy Price Intelligence
// Path in repo: api/energy.js
// URL: https://nerva-globe.vercel.app/api/energy
//
// No API key required — EIA Open Data is fully public
// Docs: https://www.eia.gov/opendata/
//
// Optional: EIA_API_KEY for higher rate limits (free at eia.gov/opendata/register.php)
//
// Query params:
//   ?series=wti          WTI crude oil spot price
//   ?series=brent        Brent crude oil spot price
//   ?series=natgas       Henry Hub natural gas spot
//   ?series=gasoline     US regular gasoline retail
//   ?series=all          All series (default)
//
// NERVA integration:
//   WTI/Brent price spikes → elevate entropy on: resources, energy, geopolitics, finance
//   Natural gas spikes → elevate entropy on: energy, climate, food (fertilizer)
//   Price drops → reduce entropy, may create opportunity signals on energy nodes

const EIA_BASE = 'https://api.eia.gov/v2';

// EIA series IDs
const SERIES = {
  wti: {
    id: 'PET.RWTC.D',
    name: 'WTI Crude Oil',
    unit: '$/barrel',
    nervaLayers: ['resources', 'energy', 'geopolitics', 'finance'],
    baselinePrice: 70, // $/bbl baseline for entropy calc
  },
  brent: {
    id: 'PET.RBRTE.D',
    name: 'Brent Crude Oil',
    unit: '$/barrel',
    nervaLayers: ['resources', 'energy', 'geopolitics'],
    baselinePrice: 74,
  },
  natgas: {
    id: 'NG.RNGWHHD.D',
    name: 'Henry Hub Natural Gas',
    unit: '$/MMBtu',
    nervaLayers: ['energy', 'climate', 'food'],
    baselinePrice: 2.5,
  },
  gasoline: {
    id: 'PET.EMM_EPMR_PTE_NUS_DPG.W',
    name: 'US Regular Gasoline',
    unit: '$/gallon',
    nervaLayers: ['energy', 'finance', 'humanitarian'],
    baselinePrice: 3.30,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600'); // 1hr cache
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { series = 'all' } = req.query;
  const apiKey = process.env.EIA_API_KEY || ''; // optional

  const seriesKeys = series === 'all' ? Object.keys(SERIES) : [series];
  const validKeys = seriesKeys.filter(k => SERIES[k]);

  if (!validKeys.length) {
    return res.status(400).json({
      ok: false,
      error: `Unknown series: ${series}`,
      valid: Object.keys(SERIES),
    });
  }

  try {
    const results = await Promise.allSettled(
      validKeys.map(key => fetchSeries(key, SERIES[key], apiKey))
    );

    const data = {};
    const nodeMods = {};
    const events = [];

    results.forEach((r, i) => {
      const key = validKeys[i];
      if (r.status === 'fulfilled' && r.value) {
        data[key] = r.value;

        // Build node entropy modifications
        const d = r.value;
        if (d.nerva.entDelta !== 0) {
          SERIES[key].nervaLayers.forEach(layer => {
            if (!nodeMods[layer]) nodeMods[layer] = { entDelta: 0, reason: '' };
            nodeMods[layer].entDelta = parseFloat(
              Math.min(0.25, nodeMods[layer].entDelta + Math.abs(d.nerva.entDelta)).toFixed(4)
            );
            nodeMods[layer].reason = d.nerva.note;
          });
        }

        // Create live event if significant move
        if (Math.abs(d.change.dayPct) > 2) {
          const dir = d.change.dayPct > 0 ? '↑' : '↓';
          events.push({
            type: Math.abs(d.change.dayPct) > 4 ? 'extreme' : 'notable',
            message: `${d.name} ${dir} ${Math.abs(d.change.dayPct).toFixed(1)}% — $${d.latest.value.toFixed(2)}${d.unit === '$/barrel' ? '/bbl' : d.unit === '$/MMBtu' ? '/MMBtu' : '/gal'}`,
            series: key,
            entDelta: d.nerva.entDelta,
            affectedLayers: SERIES[key].nervaLayers,
          });
        }
      }
    });

    // Compute composite energy entropy
    const seriesWithData = Object.values(data).filter(d => d.latest?.value > 0);
    const compositeEntropy = seriesWithData.length > 0
      ? seriesWithData.reduce((sum, d) => sum + d.nerva.entropy, 0) / seriesWithData.length
      : 0.5;

    return res.status(200).json({
      ok: true,
      series: data,
      nodeMods,
      events,
      composite: {
        entropy: parseFloat(compositeEntropy.toFixed(4)),
        state: compositeEntropy < 0.30 ? 'COMMIT' : compositeEntropy < 0.50 ? 'HOLD' : compositeEntropy < 0.65 ? 'WAIT' : 'ESCALATE',
        signal: parseFloat(((1 - compositeEntropy) * 100).toFixed(1)),
        note: `Energy complex: ${compositeEntropy < 0.35 ? 'prices subdued, supply adequate' : compositeEntropy < 0.55 ? 'prices elevated but stable' : 'price volatility elevated — geopolitical risk premium building'}`,
      },
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function fetchSeries(key, def, apiKey) {
  try {
    // EIA v2 API endpoint
    const url = new URL(`${EIA_BASE}/seriesid/${def.id}`);
    url.searchParams.set('api_key', apiKey || 'DEMO_KEY'); // DEMO_KEY has low rate limits but works
    url.searchParams.set('data[0]', 'value');
    url.searchParams.set('sort[0][column]', 'period');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('length', '30'); // 30 days of history

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'NERVAGlobe/1.0 (nerva-globe.vercel.app)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`EIA API ${res.status}`);
    const raw = await res.json();

    const obs = raw?.response?.data || [];
    if (!obs.length) throw new Error('No data');

    // Latest and previous values
    const latest = parseFloat(obs[0]?.value) || 0;
    const prev    = parseFloat(obs[1]?.value) || latest;
    const weekAgo = parseFloat(obs[5]?.value) || latest;
    const monthAgo= parseFloat(obs[29]?.value) || latest;

    const dayChange  = latest - prev;
    const dayPct     = prev > 0 ? (dayChange / prev) * 100 : 0;
    const weekChange = latest - weekAgo;
    const weekPct    = weekAgo > 0 ? (weekChange / weekAgo) * 100 : 0;
    const monthPct   = monthAgo > 0 ? ((latest - monthAgo) / monthAgo) * 100 : 0;

    // NERVA entropy calculation
    // Based on: price vs baseline, recent volatility, direction
    const priceRatio    = latest / def.baselinePrice;
    const priceEntropy  = priceRatio > 1.4 ? 0.70  // crisis premium
      : priceRatio > 1.2 ? 0.50
      : priceRatio > 1.0 ? 0.30
      : priceRatio > 0.8 ? 0.15
      : 0.20; // very low prices = deflationary risk

    // Volatility entropy from recent moves
    const volEntropy = Math.min(0.40, Math.abs(dayPct) / 10 + Math.abs(weekPct) / 20);

    const entropy   = Math.min(0.90, priceEntropy * 0.70 + volEntropy * 0.30);
    const entDelta  = entropy > 0.50 ? parseFloat((entropy - 0.40).toFixed(4)) : 0;

    // Generate NERVA note
    let note = `${def.name} at $${latest.toFixed(2)} — `;
    if (Math.abs(dayPct) > 3) note += `sharp ${dayPct > 0 ? 'spike' : 'drop'} ${Math.abs(dayPct).toFixed(1)}% today`;
    else if (priceRatio > 1.3) note += 'significantly above baseline, supply concern priced in';
    else if (priceRatio < 0.8) note += 'below baseline, deflationary pressure or demand weakness';
    else note += `${Math.abs(monthPct).toFixed(0)}% ${monthPct > 0 ? 'up' : 'down'} vs month ago`;

    return {
      key,
      name: def.name,
      unit: def.unit,
      latest: {
        value: latest,
        date: obs[0]?.period,
        formatted: `$${latest.toFixed(2)}`,
      },
      change: {
        day: parseFloat(dayChange.toFixed(3)),
        dayPct: parseFloat(dayPct.toFixed(2)),
        week: parseFloat(weekChange.toFixed(3)),
        weekPct: parseFloat(weekPct.toFixed(2)),
        monthPct: parseFloat(monthPct.toFixed(2)),
        direction: dayChange > 0 ? 'up' : dayChange < 0 ? 'down' : 'flat',
      },
      nerva: {
        entropy: parseFloat(entropy.toFixed(4)),
        entDelta,
        signal: parseFloat(((1 - entropy) * 100).toFixed(1)),
        note,
        affectedLayers: def.nervaLayers,
        priceVsBaseline: parseFloat(priceRatio.toFixed(3)),
      },
      history: obs.slice(0, 14).map(o => ({
        date: o.period,
        value: parseFloat(o.value) || null,
      })).reverse(),
    };

  } catch(e) {
    return null;
  }
}
