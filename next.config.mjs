import createNextIntlPlugin from 'next-intl/plugin';

// Block 12a, D3. Points next-intl at the request config that resolves the
// locale from the cookie the middleware keeps in step (src/i18n/request.ts).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Top-level since Next 15.5; `experimental.typedRoutes` is deprecated.
  typedRoutes: true,
  experimental: {
    serverActions: {
      // Fix-round finding: the participations import posts its whole parsed
      // file as one JSON string in a hidden form field
      // (src/app/(app)/participations/import-form.tsx). Left at Next's 1 MB
      // default, that field alone caps an import at roughly seven thousand
      // rows with no message at all — a silent cap design spec §6/D6 forbids.
      //
      // Sized by MEASURING, not estimating: a worst-realistic-case row (a long
      // accented name, and a CPF/phone still carrying the punctuation a
      // spreadsheet cell has before schemas/participations.ts's preprocessors
      // strip it — `{"line":1234567,"fullName":"Maria Aparecida da Conceição
      // Nascimento Oliveira","phone":"+55 (11) 98765-4321","cpf":"123.456.789-09",
      // "participatedAt":"2026-07-30T14:30:00.000-03:00"}`) serializes to 182
      // bytes. Eight thousand of those — the design doc's own reference point,
      // docs/superpowers/specs/2026-07-30-block-4c-participations-design.md:90
      // — measure to 1,438,897 bytes (~1.37 MiB). '8mb' clears that with room
      // to spare: a binary search over the same worst-case row shows 46,407
      // of them fit under 8 MiB (8,388,608 bytes) before this limit is
      // reached — close to six times the design doc's scale, and far more
      // for an ordinary file of short names and digits-only phone/CPF.
      //
      // MUST be kept equal, by hand, to
      // src/app/(app)/participations/import-form.tsx's
      // IMPORT_ROWS_BODY_LIMIT_BYTES, which is what the browser checks BEFORE
      // posting anything, so an oversized file is refused with a message
      // naming the cap rather than truncated or answered with a 413 the
      // operator has no way to read. This file is loaded by plain Node before
      // webpack runs, so it cannot import that value, and that client module
      // cannot import this file without pulling Next's config-loading code
      // into the browser bundle — hence two literals, not one shared constant.
      bodySizeLimit: '8mb',
    },
  },

  // Block 11a. The five headers that must reach EVERY route.
  //
  // Here rather than in middleware.ts, and the reason is that file's own
  // matcher: it deliberately excludes /api/webhooks/ and /api/worker/, because
  // including them would 307 Meta's verification handshake and stop both queues
  // in silence. Anything set only in the middleware therefore never reaches the
  // two endpoints an outside system actually calls. `headers()` has no such
  // hole.
  //
  // The CSP is NOT here, and cannot be: its nonce is per-request, and this file
  // is evaluated once at boot. It lives in the middleware alongside the session
  // refresh, which is the only place a per-request value can be produced.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Redundant with the CSP's `frame-ancestors 'none'` for a modern
          // browser, and kept for the ones that never implemented it. The two
          // must agree: a permissive value here beside a strict directive there
          // is the shape of an accident.
          { key: 'X-Frame-Options', value: 'DENY' },
          // Stops a browser guessing that a download proxy's octet-stream is
          // really HTML and running it. This app serves member documents and
          // delivery receipts through such a proxy.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Every record screen in this product carries a ?record=<uuid>, and
          // without this the full URL travels in the Referer of every outbound
          // request. `strict-origin-when-cross-origin` keeps the path inside
          // the origin and sends only the origin outside it.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Nothing in this product uses any of these, so they are refused
          // rather than left to a default that may change.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          // Two years, subdomains included. NOT preloaded: preload is a
          // one-way door on the apex domain and belongs to whoever owns DNS,
          // not to this file.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
