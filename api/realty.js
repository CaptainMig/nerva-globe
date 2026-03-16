// NERVA Globe — Realty in US API Proxy
// Path in repo: api/realty.js
// URL: https://nerva-globe.vercel.app/api/realty
//
// Env vars required:
//   RAPIDAPI_KEY         your RapidAPI key (same key for all RapidAPI services)
//   RAPIDAPI_REALTY_HOST realty-in-us.p.rapidapi.com
//
// Free tier: 500 requests/month — plenty for NERVA ZIP search
//
// Query params:
//   ?zip=07076           Listings in a ZIP code
//   ?zip=07076&type=sale For sale only (default)
//   ?zip=07076&type=rent Rentals only
//   ?zpid=12345          Single property detail

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey  = process.env.RAPIDAPI_KEY;
  const apiHost = process.env.RAPIDAPI_REALTY_HOST || 'realty-in-us.p.rapidapi.com';

  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: 'RAPIDAPI_KEY not configured',
      setup: 'Add RAPIDAPI_KEY to Vercel Environment Variables',
    });
  }

  const { zip = '', type = 'sale', zpid = '' } = req.query;

  const headers = {
    'X-RapidAPI-Key':  apiKey,
    'X-RapidAPI-Host': apiHost,
    'Content-Type':    'application/json',
  };

  try {
    let data;

    if (zpid) {
      // Single property detail
      const url = `https://${apiHost}/properties/v3/detail?zpid=${zpid}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`Realty API ${r.status}: ${await r.text().then(t=>t.slice(0,100))}`);
      data = await r.json();
      return res.status(200).json(transformDetail(data));
    }

    if (!zip || !/^\d{5}$/.test(zip)) {
      return res.status(400).json({ ok: false, error: 'Valid 5-digit ZIP required' });
    }

    // Property list search by ZIP
    const status = type === 'rent' ? 'forRent' : 'forSale';
    const body = {
      location: zip,
      page:     1,
      sortBy:   'Newest',
      sortOrder: 'Descending',
      pg:       1,
      resultsPerPage: 20,
      status,
    };

    const url = `https://${apiHost}/properties/v3/list`;
    const r = await fetch(url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(12000),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`Realty API ${r.status}${errText ? ': ' + errText.slice(0, 150) : ''}`);
    }

    data = await r.json();
    return res.status(200).json(transformListings(data, zip, type));

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Transform listing results into NERVA format ──
function transformListings(data, zip, type) {
  // Realty in US v3 returns results under data.home_search.results
  const results = data?.data?.home_search?.results
    || data?.data?.results
    || data?.results
    || [];

  if (!results.length) {
    return { ok: true, count: 0, zip, type, properties: [], market: null, nerva: null };
  }

  // Extract prices
  const prices = results
    .map(p => p.list_price || p.price || p.list_price_min || 0)
    .filter(p => p > 0);

  const doms = results
    .map(p => p.days_on_market || p.list_date_delta || 30)
    .filter(d => d > 0 && d < 1000);

  const cuts = results.filter(p =>
    p.price_reduced_amount > 0 || p.flags?.is_price_reduced
  ).length;

  const medPrice = median(prices);
  const medDOM   = median(doms);
  const cutRate  = results.length > 0 ? cuts / results.length : 0;

  // NERVA entropy from market dynamics
  const domEnt  = Math.min(0.85, medDOM / 90);
  const cutEnt  = Math.min(0.85, cutRate * 2);
  const entropy = Math.min(0.90, domEnt * 0.6 + cutEnt * 0.4);
  const signal  = parseFloat(((1 - entropy) * 100).toFixed(1));

  // Affordability vs national median ($400K)
  const affordIndex = Math.max(0, Math.min(100, (400000 / Math.max(medPrice, 1)) * 50));

  const nervaState = entropy < 0.25 ? 'COMMIT'
    : entropy < 0.42 ? 'HOLD'
    : entropy < 0.60 ? 'WAIT'
    : entropy < 0.75 ? 'ESCALATE'
    : 'TOXIC';

  // Market velocity signal
  const velocity = medDOM < 15 ? 'HOT — properties moving fast'
    : medDOM < 30 ? 'ACTIVE — healthy absorption'
    : medDOM < 60 ? 'BALANCED — normal market'
    : medDOM < 90 ? 'SLOW — buyer leverage building'
    : 'STALLED — significant buyer leverage';

  return {
    ok: true,
    zip,
    type,
    count: results.length,
    totalCount: data?.data?.home_search?.total_results || results.length,
    market: {
      medianPrice:     Math.round(medPrice),
      medianDOM:       Math.round(medDOM),
      priceReductions: cuts,
      cutRate:         parseFloat(cutRate.toFixed(3)),
      listingCount:    results.length,
      velocity,
      priceRange: {
        min: prices.length ? Math.min(...prices) : 0,
        max: prices.length ? Math.max(...prices) : 0,
      },
    },
    nerva: {
      entropy:    parseFloat(entropy.toFixed(4)),
      signal,
      state:      nervaState,
      affordabilityIndex: Math.round(affordIndex),
      note:       `${results.length} ${type === 'rent' ? 'rentals' : 'listings'} · median $${(medPrice/1000).toFixed(0)}K · ${Math.round(medDOM)} DOM · ${(cutRate*100).toFixed(0)}% price cuts`,
      inputs:     { domEntropy: parseFloat(domEnt.toFixed(4)), cutEntropy: parseFloat(cutEnt.toFixed(4)) },
    },
    properties: results.slice(0, 15).map(p => ({
      zpid:         p.zpid,
      address:      formatAddress(p),
      price:        p.list_price || p.price || 0,
      beds:         p.beds || p.bedroom_count,
      baths:        p.full_baths || p.bathroom_count,
      sqft:         p.sqft || p.lot_sqft,
      daysOnMarket: p.days_on_market || p.list_date_delta,
      priceReduced: p.price_reduced_amount > 0 || !!p.flags?.is_price_reduced,
      priceReducedBy: p.price_reduced_amount || 0,
      lat:          p.location?.address?.coordinate?.lat,
      lng:          p.location?.address?.coordinate?.lon,
      homeType:     p.description?.type || p.home_type,
      status:       p.status,
      imgSrc:       p.primary_photo?.href || p.photos?.[0]?.href,
      detailUrl:    p.permalink ? `https://www.realtor.com/realestateandhomes-detail/${p.permalink}` : null,
    })),
  };
}

// ── Transform single property detail ──
function transformDetail(data) {
  const p = data?.data?.home || data?.data || data;
  if (!p) return { ok: false, error: 'No property data' };

  const price      = p.list_price || p.price || 0;
  const rent       = p.estimates?.rent?.rent_estimate || 0;
  const rentYield  = price > 0 && rent > 0
    ? parseFloat((rent * 12 / price * 100).toFixed(2)) : 0;

  return {
    ok: true,
    property: {
      zpid:       p.zpid,
      address:    formatAddress(p),
      price,
      beds:       p.beds || p.description?.beds,
      baths:      p.full_baths || p.description?.baths,
      sqft:       p.sqft || p.description?.sqft,
      yearBuilt:  p.year_built || p.description?.year_built,
      homeType:   p.description?.type,
      lat:        p.location?.address?.coordinate?.lat,
      lng:        p.location?.address?.coordinate?.lon,
      daysOnMarket: p.days_on_market,
      priceReduced: p.price_reduced_amount > 0,
      priceReducedBy: p.price_reduced_amount || 0,
      estimatedRent: rent,
      floodFactor:  p.flood_factor?.flood_factor_score,
      fireFactor:   p.fire_factor?.fire_factor_score,
      taxAnnual:    p.tax_history?.[0]?.tax,
      hoaMonthly:   p.hoa_fee,
    },
    nerva: {
      rentYield,
      evGate: rentYield > 4.5,
      evNote: rentYield > 4.5
        ? `PASS — ${rentYield}% gross yield exceeds 4.5% threshold`
        : `FAIL — ${rentYield > 0 ? rentYield + '% yield below' : 'insufficient data for'} 4.5% threshold`,
      floodRisk: p.flood_factor?.flood_factor_score
        ? `${p.flood_factor.flood_factor_score}/10 flood risk`
        : 'unknown',
      fireRisk: p.fire_factor?.fire_factor_score
        ? `${p.fire_factor.fire_factor_score}/10 fire risk`
        : 'unknown',
    },
  };
}

function formatAddress(p) {
  const a = p.location?.address || p.address || {};
  if (a.line) return `${a.line}, ${a.city || ''}, ${a.state_code || ''} ${a.postal_code || ''}`.trim();
  if (p.street_address) return `${p.street_address}, ${p.city || ''}, ${p.state || ''}`.trim();
  return p.address || '—';
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
