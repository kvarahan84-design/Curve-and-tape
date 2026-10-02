// Vercel serverless function: GET /api/fred
// Proxies FRED's public CSV (no API key needed) for 2Y/10Y/20Y/30Y Treasury yields,
// trims it to the last 7 years and returns compact JSON. FRED doesn't send CORS headers,
// so browsers can't call it directly.
const IDS = ['DGS2', 'DGS10', 'DGS20', 'DGS30'];

module.exports = async (req, res) => {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 7);
  const cosd = start.toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${IDS.join(',')}&cosd=${cosd}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (curve-and-tape)' } });
    if (!r.ok) throw new Error(`FRED returned ${r.status}`);
    const body = parse(await r.text(), cosd);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

function parse(csv, start) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const out = { dates: [], fetched: new Date().toISOString() };
  IDS.forEach((id) => (out[id] = []));
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const d = cells[0];
    if (d < start) continue;
    const vals = IDS.map((id) => {
      const v = parseFloat(cells[col[id]]);
      return Number.isFinite(v) ? v : null;
    });
    if (vals.every((v) => v == null)) continue;
    out.dates.push(d);
    IDS.forEach((id, k) => out[id].push(vals[k]));
  }
  return out;
}
