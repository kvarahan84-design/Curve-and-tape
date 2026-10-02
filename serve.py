"""Local dev server: serves the static site and mirrors the /api/fred and /api/cnbc Vercel functions.

Run:  python serve.py   then open http://localhost:8787
"""
import datetime
import http.server
import json
import os
import re
import time
import urllib.parse
import urllib.request

PORT = int(os.environ.get("PORT", 8787))
ROOT = os.path.dirname(os.path.abspath(__file__))
IDS = ["DGS2", "DGS10", "DGS20", "DGS30"]
_cache = {"t": 0.0, "body": None}


def fetch_fred():
    start = (datetime.date.today() - datetime.timedelta(days=365 * 7)).isoformat()
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + ",".join(IDS) + "&cosd=" + start
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (curve-and-tape dev)"})
    csv = urllib.request.urlopen(req, timeout=60).read().decode()
    lines = csv.strip().splitlines()
    col = {h.strip(): i for i, h in enumerate(lines[0].split(","))}
    out = {"dates": [], "fetched": datetime.datetime.now(datetime.timezone.utc).isoformat(), **{k: [] for k in IDS}}
    for line in lines[1:]:
        cells = line.split(",")
        if cells[0] < start:
            continue
        vals = []
        for k in IDS:
            try:
                vals.append(float(cells[col[k]]))
            except (KeyError, IndexError, ValueError):
                vals.append(None)
        if all(v is None for v in vals):
            continue
        out["dates"].append(cells[0])
        for k, v in zip(IDS, vals):
            out[k].append(v)
    return out


SYM = re.compile(r"^[A-Z0-9.]{1,12}$")
STAMP = re.compile(r"^\d{14}$")
BAR_SIZES = {"1M", "5M", "30M", "1H", "1D", "1W", "1MO"}
_cnbc_cache = {}


def cnbc_url(q):
    """Mirror of api/cnbc.js: build the CNBC URL from validated query params."""
    get = lambda k: (q.get(k) or [""])[0]
    if get("type") == "quote":
        syms = [s for s in get("syms").split(",") if SYM.match(s)][:20]
        if syms:
            return ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols="
                    + "%7C".join(syms) + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1"), 10
    elif get("type") == "bars":
        sym, api, frm, to = get("sym"), get("api"), get("from"), get("to")
        if SYM.match(sym) and api in BAR_SIZES and STAMP.match(frm) and STAMP.match(to):
            return f"https://ts-api.cnbc.com/harmony/app/bars/{sym}/{api}/{frm}/{to}/adjusted/EST5EDT.json", 20
    return None, 0


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/cnbc"):
            return self.cnbc()
        if not self.path.startswith("/api/fred"):
            return super().do_GET()
        try:
            if not _cache["body"] or time.time() - _cache["t"] > 3600:
                _cache["body"] = json.dumps(fetch_fred()).encode()
                _cache["t"] = time.time()
            body, status = _cache["body"], 200
        except Exception as e:  # noqa: BLE001
            body, status = json.dumps({"error": str(e)}).encode(), 502
        self.reply(status, body)

    def cnbc(self):
        url, ttl = cnbc_url(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
        if not url:
            return self.reply(400, b'{"error":"bad request"}')
        hit = _cnbc_cache.get(url)
        if hit and time.time() - hit[0] < ttl:
            return self.reply(200, hit[1])
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (curve-and-tape dev)"})
            body = urllib.request.urlopen(req, timeout=30).read()
            _cnbc_cache[url] = (time.time(), body)
            self.reply(200, body)
        except Exception as e:  # noqa: BLE001
            self.reply(502, json.dumps({"error": str(e)}).encode())

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"Curve & Tape on http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
