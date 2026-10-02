// Vercel serverless function: GET /api/cnbc
// Relays CNBC's quote and bar feeds, which browsers can't call directly (CORS).
//   ?type=quote&syms=US2Y,US10Y
//   ?type=bars&sym=US10Y&api=5M&from=20261001000000&to=20261002235959
const SYM = /^[A-Z0-9.]{1,12}$/;
const STAMP = /^\d{14}$/;
const BAR_SIZES = new Set(['1M', '5M', '30M', '1H', '1D', '1W', '1MO']);

module.exports = async (req, res) => {
  const q = req.query || {};
  let url;
  if (q.type === 'quote') {
    const syms = String(q.syms || '').split(',').filter((s) => SYM.test(s)).slice(0, 20);
    if (!syms.length) return res.status(400).json({ error: 'syms required' });
    url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${syms.join('%7C')}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
  } else if (q.type === 'bars') {
    if (!SYM.test(q.sym || '') || !BAR_SIZES.has(q.api) || !STAMP.test(q.from || '') || !STAMP.test(q.to || '')) {
      return res.status(400).json({ error: 'bad bars request' });
    }
    url = `https://ts-api.cnbc.com/harmony/app/bars/${q.sym}/${q.api}/${q.from}/${q.to}/adjusted/EST5EDT.json`;
  } else {
    return res.status(400).json({ error: 'type must be quote or bars' });
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (curve-and-tape)' } });
    if (!r.ok) throw new Error(`CNBC returned ${r.status}`);
    res.setHeader('Cache-Control', `s-maxage=${q.type === 'quote' ? 10 : 20}, stale-while-revalidate=60`);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
