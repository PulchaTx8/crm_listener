# PulchatX

A CRM for radio stations: the audience, the promotions they enter, the prizes
those promotions draw from, the draws, the deliveries, the WhatsApp conversation
that runs much of it, and the reports at the end. Multi-tenant — an Organization
owns one or more Stations, and a listener belongs to the Organization rather than
to any one of them.

## Getting it running

```bash
npm install
npx supabase start        # Docker; brings up Postgres, auth, storage and Kong
npm run db:reset          # applies every migration
npm run seed:demo         # a demo Station with the whole cycle already in it
npm run dev               # http://localhost:3000
```

The seed prints the two sign-ins it made: an owner for the product and a platform
admin for the console. It refuses to run against anything but a local stack.

`npm run db:reset` is local by construction for the same reason: it goes through
`scripts/db-reset.mjs`, which passes `--local` explicitly and refuses `--linked`
and `--db-url`. **The bare CLI still accepts them.** `supabase db reset --linked`
destroys the hosted project — every customer row and every sign-in — and it is
one word away from the `--linked` you correctly pass to `supabase migration list`
before merging a block with a migration.

**If auth calls start failing with `createUser failed: {}`,** restart the
gateway: `docker restart supabase_kong_<project>`. `supabase db reset` restarts
the containers and Kong comes back blind. It has cost this project an afternoon
more than once.

## The demonstration Organization, which is live

The hosted project carries **PULCHATX DEMO** / Station **DEMO FM** — roughly
10,300 rows, seeded on 2026-08-10 and **kept there on purpose**: it is what the
product is shown from. It sits beside real customer data and is meant to.

`npm run seed:demo` cannot have made it — that script is pinned to a local stack
by `src/lib/security/local-only.ts`, and widening it would disarm the guard for
every future run. The two files below are a separate door with its own keys:

| | |
| --- | --- |
| `scripts/seed-hosted-demo.mjs` | built it. Every input required, `DEMO_SEED_CONFIRM` must spell out the Organization name, and off localhost `DEMO_SEED_I_MEAN_PRODUCTION=yes` is a second key. It only ever creates — a name already taken stops the run. |
| `scripts/unseed-hosted-demo.sql` | takes it back out, and is the only thing that can. |

**The teardown is SQL and not a script for a reason that will outlive the demo:**
`service_role` holds DELETE on six tables in this schema and SELECT on forty
more, so a Node teardown takes 42501 from everything that matters — and if it
reads that as "nothing to do", it reports a clean database over a full one. Run
it as `postgres`, from the dashboard's SQL editor or `psql`. Both files carry the
full reasoning in their headers, including the deferred trigger that otherwise
rolls the whole thing back at COMMIT.

Seeded listeners have phone numbers shaped `+55DD90…` — real area code, real
leading 9, and then a 0 where a Brazilian mobile has 6–9. They read as phone
numbers on screen and reach nobody.

## The suites, and what each one is for

| command | proves |
| --- | --- |
| `npm run test` | pure logic, schemas and route handlers — no database |
| `npm run db:test` | the database's own objects and rules, under pgTAP |
| `npm run test:isolation` | that RLS and the grants actually stop what they claim to |
| `npm run test:e2e` | the screens, and the seams between them |

`npm run db:test` needs a freshly reset database — after an e2e or isolation run
one music test fails on leftover state, and that is not a regression.

## The documents

| | |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | how it is put together, and where to change a given thing |
| [SECURITY](docs/SECURITY.md) | the boundaries, what enforces each, and which test would notice |
| [DATABASE](docs/DATABASE.md) | migrations, grants, and the rules that are expensive to rediscover |
| [PERMISSIONS](docs/PERMISSIONS.md) | roles per Station, and where the real list lives |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | the reproducible path, and a backup that was actually restored |

Everything in `docs/block-*` is history: one report and one runbook per block,
recording why each decision was made in the week it was made.
