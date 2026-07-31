// api/torrentio.js
// Vercel serverless proxy for Stremio-protocol addons (Torrentio, Nuvio).
//
// TIMING CONSTRAINT: Vercel's free tier kills functions at 10s. Everything
// here must finish well inside that, so mirrors are raced in PARALLEL with a
// short per-request timeout rather than tried one after another.
//
// Usage:
//   GET /api/torrentio?source=torrentio&type=movie&id=tt0468569
//   GET /api/torrentio?source=nuvio&type=series&id=tt0944947:1:1

const SOURCES = {
  torrentio: [
    'https://torrentio.strem.fun'
  ],
  nuvio: [
    'https://nuviostreamsaddon-production.up.railway.app'
  ]
};

// 7s leaves ~3s of headroom under Vercel's 10s function limit
const TIMEOUT_MS = 7000;

async function tryMirror(base, type, id) {
  const url = `${base}/stream/${type}/${encodeURIComponent(id)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    clearTimeout(timer);
    const ms = Date.now() - startedAt;

    if (!res.ok) {
      // Include a snippet of the body — a 404 page often says what's wrong
      let hint = '';
      try {
        const text = await res.text();
        if (text) hint = ` — ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      } catch (_) {}
      return { ok: false, mirror: base, ms, url, error: `HTTP ${res.status}${hint}` };
    }

    const data = await res.json();
    return { ok: true, mirror: base, ms, url, streams: data.streams || [] };

  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - startedAt;
    const reason = e.name === 'AbortError'
      ? `no response in ${TIMEOUT_MS / 1000}s`
      : e.message;
    return { ok: false, mirror: base, ms, url, error: reason };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type = 'movie', id, source = 'torrentio' } = req.query;

  if (!id) return res.status(400).json({ error: 'Missing "id" parameter' });
  if (type !== 'movie' && type !== 'series') {
    return res.status(400).json({ error: 'type must be "movie" or "series"' });
  }

  const mirrors = SOURCES[source];
  if (!mirrors) {
    return res.status(400).json({
      error: `Unknown source "${source}"`,
      available: Object.keys(SOURCES)
    });
  }

  // Race all mirrors at once — total time is the slowest single request,
  // not the sum. Keeps us inside Vercel's function limit.
  const results = await Promise.all(mirrors.map(m => tryMirror(m, type, id)));

  const attempts = results.map(r => ({
    mirror: r.mirror,
    ms:     r.ms,
    url:    r.url,
    error:  r.error || null,
    count:  r.ok ? r.streams.length : 0
  }));

  // Prefer a mirror that actually returned streams, then any that responded OK
  const withStreams = results.find(r => r.ok && r.streams.length > 0);
  const anyOk       = results.find(r => r.ok);
  const winner      = withStreams || anyOk;

  if (winner) {
    console.log(`[${source}] ${winner.streams.length} streams from ${winner.mirror} in ${winner.ms}ms`);
    return res.status(200).json({
      streams:   winner.streams,
      _source:   source,
      _mirror:   winner.mirror,
      _ms:       winner.ms,
      _attempts: attempts
    });
  }

  console.warn(`[${source}] all mirrors failed`, attempts);
  return res.status(502).json({
    error:     `All ${source} mirrors failed`,
    streams:   [],
    _source:   source,
    _attempts: attempts
  });
}
