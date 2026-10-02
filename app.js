/* Curve & Tape: yields vs equities dashboard.
   Yields + correlation prices: CNBC's quote/bar feed (Tradeweb yields, live, unofficial), relayed by /api/cnbc.
   Fallbacks: FRED daily yields via /api/fred, then labelled sample data. Charts: Lightweight Charts. */
(() => {
  'use strict';

  const YIELDS = [
    { id: 'US2Y', label: '2Y', fred: 'DGS2' },
    { id: 'US10Y', label: '10Y', fred: 'DGS10' },
    { id: 'US20Y', label: '20Y', fred: 'DGS20' },
    { id: 'US30Y', label: '30Y', fred: 'DGS30' },
  ];
  const EQUITIES = [
    { id: 'SPY', name: 'S&P 500' },
    { id: 'QQQ', name: 'Nasdaq 100' },
    { id: 'DIA', name: 'Dow Jones' },
    { id: 'IWM', name: 'Russell 2000' },
  ];
  const SYMS = [...YIELDS.map((y) => y.id), ...EQUITIES.map((e) => e.id)];

  // Chart interval → CNBC bar size. 15m and 4h aren't offered, so they're built from 5m and 1h bars.
  const INTERVALS = [
    { v: '1', label: '1m', api: '1M', days: 3, bucket: 0 },
    { v: '5', label: '5m', api: '5M', days: 12, bucket: 0 },
    { v: '15', label: '15m', api: '5M', days: 30, bucket: 15 },
    { v: '60', label: '1h', api: '1H', days: 120, bucket: 0 },
    { v: '240', label: '4h', api: '1H', days: 365, bucket: 240 },
    { v: 'D', label: '1D', api: '1D', days: 365 * 3 },
    { v: 'W', label: '1W', api: '1W', days: 365 * 12 },
    { v: 'M', label: '1M', api: '1MO', days: 365 * 25 },
    { v: '12M', label: '1Y', api: '1MO', days: 365 * 40, year: true },
  ];
  const ivCfg = (v) => INTERVALS.find((i) => i.v === v) || INTERVALS[5];
  const isIntraday = (v) => !['D', 'W', 'M', '12M'].includes(v);

  const WINDOWS = { H: [35, 70, 140], D: [20, 60, 120, 250], W: [13, 26, 52, 104], M: [12, 24, 36] };
  const DEFAULT_WINDOW = { H: 70, D: 60, W: 26, M: 24 };
  const FREQ_NAME = { H: 'hour', D: 'day', W: 'week', M: 'month' };
  const FREQ_ADJ = { H: 'hourly', D: 'daily', W: 'weekly', M: 'monthly' };
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const state = Object.assign(
    { interval: 'D', yield: 'US10Y', equity: 'SPY', freq: 'D', window: 60 },
    store.get('ct_state2', {})
  );
  if (!YIELDS.some((y) => y.id === state.yield)) state.yield = 'US10Y';
  if (!WINDOWS[state.freq]) state.freq = 'D';
  const saveState = () => store.set('ct_state2', { interval: state.interval, yield: state.yield, equity: state.equity, freq: state.freq, window: state.window });

  const datasets = {};  // 'D' | 'H' → { series: { SYM: Map(time → close) }, ySource, eSource }
  let quotes = {};      // SYM → { last, prev, time }
  let changes = [];     // [{ d, dy:[4], r:[4] }]

  /* ---------- CNBC feed ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const dayKey = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  // Bars arrive in New York wall time; encode them as UTC so the chart axis shows NY time.
  const secKey = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12)) / 1000;

  const barCache = new Map();
  function getBars(sym, api, days, ttl = 25000) {
    const key = `${sym}|${api}|${days}`;
    const hit = barCache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.p;
    const to = new Date(Date.now() + 86400000), from = new Date(Date.now() - days * 86400000);
    const url = `/api/cnbc?type=bars&sym=${sym}&api=${api}&from=${ymd(from)}000000&to=${ymd(to)}235959`;
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`feed returned ${r.status}`); return r.json(); })
      .then((j) => {
        const bars = j && j.barData && j.barData.priceBars;
        if (!Array.isArray(bars) || !bars.length) throw new Error(`no ${sym} data`);
        return bars.map((b) => ({ ts: b.tradeTime, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
          .filter((b) => Number.isFinite(b.c) && Number.isFinite(b.o));
      });
    p.catch(() => barCache.delete(key));
    barCache.set(key, { t: Date.now(), p });
    return p;
  }

  async function getQuotes(syms) {
    const url = `/api/cnbc?type=quote&syms=${syms.join(',')}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`quotes returned ${r.status}`);
    const j = await r.json();
    const out = {};
    for (const q of (j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote) || []) {
      const last = parseFloat(q.last), prev = parseFloat(q.previous_day_closing);
      if (Number.isFinite(last)) {
        out[q.symbol] = {
          last, prev, open: parseFloat(q.open), high: parseFloat(q.high), low: parseFloat(q.low),
          date: String(q.last_time || '').slice(0, 10), time: q.last_timedate || '',
        };
      }
    }
    return out;
  }

  /* ---------- Yield candle chart ---------- */
  const LWC = window.LightweightCharts;
  const chartOpts = {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8492ab', fontFamily: 'IBM Plex Mono, Consolas, monospace', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(132,146,171,0.06)' }, horzLines: { color: 'rgba(132,146,171,0.08)' } },
    rightPriceScale: { borderColor: '#22304b' },
    timeScale: { borderColor: '#22304b' },
    crosshair: { mode: 0 },
  };

  function toCandles(bars, cfg) {
    let out;
    if (cfg.bucket) {
      out = [];
      let cur = null;
      for (const b of bars) {
        const mins = +b.ts.slice(8, 10) * 60 + +b.ts.slice(10, 12);
        const k = b.ts.slice(0, 8) + '|' + Math.floor(mins / cfg.bucket);
        if (!cur || cur.k !== k) {
          if (cur) out.push(cur);
          const start = Math.floor(mins / cfg.bucket) * cfg.bucket;
          const ts = b.ts.slice(0, 8) + pad(Math.floor(start / 60)) + pad(start % 60) + '00';
          cur = { k, time: secKey(ts), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
        } else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
      }
      if (cur) out.push(cur);
    } else if (cfg.year) {
      out = [];
      let cur = null;
      for (const b of bars) {
        const k = b.ts.slice(0, 4);
        if (!cur || cur.k !== k) {
          if (cur) out.push(cur);
          cur = { k, time: `${k}-01-01`, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v };
        } else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
      }
      if (cur) out.push(cur);
    } else {
      const intraday = isIntraday(cfg.v);
      out = bars.map((b) => ({ time: intraday ? secKey(b.ts) : dayKey(b.ts), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    }
    const clean = [];
    for (const c of out) {
      const bar = { time: c.time, open: c.open, high: Math.max(c.high, c.open, c.close), low: Math.min(c.low, c.open, c.close), close: c.close, volume: c.volume || 0 };
      if (!clean.length || bar.time > clean[clean.length - 1].time) clean.push(bar);
      else clean[clean.length - 1] = bar;
    }
    return clean;
  }

  // Two candle panels (yields left, equities right) share the interval, crosshair and visible time range.
  const panels = {
    yield: {
      host: 'yield-lwc', tag: 'yield-tag', sym: () => state.yield, volume: false,
      format: (v) => v.toFixed(3) + '%', minMove: 0.001,
      name: (s) => `${YIELDS.find((y) => y.id === s).label} Treasury`,
      change: (b) => { const ch = (b.close - b.open) * 100; return [ch, `${fmt(ch, 1)} bp`]; },
      source: 'Tradeweb via CNBC',
    },
    equity: {
      host: 'equity-lwc', tag: 'equity-tag', sym: () => state.equity, volume: true,
      format: (v) => v.toFixed(2), minMove: 0.01,
      name: (s) => `${s} · ${EQUITIES.find((e) => e.id === s).name}`,
      change: (b) => { const ch = (b.close / b.open - 1) * 100; return [ch, `${fmt(ch, 2)}%`]; },
      source: 'real-time via CNBC',
    },
  };
  let syncing = false;

  function ensurePanel(p) {
    if (p.chart || !LWC) return;
    p.chart = LWC.createChart($(p.host), Object.assign({}, chartOpts, {
      rightPriceScale: { borderColor: '#22304b', scaleMargins: { top: 0.18, bottom: p.volume ? 0.24 : 0.08 } },
      crosshair: { mode: 1 },
    }));
    p.series = p.chart.addCandlestickSeries({
      upColor: '#3fb68b', downColor: '#e56a5c', borderVisible: false, wickUpColor: '#3fb68b', wickDownColor: '#e56a5c',
      priceFormat: { type: 'custom', minMove: p.minMove, formatter: p.format },
    });
    if (p.volume) {
      p.vol = p.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      p.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    p.req = 0;
    p.chart.subscribeCrosshairMove((e) => {
      const bar = e && e.time ? e.seriesData.get(p.series) : null;
      updateTag(p, bar);
      if (syncing) return;
      const other = p === panels.yield ? panels.equity : panels.yield;
      if (!other.chart || !other.data) return;
      syncing = true;
      const ob = e && e.time ? nearestBar(other.data, e.time) : null;
      if (ob) { other.chart.setCrosshairPosition(ob.close, ob.time, other.series); updateTag(other, ob); }
      else { other.chart.clearCrosshairPosition(); updateTag(other, null); }
      syncing = false;
    });
    p.chart.timeScale().subscribeVisibleTimeRangeChange((r) => {
      if (syncing || !r) return;
      const other = p === panels.yield ? panels.equity : panels.yield;
      if (!other.chart || !other.data || !other.data.length) return;
      syncing = true;
      try { other.chart.timeScale().setVisibleRange(r); } catch { /* range outside the other chart's data */ }
      syncing = false;
    });
  }

  function nearestBar(data, t) {
    let lo = 0, hi = data.length - 1;
    if (hi < 0 || t < data[0].time) return null;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (data[mid].time <= t) lo = mid; else hi = mid - 1; }
    return data[lo];
  }

  async function renderPanel(p, refit = true) {
    ensurePanel(p);
    if (!p.chart) return;
    const sym = p.sym();
    const cfg = ivCfg(state.interval);
    const my = ++p.req;
    if (refit) { p.series.setData([]); if (p.vol) p.vol.setData([]); p.data = null; p.last = null; $(p.tag).innerHTML = `<span>Loading ${p.name(sym)}…</span>`; }
    p.chart.applyOptions({ timeScale: { timeVisible: isIntraday(cfg.v), secondsVisible: false } });
    let data, from;
    try {
      data = withLiveQuote(toCandles(await getBars(sym, cfg.api, cfg.days), cfg), quotes[sym], cfg);
      from = 'live';
    } catch (e) {
      console.warn(`Live ${sym} bars failed:`, e.message);
      const ds = datasets.D;
      if (p !== panels.yield || isIntraday(cfg.v) || !ds || ds.ySource !== 'fred') {
        if (my === p.req) $(p.tag).innerHTML = `<b>Couldn't load ${p.name(sym)}</b><span>The live feed didn't respond (${e.message}). It retries every 30 seconds.</span>`;
        return;
      }
      data = closesToCandles(ds.series[sym], cfg);
      from = 'fallback';
    }
    if (my !== p.req) return;
    syncing = true;
    p.series.setData(data);
    if (p.vol) p.vol.setData(data.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(63,182,139,0.35)' : 'rgba(229,106,92,0.35)' })));
    syncing = false;
    p.data = data;
    p.last = data[data.length - 1];
    p.from = from;
    if (refit) {
      p.chart.timeScale().fitContent();
      if (data.length > 240) p.chart.timeScale().setVisibleLogicalRange({ from: data.length - 240, to: data.length + 4 });
    }
    updateTag(p, null);
  }
  const renderYieldChart = (refit) => renderPanel(panels.yield, refit);
  const renderEquityChart = (refit) => renderPanel(panels.equity, refit);

  // Daily-and-up bars only include today after the close, so extend them with the live quote.
  function withLiveQuote(data, q, cfg) {
    if (!q || !data.length || isIntraday(cfg.v) || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return data;
    const last = data[data.length - 1];
    const hi = Math.max(Number.isFinite(q.high) ? q.high : q.last, q.last);
    const lo = Math.min(Number.isFinite(q.low) ? q.low : q.last, q.last);
    if (cfg.v === 'D' && q.date > last.time) {
      data.push({ time: q.date, open: Number.isFinite(q.open) ? q.open : last.close, high: hi, low: lo, close: q.last });
    } else if (cfg.v === 'D' && q.date === last.time) {
      Object.assign(last, { high: Math.max(last.high, hi), low: Math.min(last.low, lo), close: q.last });
    } else if (cfg.v !== 'D' && q.date >= last.time) {
      Object.assign(last, { high: Math.max(last.high, q.last), low: Math.min(last.low, q.last), close: q.last });
    }
    return data;
  }

  // Fallback when only daily closes exist (FRED): candles run close-to-close.
  function closesToCandles(map, cfg) {
    const key = (d) => (cfg.v === 'D' ? d : cfg.v === 'W' ? periodKey(d, 'W') : cfg.v === 'M' ? d.slice(0, 7) : d.slice(0, 4));
    const out = [];
    let prev = null, cur = null;
    for (const [d, v] of map) {
      const k = key(d);
      if (!cur || cur.k !== k) {
        if (cur) { out.push(cur); prev = cur.close; }
        const open = prev == null ? v : prev;
        cur = { k, time: d, open, high: Math.max(open, v), low: Math.min(open, v), close: v };
      } else { cur.high = Math.max(cur.high, v); cur.low = Math.min(cur.low, v); cur.close = v; }
    }
    if (cur) out.push(cur);
    return out.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  }

  const fmtTime = (t) => (typeof t === 'number' ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : t);
  function updateTag(p, bar) {
    const b = bar || p.last;
    if (!b) return;
    const sym = p.sym();
    const [ch, chTxt] = p.change(b);
    const cfg = ivCfg(state.interval);
    const q = quotes[sym];
    const live = !bar && p.from === 'live' && q ? ` · last trade ${q.time}` : '';
    const src = p.from === 'live' ? p.source : 'FRED daily closes (live feed unavailable)';
    $(p.tag).innerHTML =
      `<b>${p.name(sym)} · ${p.format(b.close)} <span class="${cls(ch, 0.001)}">${chTxt}</span></b>` +
      `<span>${fmtTime(b.time)} · ${cfg.label} candles · ${src}${live}</span>`;
  }

  /* ---------- Controls ---------- */
  function buildIntervalControl() {
    const seg = $('interval');
    seg.innerHTML = '';
    for (const iv of INTERVALS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = iv.label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(iv.v === state.interval));
      b.addEventListener('click', () => {
        if (state.interval === iv.v) return;
        state.interval = iv.v;
        saveState();
        buildIntervalControl();
        renderYieldChart();
        renderEquityChart();
      });
      seg.appendChild(b);
    }
  }

  function buildTabs() {
    const make = (el, items, key, label, onPick) => {
      el.innerHTML = '';
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.textContent = label(it);
        b.title = it.name || `${it.label} Treasury`;
        b.setAttribute('aria-selected', String(state[key] === it.id));
        b.addEventListener('click', () => onPick(it.id));
        el.appendChild(b);
      }
    };
    make($('yield-tabs'), YIELDS, 'yield', (y) => y.label, (id) => selectPair(id, state.equity));
    make($('equity-tabs'), EQUITIES, 'equity', (e) => e.id, (id) => selectPair(state.yield, id));
  }

  function selectPair(yId, eId) {
    const yChanged = yId !== state.yield, eChanged = eId !== state.equity;
    state.yield = yId;
    state.equity = eId;
    saveState();
    buildTabs();
    if (yChanged) renderYieldChart();
    if (eChanged) renderEquityChart();
    renderHeatmap();
    renderPair();
  }

  function buildWindowSelect() {
    const sel = $('window');
    const opts = WINDOWS[state.freq];
    if (!opts.includes(state.window)) state.window = DEFAULT_WINDOW[state.freq];
    sel.innerHTML = opts.map((n) => `<option value="${n}">${n} ${FREQ_NAME[state.freq]}s</option>`).join('');
    sel.value = String(state.window);
  }

  function updateSubtitle() {
    let s = `Correlation of ${FREQ_ADJ[state.freq]} yield changes (bp) with index returns (%), last ${state.window} ${FREQ_NAME[state.freq]}s.`;
    if (state.freq === 'H') s += ' Hourly uses the last 90 days, including extended-hours equity trading.';
    $('corr-sub').textContent = s;
  }

  /* ---------- Correlation datasets ---------- */
  async function loadDataset(base) {
    const api = base === 'H' ? '1H' : '1D';
    const days = base === 'H' ? 90 : 365 * 7;
    const res = await Promise.allSettled(SYMS.map((s) => getBars(s, api, days, 10 * 60000)));
    const series = {};
    const toMap = (bars) => new Map(bars.map((b) => [base === 'H' ? secKey(b.ts) : dayKey(b.ts), b.c]));
    SYMS.forEach((s, i) => { if (res[i].status === 'fulfilled') series[s] = toMap(res[i].value); });

    let ySource = YIELDS.every((y) => series[y.id]) ? 'live' : null;
    let eSource = EQUITIES.every((e) => series[e.id]) ? 'live' : null;
    if (base === 'H') return ySource && eSource ? { series, ySource, eSource } : null;

    if (!ySource) {
      try {
        const r = await fetch('/api/fred');
        if (!r.ok) throw new Error(`proxy returned ${r.status}`);
        const j = await r.json();
        YIELDS.forEach((y) => {
          const m = new Map();
          j.dates.forEach((d, i) => { if (j[y.fred][i] != null) m.set(d, j[y.fred][i]); });
          series[y.id] = m;
        });
        ySource = 'fred';
      } catch (e) {
        console.warn('FRED fallback failed:', e.message);
        const smp = sampleData();
        YIELDS.forEach((y) => { series[y.id] = smp[y.id]; });
        ySource = 'sample';
      }
    }
    if (!eSource) {
      const smp = sampleData();
      EQUITIES.forEach((e) => { series[e.id] = smp[e.id]; });
      eSource = 'sample';
    }
    return { series, ySource, eSource };
  }

  function sampleData() {
    if (sampleData.cache) return sampleData.cache;
    let seed = 20261002;
    const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
    const dates = [];
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - 1);
    while (dates.length < 1600) { const wd = d.getUTCDay(); if (wd && wd < 6) dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
    dates.reverse();
    const out = {};
    SYMS.forEach((s) => { out[s] = new Map(); });
    let lv = [1.6, 1.9, 2.3, 2.4], px = [330, 270, 290, 165];
    dates.forEach((day, i) => {
      const level = gauss() * 5.5, slope = gauss() * 2.4;
      const dys = [level * 1.15 - slope, level, level * 0.92 + slope * 0.6, level * 0.88 + slope * 0.8];
      lv = lv.map((v, k) => Math.max(0.1, v + dys[k] / 100));
      const rho = 0.55 * Math.sin(i / 170) - 0.05;
      const mkt = 0.04 + 0.95 * (rho * (level / 5.5) + Math.sqrt(1 - rho * rho) * gauss());
      px = px.map((p, k) => p * Math.exp((mkt * [1, 1.25, 0.9, 1.3][k] + gauss() * 0.35) / 100));
      YIELDS.forEach((y, k) => out[y.id].set(day, +lv[k].toFixed(3)));
      EQUITIES.forEach((e, k) => out[e.id].set(day, +px[k].toFixed(2)));
    });
    return (sampleData.cache = out);
  }

  function periodKey(d, freq) {
    if (freq === 'M') return d.slice(0, 7);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  }

  function computeChanges() {
    const ds = datasets[state.freq === 'H' ? 'H' : 'D'];
    changes = [];
    if (!ds) return;
    const ys = YIELDS.map((y) => ds.series[y.id]);
    const ps = EQUITIES.map((e) => ds.series[e.id]);
    let rows = [];
    for (const k of ys[0].keys()) {
      const yv = ys.map((m) => m.get(k));
      const pv = ps.map((m) => m.get(k));
      if (yv.some((v) => v == null) || pv.some((v) => v == null)) continue;
      rows.push({ d: k, ys: yv, ps: pv });
    }
    rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (state.freq === 'W' || state.freq === 'M') {
      const last = new Map();
      for (const r of rows) last.set(periodKey(r.d, state.freq), r);
      rows = [...last.values()];
    }
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      changes.push({ d: b.d, dy: b.ys.map((v, k) => (v - a.ys[k]) * 100), r: b.ps.map((v, k) => Math.log(v / a.ps[k]) * 100) });
    }
  }

  function corr(x, y) {
    const n = x.length;
    if (n < 3) return NaN;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
  function beta(dy, r) {
    const n = dy.length;
    if (n < 3) return NaN;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += dy[i]; my += r[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (dy[i] - mx) * (r[i] - my); sxx += (dy[i] - mx) ** 2; }
    return sxx ? (sxy / sxx) * 10 : NaN;
  }
  const slice = (from, to, yi, ei) => {
    if (to - Math.max(0, from) < 3 || from < 0) return [[], []];
    const s = changes.slice(from, to);
    return [s.map((c) => c.dy[yi]), s.map((c) => c.r[ei])];
  };

  /* ---------- Rendering ---------- */
  const fmt = (v, dp = 2, sign = true) => (Number.isFinite(v) ? (sign && v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp) : '–');
  const cls = (v, eps = 0.0001) => (!Number.isFinite(v) || Math.abs(v) < eps ? 'flat' : v > 0 ? 'up' : 'down');

  function renderKPIs() {
    const ds = datasets.D;
    if (!ds) return;
    const hist = (id) => [...ds.series[id].entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-120).map((e) => e[1]);
    const now = (id) => {
      const h = hist(id);
      const q = quotes[id];
      if (q) return { v: q.last, prev: Number.isFinite(q.prev) ? q.prev : h[h.length - 2], note: q.time, spark: [...h, q.last] };
      return { v: h[h.length - 1], prev: h[h.length - 2], note: [...ds.series[id].keys()].pop(), spark: h };
    };
    const vals = Object.fromEntries(YIELDS.map((y) => [y.id, now(y.id)]));
    const tiles = YIELDS.map((y) => {
      const n = vals[y.id], ch = (n.v - n.prev) * 100;
      return { label: y.label, note: n.note, val: n.v.toFixed(3) + '%', chg: ch, chgTxt: `${fmt(ch, 1)} bp`, spark: n.spark, color: '#e0a943' };
    });
    const spread = (a, b, label) => {
      const A = vals[a], B = vals[b];
      const v = (B.v - A.v) * 100, ch = v - (B.prev - A.prev) * 100;
      const len = Math.min(A.spark.length, B.spark.length);
      const s = Array.from({ length: len }, (_, i) => (B.spark[B.spark.length - len + i] - A.spark[A.spark.length - len + i]) * 100);
      return { label, note: v < 0 ? 'inverted' : 'normal', val: `${fmt(v, 1)} bp`, chg: ch, chgTxt: `${fmt(ch, 1)} bp`, spark: s, color: '#4fc3d4', spread: true };
    };
    tiles.push(spread('US2Y', 'US10Y', '2s10s'), spread('US10Y', 'US30Y', '10s30s'));

    const box = $('kpis');
    box.innerHTML = '';
    for (const t of tiles) {
      const el = document.createElement('div');
      el.className = 'kpi' + (t.spread ? ' spread' : '');
      el.innerHTML = `<div class="lbl"><span>${t.label}</span><em>${t.note || ''}</em></div>
        <div class="val">${t.val}</div><div class="chg ${cls(t.chg, 0.05)}">${t.chgTxt}</div><canvas></canvas>`;
      box.appendChild(el);
      drawSpark(el.querySelector('canvas'), t.spark, t.color);
    }
  }

  function drawSpark(cv, data, color) {
    data = data.filter(Number.isFinite);
    if (data.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 160, h = cv.clientHeight || 28;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
    const x = (i) => (i / (data.length - 1)) * (w - 4) + 1;
    const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
    ctx.beginPath();
    data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.lineTo(x(data.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(x(data.length - 1), y(data[data.length - 1]), 2.2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }

  function heatColor(c) {
    if (!Number.isFinite(c)) return 'var(--cell)';
    const pct = Math.round(Math.min(1, Math.abs(c)) * 85);
    return `color-mix(in oklab, var(${c >= 0 ? '--pos' : '--neg'}) ${pct}%, var(--cell))`;
  }

  function renderHeatmap() {
    const N = state.window, L = changes.length;
    const heat = $('heat');
    heat.innerHTML = '<div></div>' + EQUITIES.map((e) => `<div class="hdr col" title="${e.name}">${e.id}</div>`).join('');
    YIELDS.forEach((t, yi) => {
      const rh = document.createElement('div');
      rh.className = 'hdr row';
      rh.textContent = t.label;
      heat.appendChild(rh);
      EQUITIES.forEach((e, ei) => {
        const c = corr(...slice(L - N, L, yi, ei));
        const p = corr(...slice(L - 2 * N, L - N, yi, ei));
        const d = c - p;
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = heatColor(c);
        if (t.id === state.yield && e.id === state.equity) b.classList.add('sel');
        b.title = `${t.label} vs ${e.id}: ${fmt(c)} (was ${fmt(p)} one window earlier)`;
        b.innerHTML = `${fmt(c)}<small>${Number.isFinite(d) ? (d >= 0 ? '▲' : '▼') + Math.abs(d).toFixed(2) : ''}</small>`;
        b.addEventListener('click', () => selectPair(t.id, e.id));
        heat.appendChild(b);
      });
    });
    const s = changes[Math.max(0, L - N)], last = changes[L - 1];
    $('heat-range').textContent = s && last ? `${fmtTime(s.d)} → ${fmtTime(last.d)}` : 'loading…';
  }

  let rollChart = null, rollSeries = null, spreadChart = null, spreadA = null, spreadB = null;
  function ensureCharts() {
    if (!LWC) return false;
    if (!rollChart) {
      rollChart = LWC.createChart($('rolling-chart'), chartOpts);
      rollSeries = rollChart.addBaselineSeries({
        baseValue: { type: 'price', price: 0 },
        topLineColor: '#5b8cf0', topFillColor1: 'rgba(91,140,240,0.35)', topFillColor2: 'rgba(91,140,240,0.02)',
        bottomLineColor: '#e56a5c', bottomFillColor1: 'rgba(229,106,92,0.02)', bottomFillColor2: 'rgba(229,106,92,0.35)',
        lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        autoscaleInfoProvider: () => ({ priceRange: { minValue: -1, maxValue: 1 } }),
      });
      rollSeries.createPriceLine({ price: 0, color: '#8492ab', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    }
    if (!spreadChart) {
      spreadChart = LWC.createChart($('spread-chart'), chartOpts);
      spreadA = spreadChart.addLineSeries({ color: '#e0a943', lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
      spreadB = spreadChart.addLineSeries({ color: '#4fc3d4', lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
      spreadA.createPriceLine({ price: 0, color: '#8492ab', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
    }
    return true;
  }

  function renderPair() {
    const yi = YIELDS.findIndex((t) => t.id === state.yield);
    const ei = EQUITIES.findIndex((e) => e.id === state.equity);
    const N = state.window, L = changes.length;
    const yl = YIELDS[yi].label, eq = EQUITIES[ei].id;
    $('pair-title').textContent = `${yl} yield vs ${eq}`;

    const c = corr(...slice(L - N, L, yi, ei));
    const p = corr(...slice(L - 2 * N, L - N, yi, ei));
    const b = beta(...slice(L - N, L, yi, ei));
    const cEl = $('pair-corr');
    cEl.textContent = fmt(c);
    cEl.style.color = Number.isFinite(c) ? (c >= 0 ? 'var(--pos)' : 'var(--neg)') : '';
    $('pair-beta').textContent = Number.isFinite(b) ? `${fmt(b)}% ${eq}` : '–';
    $('pair-prev').textContent = fmt(p);

    const chip = $('pair-chip');
    const per = FREQ_NAME[state.freq];
    let read;
    if (!Number.isFinite(c)) {
      chip.className = 'chip weak'; chip.textContent = L ? 'Not enough data' : 'Loading';
      read = L ? `There are fewer than ${N} ${per}s of overlapping data. Pick a shorter window.` : 'Loading prices…';
    } else if (c > 0.25) {
      chip.className = 'chip pos'; chip.textContent = 'Moving together';
      read = `When the ${yl} yield rises, ${eq} has tended to rise too. Markets are treating higher yields as a sign of growth rather than a threat.`;
    } else if (c < -0.25) {
      chip.className = 'chip neg'; chip.textContent = 'Moving opposite';
      read = `When the ${yl} yield rises, ${eq} has tended to fall. Rate pressure is weighing on stocks, the pattern seen during inflation scares.`;
    } else {
      chip.className = 'chip weak'; chip.textContent = 'Weak link';
      read = `Over the last ${N} ${per}s, ${yl} yield moves have said little about where ${eq} goes. Other drivers dominate.`;
    }
    if (Number.isFinite(b)) read += ` On average, a 10bp rise came with a ${fmt(b)}% move in ${eq} per ${per}.`;
    $('pair-read').textContent = read;

    if (!ensureCharts()) return;
    rollChart.applyOptions({ timeScale: { timeVisible: state.freq === 'H' } });
    const data = [];
    for (let i = N; i <= L; i++) {
      const v = corr(...slice(i - N, i, yi, ei));
      if (Number.isFinite(v)) data.push({ time: changes[i - 1].d, value: +v.toFixed(4) });
    }
    rollSeries.setData(data);
    rollChart.timeScale().fitContent();
    setEmpty('rolling-chart', data.length || !L ? '' : 'Not enough history for this window. Try a shorter one.');
  }

  function renderSpreads() {
    const ds = datasets.D;
    if (!ds || !ensureCharts()) return;
    const m2 = ds.series.US2Y, m10 = ds.series.US10Y, m30 = ds.series.US30Y;
    const keys = [...m10.keys()].sort().slice(-1300);
    const a = [], b = [];
    for (const k of keys) {
      if (m2.has(k)) a.push({ time: k, value: +((m10.get(k) - m2.get(k)) * 100).toFixed(1) });
      if (m30.has(k)) b.push({ time: k, value: +((m30.get(k) - m10.get(k)) * 100).toFixed(1) });
    }
    spreadA.setData(a);
    spreadB.setData(b);
    spreadChart.timeScale().fitContent();
  }

  function setEmpty(id, msg) {
    const host = $(id);
    let el = host.querySelector('.empty');
    if (!msg) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'empty'; host.appendChild(el); }
    el.textContent = msg;
  }

  function renderStatus() {
    const ds = datasets.D;
    const live = Object.keys(quotes).length > 0;
    const dot = $('status-dot');
    const q = quotes[state.yield];
    dot.className = 'dot' + (live ? ' live' : ds && ds.ySource !== 'sample' ? ' partial' : '');
    $('status-text').textContent = live ? `Live · ${q ? q.time : 'updating'}` : ds && ds.ySource === 'fred' ? 'Delayed · FRED daily' : 'Connecting…';

    const note = $('sample-note');
    if (!ds) { note.hidden = true; return; }
    const msgs = [];
    if (ds.ySource === 'fred') msgs.push('The live yield feed is unavailable, so yields fall back to FRED daily closes (one business day behind).');
    if (ds.ySource === 'sample') msgs.push('Yield data is unavailable, so the correlations use sample yields.');
    if (ds.eSource === 'sample') msgs.push('Equity prices are unavailable, so the correlations use sample prices and are illustrative only.');
    if (state.freq === 'H' && !datasets.H) msgs.push(hourlyFailed ? 'Hourly data is unavailable right now.' : 'Loading hourly prices…');
    note.hidden = !msgs.length;
    note.textContent = msgs.join(' ');
  }

  function renderAnalysis() {
    computeChanges();
    renderHeatmap();
    renderPair();
    renderStatus();
  }

  let hourlyFailed = false;
  async function ensureHourly() {
    if (datasets.H || state.freq !== 'H') return;
    renderAnalysis();
    try { datasets.H = await loadDataset('H'); } catch { datasets.H = null; }
    hourlyFailed = !datasets.H;
    if (state.freq === 'H') renderAnalysis();
  }

  async function refreshQuotes() {
    try { quotes = await getQuotes(SYMS); } catch (e) { console.warn('Quotes failed:', e.message); quotes = {}; }
    renderKPIs();
    renderStatus();
  }

  /* ---------- Boot ---------- */
  async function init() {
    if (!INTERVALS.some((i) => i.v === state.interval)) state.interval = 'D';
    buildIntervalControl();
    buildTabs();
    $('freq').value = state.freq;
    buildWindowSelect();
    updateSubtitle();
    renderHeatmap();
    renderPair();

    $('freq').addEventListener('change', (e) => {
      state.freq = e.target.value;
      state.window = DEFAULT_WINDOW[state.freq];
      buildWindowSelect(); saveState(); updateSubtitle(); renderAnalysis(); ensureHourly();
    });
    $('window').addEventListener('change', (e) => { state.window = +e.target.value; saveState(); updateSubtitle(); renderAnalysis(); });

    const [, ds] = await Promise.all([refreshQuotes(), loadDataset('D')]);
    datasets.D = ds;
    renderYieldChart();
    renderEquityChart();
    renderKPIs();
    renderSpreads();
    renderAnalysis();
    ensureHourly();

    setInterval(async () => {
      if (document.hidden) return;
      await refreshQuotes();
      renderYieldChart(false);
      renderEquityChart(false);
    }, REFRESH_MS);
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderKPIs, 150); });
  }

  init();
})();
