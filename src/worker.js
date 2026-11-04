// Pasuk — per-verse share permalinks.
//
// The app itself is a pure client-side SPA addressed by hash (`/#Genesis.1.1`),
// which is invisible to the server and to link-preview crawlers (Facebook,
// Twitter/X, Slack, iMessage, WhatsApp, etc. never execute JS and never see
// the URL fragment). That made every shared verse link show the same generic
// site-wide preview card, no matter which verse was shared — a real gap for
// an app whose entire growth model is "someone shares a verse".
//
// This Worker adds a tiny, real, crawlable permalink: `/v/<Book.chapter.verse>`.
// It looks up the real verse in the real data file and renders real
// server-side HTML with per-verse Open Graph + Twitter Card tags, so a shared
// link gets a real rich preview (verse reference + actual verse text). Human
// visitors get the same content (progressive enhancement — no JS required to
// read the verse), then an external script (CSP-compliant, no inline script)
// hands off into the full app at the existing `#Book.chapter.verse` hash
// route, reusing the app's own deep-link logic rather than inventing a new one.
//
// Every other path is untouched and falls straight through to static assets.

const VERSE_ID_RE = /^\/v\/([A-Za-z]+\.\d+\.\d+)\/?$/;

// Same header set as public/_headers — that file only applies to static
// asset responses, never to responses a Worker generates itself, so it has
// to be duplicated here to keep this route's security posture identical.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://insights.ereboslab.com https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://insights.ereboslab.com https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// Parsed verse list, cached per warm isolate so repeated requests on the
// same instance don't re-parse the 3.6MB torah.json every time.
let versesCache = null;

async function getVerses(env, origin) {
  if (versesCache) return versesCache;
  const res = await env.ASSETS.fetch(new URL("/data/torah.json", origin));
  if (!res.ok) return null;
  versesCache = await res.json();
  return versesCache;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function renderVersePage(verse, origin) {
  const reference = `${verse.book} ${verse.chapter}:${verse.verse}`;
  const title = `${reference} — Pasuk`;
  const description = truncate(verse.translation, 200);
  const permalink = `${origin}/v/${verse.id}`;
  const ogImage = `${origin}/og-image.png`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="theme-color" content="#0a0b0d" />
<link rel="canonical" href="${escapeHtml(permalink)}" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="manifest" href="/manifest.json" />
<link rel="stylesheet" href="/style.css" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${escapeHtml(permalink)}" />
<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Pasuk — the Torah, one verse at a time" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(ogImage)}" />
</head>
<body class="verse-permalink">
<main class="verse-permalink-card">
  <p class="verse-permalink-ref">${escapeHtml(reference)} &middot; Parashat ${escapeHtml(verse.parsha)}</p>
  <p class="verse-permalink-hebrew" lang="he" dir="rtl">${escapeHtml(verse.hebrew)}</p>
  <p class="verse-permalink-translation">${escapeHtml(verse.translation)}</p>
  <a class="verse-permalink-open" href="/#${encodeURIComponent(verse.id)}">Open in Pasuk</a>
</main>
<script src="/verse-redirect.js"></script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(VERSE_ID_RE);

    if (match) {
      const id = match[1];
      const verses = await getVerses(env, url.origin);
      const verse = verses ? verses.find((v) => v.id === id) : null;
      if (verse) return renderVersePage(verse, url.origin);
      // Unknown verse id: fall back to the normal SPA shell rather than a
      // dead end — same behavior as any other unmatched route.
    }

    return env.ASSETS.fetch(request);
  },
};
