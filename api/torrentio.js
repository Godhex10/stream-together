// api/torrentio.js
// Vercel serverless proxy for Stremio-protocol addons (Torrentio, Nuvio).
//
// Why: calling these directly from the browser can time out on slower or
// remote connections, and is subject to CORS. A serverless call runs from
// Vercel's datacenter — better routing, no CORS, longer timeout, and room
// to fall back across mirrors.
//
// Usage:
//   GET /api/torrentio?source=torrentio&type=movie&id=tt0468569
//   GET /api/torrentio?source=nuvio&type=series&id=tt0944947:1:1

const SOURCES = {
  torrentio: [
    'https://torrentio.strem.fun',
    'https://torrentio.elfhosted.com'
  ],
  nuvio: [
    'https://nuviostreamsaddon.up.railway.app'
  ]
};

const TIMEOUT_MS = 25000;

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

    if (!res.ok) return { ok: false, mirror: base, ms, error: `HTTP ${res.status}` };

    const data = await res.json();
    return { ok: true, mirror: base, ms, streams: data.streams || [] };

  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - startedAt;
    const reason = e.name === 'AbortError'
      ? `timed out after ${TIMEOUT_MS / 1000}s`
      : e.message;
    return { ok: false, mirror: base, ms, error: reason };
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

  const attempts = [];

  for (const base of mirrors) {
    const result = await tryMirror(base, type, id);
    attempts.push({ mirror: result.mirror, ms: result.ms, error: result.error || null });

    if (result.ok) {
      console.log(`[${source}] ${result.streams.length} streams from ${result.mirror} in ${result.ms}ms`);
      return res.status(200).json({
        streams:   result.streams,
        _source:   source,
        _mirror:   result.mirror,
        _ms:       result.ms,
        _attempts: attempts
      });
    }

    console.warn(`[${source}] ${result.mirror} failed: ${result.error}`);
  }

  return res.status(502).json({
    error:     `All ${source} mirrors failed`,
    streams:   [],
    _source:   source,
    _attempts: attempts
  });
}
