// NERVA Globe — NOAA Weather Alert API Proxy
// Path in repo: api/noaa.js
// URL when deployed: https://nerva-globe.vercel.app/api/noaa
//
// No API key required — NOAA Weather API is fully public
// Docs: https://www.weather.gov/documentation/services-web-api
//
// What this does vs the client-side fetch:
//   1. Filters to Extreme + Severe only (signal, not noise)
//   2. Maps each alert to the nearest NERVA node automatically
//   3. Computes entropy delta per alert type
//   4. Returns structured NERVA-ready signal objects
//
// Query params:
//   ?state=FL        Filter by state (2-letter code)
//   ?severity=all    Include all severities (default: Extreme+Severe only)
//   ?limit=50        Max alerts returned (default 30)

const NOAA_BASE = 'https://api.weather.gov';

// Alert type → NERVA layer mapping + entropy weight
const ALERT_NERVA_MAP = {
  'Tornado Warning':           { layer: 'ins_storm',  entDelta: 0.18, severity: 0.9 },
  'Tornado Watch':             { layer: 'ins_storm',  entDelta: 0.10, severity: 0.6 },
  'Hurricane Warning':         { layer: 'ins_storm',  entDelta: 0.22, severity: 1.0 },
  'Hurricane Watch':           { layer: 'ins_storm',  entDelta: 0.14, severity: 0.7 },
  'Tropical Storm Warning':    { layer: 'ins_storm',  entDelta: 0.16, severity: 0.8 },
  'Flash Flood Warning':       { layer: 'ins_flood',  entDelta: 0.15, severity: 0.8 },
  'Flood Warning':             { layer: 'ins_flood',  entDelta: 0.10, severity: 0.6 },
  'Coastal Flood Warning':     { layer: 'ins_flood',  entDelta: 0.12, severity: 0.7 },
  'Blizzard Warning':          { layer: 'climate',    entDelta: 0.08, severity: 0.6 },
  'Winter Storm Warning':      { layer: 'climate',    entDelta: 0.06, severity: 0.5 },
  'Ice Storm Warning':         { layer: 'climate',    entDelta: 0.09, severity: 0.6 },
  'Extreme Cold Warning':      { layer: 'climate',    entDelta: 0.07, severity: 0.5 },
  'Excessive Heat Warning':    { layer: 'climate',    entDelta: 0.08, severity: 0.6 },
  'Red Flag Warning':          { layer: 'ins_fire',   entDelta: 0.12, severity: 0.7 },
  'Fire Weather Watch':        { layer: 'ins_fire',   entDelta: 0.08, severity: 0.5 },
  'Dust Storm Warning':        { layer: 'climate',    entDelta: 0.07, severity: 0.5 },
  'Earthquake Warning':        { layer: 'ins_quake',  entDelta: 0.20, severity: 0.9 },
  'Tsunami Warning':           { layer: 'ins_quake',  entDelta: 0.25, severity: 1.0 },
  'Severe Thunderstorm Warning':{ layer: 'ins_storm', entDelta: 0.09, severity: 0.5 },
};

