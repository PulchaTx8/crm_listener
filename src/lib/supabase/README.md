# Supabase clients (decision D4)

- `createUserClient()` — per-request client carrying the user's JWT (via cookies). **The default**
  for every read/write of tenant data. Database RLS is enforced.
- `createServiceClient()` — `service_role` client, marked `server-only`. **RLS is bypassed.** Use it
  ONLY in the WhatsApp webhook, cron jobs, migration ETL and platform operations.
  `SECURITY DEFINER` functions re-check permission internally no matter which client calls them (H2).

Never import `service-client.ts` in client components. Never expose `SUPABASE_SERVICE_ROLE_KEY`.
