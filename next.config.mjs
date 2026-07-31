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
};

export default nextConfig;
