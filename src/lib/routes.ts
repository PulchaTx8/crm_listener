/**
 * Where a signed-in member lands.
 *
 * Block 20b, D6. This was spelled in three places — `MEMBER_HOME` in
 * middleware.ts, the sign-in redirect, and the redirect after a forced password
 * change — which is three copies of one fact and three places for it to drift.
 *
 * THERE IS NO REDIRECT LOOP, and this was checked rather than assumed:
 * /dashboards/audience redirects to /app for a caller who can reach no Station
 * with the permission it needs (its page.tsx, `if (!first) redirect('/app')`),
 * so a member who cannot see the dashboard lands exactly where they land today.
 */
export const MEMBER_HOME = '/dashboards/audience';
