// NERVA Globe — Census ACS ZIP-Level Intelligence
// Path in repo: api/census.js
// URL: https://nerva-globe.vercel.app/api/census
//
// No API key required — Census Bureau API is fully public
// Optional key for higher rate limits: api.census.gov/data/key_signup.html
//
// Query params:
//   ?zip=10001          Single ZIP code lookup
//   ?zip=10001,10002    Multiple ZIPs (comma-separated, max 10)
//   ?geo=metro          All metro areas (MSA level)
//   ?geo=state&state=FL All ZIPs in a state (slow, use sparingly)
//   ?search=Brooklyn    Search MSAs by name
//
// ACS 5-year variables used:
//   B25077_001E  Median home value
//   B19013_001E  Median household income
//   B25064_001E  Median gross rent
//   B25003_001E  Total occupied housing units
//   B25003_002E  Owner-occupied units
//   B25003_003E  Renter-occupied units
//   B01003_001E  Total population
//   B25002_002E  Occupied housing units
//   B25002_003E  Vacant housing units

const CENSUS_BASE = 'https://api.census.gov/data/2022/acs/acs5';

const VARS = [
  'NAME',
  'B25077_001E',  // Median home value
  'B19013_001E',  // Median HH income
  'B25064_001E',  // Median gross rent
  'B25003_001E',  // Total occupied units
  'B25003_002E',  // Owner-occupied
  'B25003_003E',  // Renter-occupied
  'B01003_001E',  // Population
  'B25002_002E',  // Occupied units
  'B25002_003E',  // Vacant units
].join(',');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600'); // 24hr cache — ACS is annual
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { zip, geo = '', search = '', state = '*' } = req.query;
  const apiKey = process.env.CENSUS_API_KEY || ''; // optional

  try {
    let results = [];

    if (zip) {
      // ZIP code lookup — single or multiple
      const zips = zip.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z)).slice(0, 10);
      if (!zips.length) return res.status(400).json({ ok: false, error: 'Invalid ZIP code format. Use 5-digit ZIP.' });

      // Census ZIP Code Tabulation Areas (ZCTAs)
      for (const z of zips) {
        const url = buildURL(`zip+code+tabulation+area:${z}`, null, apiKey);
        const row = await fetchCensus(url);
        if (row) results.push(parseRow(row, 'zip'));
      }

    } else if (geo === 'metro' || search) {
      // Metro area (MSA) lookup
      const url = buildURL(
        'metropolitan+statistical+area/micropolitan+statistical+area:*',
        null,
        apiKey
      );
      const rows = await fetchCensusMulti(url);
      results = rows
        .map(r => parseRow(r, 'metro'))
        .filter(Boolean)
        .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()));

      // Sort by affordability (worst first — most signal for NERVA)
      results.sort((a, b) => a.metrics.affordabilityIndex - b.metrics.affordabilityIndex);
      results = results.slice(0, 50);

    } else if (geo === 'state') {
      // County-level for a state
      const stateCode = state.length === 2 ? getStateFIPS(state.toUpperCase()) : state;
      const url = buildURL(`county:*`, `state:${stateCode}`, apiKey);
      const rows = await fetchCensusMulti(url);
      results = rows.map(r => parseRow(r, 'county')).filter(Boolean);
      results.sort((a, b) => a.metrics.affordabilityIndex - b.metrics.affordabilityIndex);

    } else {
      return res.status(400).json({
        ok: false,
        error: 'Provide ?zip=XXXXX, ?geo=metro, or ?search=CityName',
        examples: [
          '/api/census?zip=10001',
          '/api/census?zip=10001,90210,33101',
          '/api/census?geo=metro&search=Miami',
          '/api/census?geo=state&state=FL',
        ],
      });
    }

    // Filter out invalid results
    results = results.filter(r => r !== null);

    return res.status(200).json({
      ok: true,
      count: results.length,
      dataYear: 2022,
      source: 'Census ACS 5-Year',
      results,
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function buildURL(forGeo, inGeo, apiKey) {
  let url = `${CENSUS_BASE}?get=${VARS}&for=${forGeo}`;
  if (inGeo) url += `&in=${inGeo}`;
  if (apiKey) url += `&key=${apiKey}`;
  return url;
}

async function fetchCensus(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NERVAGlobe/1.0 (nerva-globe.vercel.app)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Census API ${res.status}`);
  const data = await res.json();
  if (!data || data.length < 2) return null;
  // data[0] = headers, data[1] = first result
  const headers = data[0];
  return Object.fromEntries(headers.map((h, i) => [h, data[1][i]]));
}

async function fetchCensusMulti(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NERVAGlobe/1.0 (nerva-globe.vercel.app)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Census API ${res.status}`);
  const data = await res.json();
  if (!data || data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
}

function parseRow(row, geoType) {
  if (!row) return null;

  const medianHomeValue = parseInt(row.B25077_001E) || 0;
  const medianIncome    = parseInt(row.B19013_001E) || 0;
  const medianRent      = parseInt(row.B25064_001E) || 0;
  const totalUnits      = parseInt(row.B25003_001E) || 1;
  const ownerUnits      = parseInt(row.B25003_002E) || 0;
  const renterUnits     = parseInt(row.B25003_003E) || 0;
  const population      = parseInt(row.B01003_001E) || 0;
  const vacantUnits     = parseInt(row.B25002_003E) || 0;
  const occupiedUnits   = parseInt(row.B25002_002E) || 1;

  // Skip clearly invalid data
  if (medianHomeValue <= 0 && medianIncome <= 0) return null;

  // Core metrics
  const priceToIncome  = medianIncome > 0 ? medianHomeValue / medianIncome : 0;
  const rentToIncome   = medianIncome > 0 ? (medianRent * 12) / medianIncome : 0;
  const ownershipRate  = ownerUnits / Math.max(totalUnits, 1);
  const vacancyRate    = vacantUnits / Math.max(occupiedUnits + vacantUnits, 1);
  const rentYieldEst   = medianHomeValue > 0 ? (medianRent * 12) / medianHomeValue * 100 : 0;

  // Affordability index: 100 = perfectly affordable (3x income)
  // 50 = stressed (6x), 25 = severe (12x), 0 = impossible
  const affordIndex = medianHomeValue > 0 && medianIncome > 0
    ? Math.max(0, Math.min(100, (3 / priceToIncome) * 100))
    : 50;

  // EV gate: passes if rent yield > 4.5% (property generates positive cash flow)
  const evGate = rentYieldEst > 4.5;

  // NERVA entropy: high P/I ratio = high entropy (unresolvable decision surface)
  // P/I < 3 → entropy 0.15 (COMMIT territory)
  // P/I 3-5 → entropy 0.30-0.45 (HOLD)
  // P/I 5-8 → entropy 0.45-0.65 (WAIT/ESCALATE)
  // P/I > 8 → entropy 0.65-0.90 (ESCALATE/TOXIC)
  const entropy = medianHomeValue > 0
    ? Math.min(0.92, Math.max(0.10, (priceToIncome - 1) / 12))
    : 0.50;

  // Rent burden adds entropy
  const rentBurdenDelta = rentToIncome > 0.40 ? 0.08 : rentToIncome > 0.30 ? 0.04 : 0;
  const finalEntropy = Math.min(0.92, entropy + rentBurdenDelta);

  // Vacancy adds entropy (oversupply risk or abandonment)
  const vacancyDelta = vacancyRate > 0.15 ? 0.05 : 0;

  const totalEntropy = Math.min(0.92, finalEntropy + vacancyDelta);
  const coherence = 1 - totalEntropy;

  // NERVA state
  const nervaState = affordIndex > 72 ? 'COMMIT'
    : affordIndex > 55 ? 'HOLD'
    : affordIndex > 38 ? 'WAIT'
    : affordIndex > 22 ? 'ESCALATE'
    : 'TOXIC';

  // Signal strength (inverse of entropy, scaled)
  const signal = parseFloat(((1 - totalEntropy) * 100).toFixed(1));

  // Why Now bullets
  const why = [];
  if (priceToIncome > 8)  why.push(`Price/income ratio ${priceToIncome.toFixed(1)}x — severe affordability stress`);
  if (priceToIncome < 3)  why.push(`Price/income ratio ${priceToIncome.toFixed(1)}x — historically affordable entry`);
  if (rentToIncome > 0.40) why.push(`Rent burden ${(rentToIncome*100).toFixed(0)}% of income — above 40% stress threshold`);
  if (evGate)             why.push(`Rent yield ${rentYieldEst.toFixed(1)}% — positive cash flow territory`);
  if (!evGate && rentYieldEst > 0) why.push(`Rent yield ${rentYieldEst.toFixed(1)}% — below 4.5% EV threshold`);
  if (vacancyRate > 0.15) why.push(`Vacancy rate ${(vacancyRate*100).toFixed(0)}% — oversupply or population decline signal`);
  if (ownershipRate > 0.75) why.push(`${(ownershipRate*100).toFixed(0)}% owner-occupied — stable demand, low rental supply`);

  // Buy/Hold/Sell action
  const action = nervaState === 'COMMIT' ? `BUY — Strong fundamentals. P/I ${priceToIncome.toFixed(1)}x, yield ${rentYieldEst.toFixed(1)}%.`
    : nervaState === 'HOLD' ? `HOLD — Monitor for entry. Watch rates and inventory.`
    : nervaState === 'WAIT' ? `WAIT — Insufficient clarity. Two-way risk at current prices.`
    : nervaState === 'ESCALATE' ? `CAUTION — Affordability stress building. Position defensively.`
    : `AVOID — P/I ${priceToIncome.toFixed(1)}x unsustainable. Insurance/rent math broken.`;

  // Geographic ID
  const geoId = row['zip+code+tabulation+area'] || row['metropolitan+statistical+area/micropolitan+statistical+area'] || row.state || '';

  return {
    name: row.NAME || `ZIP ${geoId}`,
    geoType,
    geoId,
    zip: row['zip+code+tabulation+area'] || null,
    population,
    raw: {
      medianHomeValue,
      medianIncome,
      medianRent,
      ownerUnits,
      renterUnits,
      vacantUnits,
    },
    formatted: {
      homeValue: medianHomeValue > 0 ? `$${(medianHomeValue/1000).toFixed(0)}K` : 'N/A',
      income:    medianIncome > 0    ? `$${(medianIncome/1000).toFixed(0)}K`    : 'N/A',
      rent:      medianRent > 0      ? `$${medianRent.toLocaleString()}/mo`     : 'N/A',
      rentYield: rentYieldEst > 0    ? `${rentYieldEst.toFixed(1)}%`           : 'N/A',
    },
    metrics: {
      priceToIncome:     parseFloat(priceToIncome.toFixed(2)),
      rentToIncome:      parseFloat(rentToIncome.toFixed(3)),
      ownershipRate:     parseFloat(ownershipRate.toFixed(3)),
      vacancyRate:       parseFloat(vacancyRate.toFixed(3)),
      affordabilityIndex: Math.round(affordIndex),
    },
    nerva: {
      entropy:    parseFloat(totalEntropy.toFixed(4)),
      coherence:  parseFloat(coherence.toFixed(4)),
      signal,
      state:      nervaState,
      evGate,
      action,
      why,
    },
  };
}

// US State name → FIPS code
function getStateFIPS(abbrev) {
  const map = {
    AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',FL:'12',
    GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',
    ME:'23',MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',
    NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',
    OR:'41',PA:'42',RI:'44',SC:'45',SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',
    VA:'51',WA:'53',WV:'54',WI:'55',WY:'56',DC:'11',
  };
  return map[abbrev] || abbrev;
}