// US state → NERVA node name mapping (nearest relevant node)
const STATE_TO_NODE = {
  'FL': ['Florida Hurricane', 'Tampa Metro', 'Miami Metro'],
  'TX': ['Gulf Coast Storm', 'Dallas-Fort Worth', 'Houston Metro'],
  'LA': ['Gulf Coast Storm', 'Orleans Parish, LA'],
  'MS': ['Gulf Coast Storm'],
  'AL': ['Gulf Coast Storm'],
  'GA': ['Atlanta Metro'],
  'SC': ['Gulf Coast Storm'],
  'NC': ['Charlotte Metro'],
  'VA': ['Washington DC Metro'],
  'MD': ['Washington DC Metro'],
  'DC': ['Washington DC Metro'],
  'NY': ['NYC Metro', 'Brooklyn, NY', 'Manhattan, NY'],
  'NJ': ['NYC Metro'],
  'PA': ['Philadelphia Metro'],
  'MA': ['Boston Metro'],
  'CA': ['LA Metro', 'San Francisco Metro', 'California Wildfire'],
  'OR': ['Pacific NW Quake'],
  'WA': ['Seattle Metro', 'Pacific NW Quake'],
  'IL': ['Chicago Metro', 'Cook County, IL'],
  'MI': ['Detroit Metro'],
  'MN': ['Minneapolis Metro'],
  'AZ': ['Phoenix Metro'],
  'NV': ['Las Vegas Metro'],
  'CO': ['Denver Metro'],
  'TN': ['Nashville Metro'],
  'OH': ['Cleveland / Akron'],
  'IN': ['Indianapolis'],
  'MO': ['St. Louis'],
  'OK': ['Gulf Coast Storm'],
  'KS': ['Gulf Coast Storm'],
  'NE': ['Gulf Coast Storm'],
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60'); // 5min cache

  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    state = '',
    severity = 'high', // 'high' = Extreme+Severe, 'all' = everything
    limit = '30',
  } = req.query;

  try {
    // NOAA API v3 — only supported params: area, severity, status
    let noaaUrl = `${NOAA_BASE}/alerts/active`;
    const qp = ['status=actual'];
    if (state) qp.push(`area=${state.toUpperCase()}`);
    if (severity === 'high') qp.push('severity=Extreme&severity=Severe');
    noaaUrl += '?' + qp.join('&');
    const url = new URL(noaaUrl);

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'NERVAGlobe/1.0 (nerva-globe.vercel.app; signal intelligence)',
        'Accept': 'application/geo+json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const body = await response.text().catch(()=>'');
      throw new Error(`NOAA HTTP ${response.status}: ${body.slice(0,120)}`);
    }

    const data = await response.json();
    const features = data.features || [];

    // Process each alert into NERVA signal format
    const signals = [];
    const nodeMods = {}; // node name → entropy delta accumulator

    features.forEach(f => {
      const props = f.properties || {};
      const event = props.event || '';
      const severity_lvl = props.severity || 'Unknown';
      const areas = props.areaDesc || '';
      const headline = props.headline || props.description?.slice(0, 120) || '';
      const sent = props.sent || '';
      const expires = props.expires || '';

      // Get NERVA mapping for this alert type
      const nervaMapping = getAlertMapping(event);

      // Extract affected states from area description
      const affectedStates = extractStates(areas);

      // Find affected NERVA nodes
      const affectedNodes = [];
      affectedStates.forEach(st => {
        const nodes = STATE_TO_NODE[st] || [];
        affectedNodes.push(...nodes);
      });

      // Deduplicate nodes
      const uniqueNodes = [...new Set(affectedNodes)];

      // Accumulate entropy deltas
      uniqueNodes.forEach(nodeName => {
        if (!nodeMods[nodeName]) nodeMods[nodeName] = { entDelta: 0, events: [] };
        nodeMods[nodeName].entDelta = Math.min(0.95,
          nodeMods[nodeName].entDelta + nervaMapping.entDelta
        );
        nodeMods[nodeName].events.push(event);
      });

      signals.push({
        event,
        severity: severity_lvl,
        areas: areas.slice(0, 200),
        headline: headline.slice(0, 150),
        sent,
        expires,
        nerva: {
          layer: nervaMapping.layer,
          entDelta: nervaMapping.entDelta,
          severityWeight: nervaMapping.severity,
          affectedNodes: uniqueNodes,
          note: `${event} — affects ${uniqueNodes.length > 0 ? uniqueNodes.slice(0,2).join(', ') : 'no mapped nodes'}`,
        },
      });
    });

    // Summary stats
    const byType = {};
    signals.forEach(s => {
      byType[s.event] = (byType[s.event] || 0) + 1;
    });

    const extremeCount = signals.filter(s => s.severity === 'Extreme').length;
    const severeCount = signals.filter(s => s.severity === 'Severe').length;

    // Top signal: highest entropy impact
    const topSignal = signals.reduce((best, s) =>
      s.nerva.entDelta > (best?.nerva?.entDelta || 0) ? s : best, null
    );

    return res.status(200).json({
      ok: true,
      count: signals.length,
      extreme: extremeCount,
      severe: severeCount,
      summary: `${signals.length} alerts (${extremeCount} extreme, ${severeCount} severe)`,
      topSignal: topSignal ? {
        event: topSignal.event,
        areas: topSignal.areas,
        entDelta: topSignal.nerva.entDelta,
        affectedNodes: topSignal.nerva.affectedNodes,
      } : null,
      // Node entropy modifications — apply directly to NERVA
      nodeMods,
      // Full signal list
      signals: signals.slice(0, parseInt(limit) || 30),
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}

function getAlertMapping(event) {
  // Exact match first
  if (ALERT_NERVA_MAP[event]) return ALERT_NERVA_MAP[event];

  // Fuzzy match by keyword
  const eventLower = event.toLowerCase();
  if (eventLower.includes('tornado'))  return { layer: 'ins_storm', entDelta: 0.10, severity: 0.6 };
  if (eventLower.includes('hurricane'))return { layer: 'ins_storm', entDelta: 0.18, severity: 0.8 };
  if (eventLower.includes('flood'))    return { layer: 'ins_flood', entDelta: 0.08, severity: 0.5 };
  if (eventLower.includes('fire'))     return { layer: 'ins_fire',  entDelta: 0.09, severity: 0.5 };
  if (eventLower.includes('earthquake'))return { layer: 'ins_quake',entDelta: 0.15, severity: 0.7 };
  if (eventLower.includes('tsunami'))  return { layer: 'ins_quake', entDelta: 0.22, severity: 0.9 };
  if (eventLower.includes('blizzard') || eventLower.includes('winter') || eventLower.includes('ice'))
                                       return { layer: 'climate',   entDelta: 0.06, severity: 0.4 };
  if (eventLower.includes('heat') || eventLower.includes('drought'))
                                       return { layer: 'climate',   entDelta: 0.07, severity: 0.5 };
  if (eventLower.includes('thunder') || eventLower.includes('storm'))
                                       return { layer: 'ins_storm', entDelta: 0.06, severity: 0.4 };

  // Default
  return { layer: 'climate', entDelta: 0.03, severity: 0.2 };
}

function extractStates(areaDesc) {
  // NOAA area descriptions like "Clay, AR; Boone, AR; ..."
  // Extract 2-letter state codes
  const statePattern = /\b([A-Z]{2})\b/g;
  const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR','GU','VI'
  ]);
  const found = new Set();
  let match;
  while ((match = statePattern.exec(areaDesc)) !== null) {
    if (US_STATES.has(match[1])) found.add(match[1]);
  }
  return [...found];
}
