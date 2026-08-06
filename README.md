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

**If auth calls start failing with `createUser failed: {}`,** restart the
gateway: `docker restart supabase_kong_<project>`. `supabase db reset` restarts
the containers and Kong comes back blind. It has cost this project an afternoon
more than once.

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
