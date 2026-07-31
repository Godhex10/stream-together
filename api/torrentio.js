// api/torrentio.js
// Vercel serverless proxy for Torrentio.
//
// Why this exists: calling Torrentio directly from the browser can time out
// on slower/remote connections, and is subject to CORS. A serverless call
// runs from Vercel's datacenter — better routing to Torrentio, no CORS at
// all, a longer timeout, and room to retry across mirrors.
//
// Usage:
//   GET /api/torrentio?type=movie&id=tt0468569
//   GET /api/torrentio?type=series&id=tt0944947:1:1

// Known Torrentio hosts, tried in order until one answers.
const MIRRORS = [
  'https://torrentio.strem.fun',
  'https://torrentio.elfhosted.com'
];

const TIMEOUT_MS = 25000; // Vercel allows longer than a browser realistically should

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
      return { ok: false, mirror: base, ms, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    return {
      ok: true,
      mirror: base,
      ms,
      streams: data.streams || []
    };

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

  const { type = 'movie', id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing "id" parameter' });
  }
  if (type !== 'movie' && type !== 'series') {
    return res.status(400).json({ error: 'type must be "movie" or "series"' });
  }

  const attempts = [];

  for (const base of MIRRORS) {
    const result = await tryMirror(base, type, id);
    attempts.push({ mirror: result.mirror, ms: result.ms, error: result.error || null });

    if (result.ok) {
      console.log(`[Torrentio] ${result.streams.length} streams from ${result.mirror} in ${result.ms}ms`);
      return res.status(200).json({
        streams: result.streams,
        _mirror: result.mirror,
        _ms: result.ms,
        _attempts: attempts
      });
    }

    console.warn(`[Torrentio] ${result.mirror} failed: ${result.error}`);
  }

  // Every mirror failed — report what happened to each so the client can say why
  return res.status(502).json({
    error: 'All Torrentio mirrors failed',
    streams: [],
    _attempts: attempts
  });
}
