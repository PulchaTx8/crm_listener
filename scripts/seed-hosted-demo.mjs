import { createClient } from '@supabase/supabase-js';

/**
 * A demonstration Organization, at audience scale, on a HOSTED project.
 *
 * NOT `scripts/seed-demo.mjs`, and not a flag on it. That script is pinned to a
 * local stack by `src/lib/security/local-only.ts`, and the reason written there
 * has not stopped being true: one exported variable between a demo Station and a
 * demo Station inside a customer's database, with rows that look exactly like
 * the real ones. Widening that script would disarm the guard for every future
 * run of `npm run seed:demo`. This is a separate door, with its own key.
 *
 * WHAT KEEPS IT HONEST
 *
 *   1. Every input is required. There is no default URL, so a bare `node
 *      scripts/seed-hosted-demo.mjs` writes nothing anywhere.
 *   2. DEMO_SEED_CONFIRM must spell out the Organization name. Typing the name
 *      is the deliberate act.
 *   3. Off a local host, DEMO_SEED_I_MEAN_PRODUCTION=yes is a second key. The
 *      rehearsal runs with one key; production needs two.
 *   4. It only ever CREATES an Organization. If the name is taken it stops --
 *      it will not add rows to a group that already exists, which is the one
 *      way this could reach a customer's data.
 *
 * Everything it writes belongs to that single Organization, which is what makes
 * `scripts/unseed-hosted-demo.sql` able to take it all back out. There is no
 * `db:reset` on a hosted project.
 *
 * The teardown is SQL and not a second script here, because service_role holds
 * DELETE on six tables in this schema and SELECT on forty more. A Node teardown
 * gets 42501 from everything that matters. That file has the full reasoning.
 */

const URL_ = required('DEMO_SEED_URL');
const SERVICE_KEY = required('DEMO_SEED_SERVICE_ROLE_KEY');
const ANON_KEY = required('DEMO_SEED_ANON_KEY');

const ORGANIZATION = process.env.DEMO_SEED_ORGANIZATION ?? 'PULCHATX DEMO';
const STATION = process.env.DEMO_SEED_STATION ?? 'DEMO FM';
const LISTENER_COUNT = Number(process.env.DEMO_SEED_LISTENERS ?? 1000);

const OWNER_EMAIL = process.env.DEMO_SEED_OWNER_EMAIL ?? 'demo@pulchatx.com';

/** Required, and deliberately without a default: the account this creates is a
 *  real sign-in on a hosted project, and a literal here would put a live
 *  credential in version control. `/Manual/` is in .gitignore for exactly that
 *  reason. Changing it later is the Members screen's job, not this script's. */
const PASSWORD = required('DEMO_SEED_PASSWORD');

/** Temporary. Created to satisfy is_platform_admin(), stripped of the privilege
 *  in the last step -- provision_organization and add_company are SECURITY
 *  DEFINER and re-check it against auth.uid(), which a service key has none of.
 *  The alternative was borrowing the real admin account's password. */
const PROVISIONER_EMAIL =
  process.env.DEMO_SEED_PROVISIONER_EMAIL ?? 'demo-provisioner@pulchatx.com';

const CONCURRENCY = Number(process.env.DEMO_SEED_CONCURRENCY ?? 8);

const DAY = 86_400_000;
const HOUR = 3_600_000;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `\nseed:hosted refused to run - ${name} is not set.\n` +
        'Every input is required on purpose: this script has no default target.',
    );
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The two keys.
// ---------------------------------------------------------------------------
let host;
try {
  host = new global.URL(URL_).hostname;
} catch {
  console.error(`\nseed:hosted refused to run - DEMO_SEED_URL is not a URL: ${URL_}`);
  process.exit(1);
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isLocal = LOCAL_HOSTNAMES.has(host);

if (process.env.DEMO_SEED_CONFIRM !== ORGANIZATION) {
  console.error(
    `\nseed:hosted refused to run - set DEMO_SEED_CONFIRM to exactly "${ORGANIZATION}".\n` +
      'Naming the Organization out loud is what separates this from a mistake.',
  );
  process.exit(1);
}

if (!isLocal && process.env.DEMO_SEED_I_MEAN_PRODUCTION !== 'yes') {
  console.error(
    `\nseed:hosted refused to run - ${host} is not a local stack.\n` +
      'Writing invented listeners into a hosted project needs DEMO_SEED_I_MEAN_PRODUCTION=yes.',
  );
  process.exit(1);
}

const admin = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Determinism. Same reasoning as seed-demo: a demo whose contents change on
// every run cannot be used to reproduce anything somebody saw once.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(0x5eed_c12a);
const pick = (items) => items[Math.floor(random() * items.length)];
const pickInt = (min, max) => min + Math.floor(random() * (max - min + 1));

// ---------------------------------------------------------------------------
// Names. Three pools rather than a thousand literals: first and middle alone
// give 1200 distinct pairs before the surname is consulted, so a thousand
// listeners are distinct BY CONSTRUCTION and members_email_unique never has to
// arbitrate.
// ---------------------------------------------------------------------------
const FIRST = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Elaine',
  'Fábio',
  'Gabriela',
  'Heitor',
  'Isabela',
  'João',
  'Karina',
  'Leandro',
  'Mariana',
  'Nelson',
  'Olívia',
  'Paulo',
  'Queila',
  'Rafael',
  'Simone',
  'Thiago',
  'Úrsula',
  'Vinícius',
  'Wanda',
  'Xênia',
  'Yuri',
  'Zilda',
  'Adriana',
  'Bernardo',
  'Cristiane',
  'Daniel',
  'Érica',
  'Felipe',
  'Giovana',
  'Hugo',
  'Inês',
  'Júlio',
  'Kelly',
  'Lucas',
  'Márcia',
  'Natan',
];

const MIDDLE = [
  'Beatriz',
  'Sampaio',
  'Menezes',
  'Antunes',
  'Prado',
  'Nogueira',
  'Tavares',
  'Salgado',
  'Quintana',
  'Vitor',
  'Bastos',
  'Peixoto',
  'Coutinho',
  'Braga',
  'Rezende',
  'César',
  'Fontes',
  'Mendonça',
  'Aguiar',
  'Belmonte',
  'Kaminski',
  'Aragão',
  'Siqueira',
  'Portugal',
  'Falcão',
  'Marcondes',
  'Pontes',
  'Ottoni',
  'Vilela',
  'Escobar',
];

const LAST = [
  'Ferreira',
  'Rocha',
  'Duarte',
  'Vilar',
  'Cordeiro',
  'Lins',
  'Pinto',
  'Muniz',
  'Reis',
  'Camargo',
  'Leal',
  'Faria',
  'Alves',
  'Teixeira',
  'Campos',
  'Amorim',
  'Barreto',
  'Vieira',
  'Portela',
  'Cruz',
  'Lopes',
  'Serra',
  'Moraes',
  'Dias',
  'Bandeira',
  'Neves',
  'Guerra',
  'Xavier',
  'Bomfim',
  'Trindade',
  'Padilha',
  'Moura',
  'Sarmento',
  'Pimentel',
  'Brito',
  'Lara',
  'Vasques',
  'Furtado',
  'Ferrari',
  'Cavalcanti',
];

const PLACES = [
  { city: 'São Paulo', state: 'SP', ddd: '11' },
  { city: 'Campinas', state: 'SP', ddd: '19' },
  { city: 'Rio de Janeiro', state: 'RJ', ddd: '21' },
  { city: 'Niterói', state: 'RJ', ddd: '21' },
  { city: 'Belo Horizonte', state: 'MG', ddd: '31' },
  { city: 'Uberlândia', state: 'MG', ddd: '34' },
  { city: 'Curitiba', state: 'PR', ddd: '41' },
  { city: 'Londrina', state: 'PR', ddd: '43' },
  { city: 'Porto Alegre', state: 'RS', ddd: '51' },
  { city: 'Salvador', state: 'BA', ddd: '71' },
  { city: 'Recife', state: 'PE', ddd: '81' },
  { city: 'Fortaleza', state: 'CE', ddd: '85' },
];

const DISCOVERY_SOURCES = [
  'Rádio',
  'Instagram',
  'WhatsApp',
  'Indicação de amigo',
  'Site da emissora',
];

const GENRES = ['MPB', 'Sertanejo', 'Rock', 'Pagode', 'Forró', 'Pop', 'Samba', 'Axé'];
const LABELS = [
  'Som Livre',
  'Universal Music',
  'Sony Music',
  'Warner Music',
  'Deckdisc',
  'Biscoito Fino',
];
const SHOWS = ['Manhã Total', 'Tarde Animada', 'Vozes do Brasil', 'Madrugada Pulchá'];

const ARTISTS = [
  {
    name: 'Marina Vasques',
    genre: 'MPB',
    label: 'Biscoito Fino',
    nationality: 'DOMESTIC',
    vocal: 'FEMALE',
  },
  {
    name: 'Trio Beira-Rio',
    genre: 'Forró',
    label: 'Deckdisc',
    nationality: 'DOMESTIC',
    vocal: 'GROUP',
  },
  {
    name: 'Caio Bragança',
    genre: 'Sertanejo',
    label: 'Som Livre',
    nationality: 'DOMESTIC',
    vocal: 'MALE',
  },
  {
    name: 'As Meninas do Cais',
    genre: 'Samba',
    label: 'Som Livre',
    nationality: 'DOMESTIC',
    vocal: 'GROUP',
  },
  {
    name: 'Orquestra Baixa Feliz',
    genre: 'MPB',
    label: 'Biscoito Fino',
    nationality: 'DOMESTIC',
    vocal: 'INSTRUMENTAL',
  },
  { name: 'Nortada', genre: 'Rock', label: 'Deckdisc', nationality: 'DOMESTIC', vocal: 'GROUP' },
  {
    name: 'Helena e Otávio',
    genre: 'MPB',
    label: 'Universal Music',
    nationality: 'DOMESTIC',
    vocal: 'DUO',
  },
  {
    name: 'Bloco Maré Cheia',
    genre: 'Axé',
    label: 'Warner Music',
    nationality: 'DOMESTIC',
    vocal: 'GROUP',
  },
  {
    name: 'Grupo Quintal Aberto',
    genre: 'Pagode',
    label: 'Som Livre',
    nationality: 'DOMESTIC',
    vocal: 'GROUP',
  },
  {
    name: 'Dupla Estrada Velha',
    genre: 'Sertanejo',
    label: 'Universal Music',
    nationality: 'DOMESTIC',
    vocal: 'DUO',
  },
  {
    name: 'Paper Lanterns',
    genre: 'Pop',
    label: 'Warner Music',
    nationality: 'INTERNATIONAL',
    vocal: 'GROUP',
  },
  {
    name: 'Sienna Hale',
    genre: 'Pop',
    label: 'Sony Music',
    nationality: 'INTERNATIONAL',
    vocal: 'FEMALE',
  },
];

const ALBUMS = [
  { title: 'Litoral Norte', artist: 0, released: '2023-04-14' },
  { title: 'Poeira e Sal', artist: 1, released: '2022-09-02' },
  { title: 'Estrada de Chão', artist: 2, released: '2024-02-16' },
  { title: 'Roda Aberta', artist: 3, released: '2021-11-05' },
  { title: 'Glasshouse', artist: 10, released: '2023-08-25' },
  { title: 'Slow Amber', artist: 11, released: '2024-06-07' },
];

const SONGS = [
  { title: 'Litoral Norte', artist: 0, album: 0, seconds: 231 },
  { title: 'Maré de Setembro', artist: 0, album: 0, seconds: 198 },
  { title: 'Carta sem Selo', artist: 0, album: 0, seconds: 254 },
  { title: 'Janela do Corredor', artist: 0, album: null, seconds: 187 },
  { title: 'Poeira e Sal', artist: 1, album: 1, seconds: 176 },
  { title: 'Sanfona Teimosa', artist: 1, album: 1, seconds: 203 },
  { title: 'Xote da Madrugada', artist: 1, album: 1, seconds: 219 },
  { title: 'Volta pro Sertão', artist: 1, album: null, seconds: 241 },
  { title: 'Estrada de Chão', artist: 2, album: 2, seconds: 212 },
  { title: 'Boiadeiro Sem Pressa', artist: 2, album: 2, seconds: 227 },
  { title: 'Última Porteira', artist: 2, album: 2, seconds: 195 },
  { title: 'Chapéu na Mão', artist: 2, album: null, seconds: 208 },
  { title: 'Roda Aberta', artist: 3, album: 3, seconds: 244 },
  { title: 'Cais de Pedra', artist: 3, album: 3, seconds: 189 },
  { title: 'Samba de Quarta', artist: 3, album: 3, seconds: 233 },
  { title: 'Prosa de Fim de Tarde', artist: 4, album: null, seconds: 302 },
  { title: 'Marcha do Vagalume', artist: 4, album: null, seconds: 268 },
  { title: 'Suíte da Ponte Velha', artist: 4, album: null, seconds: 341 },
  { title: 'Vento Sul', artist: 5, album: null, seconds: 214 },
  { title: 'Farol Quebrado', artist: 5, album: null, seconds: 236 },
  { title: 'Ruído Branco', artist: 5, album: null, seconds: 199 },
  { title: 'Serra Acima', artist: 5, album: null, seconds: 258 },
  { title: 'Dois Relógios', artist: 6, album: null, seconds: 221 },
  { title: 'Café Frio', artist: 6, album: null, seconds: 184 },
  { title: 'Se For Domingo', artist: 6, album: null, seconds: 207 },
  { title: 'Maré Cheia', artist: 7, album: null, seconds: 226 },
  { title: 'Trio da Avenida', artist: 7, album: null, seconds: 249 },
  { title: 'Bloco de Rua', artist: 7, album: null, seconds: 193 },
  { title: 'Pandeiro de Prata', artist: 8, album: null, seconds: 217 },
  { title: 'Quintal Cheio', artist: 8, album: null, seconds: 205 },
  { title: 'Cavaco e Cerveja', artist: 8, album: null, seconds: 238 },
  { title: 'Duas Violas', artist: 9, album: null, seconds: 229 },
  { title: 'Beira de Estrada', artist: 9, album: null, seconds: 211 },
  { title: 'Modão Antigo', artist: 9, album: null, seconds: 246 },
  { title: 'Glasshouse', artist: 10, album: 4, seconds: 202 },
  { title: 'Neon Harbour', artist: 10, album: 4, seconds: 188 },
  { title: 'Paper Weather', artist: 10, album: 4, seconds: 215 },
  { title: 'Slow Amber', artist: 11, album: 5, seconds: 196 },
  { title: 'Copper Rain', artist: 11, album: 5, seconds: 223 },
  { title: 'Half a Signal', artist: 11, album: 5, seconds: 179 },
];

const PRIZES = [
  { name: 'Par de ingressos, show de sábado', stock: 300, returns: true },
  { name: 'Fim de semana para dois no litoral', stock: 60, returns: false },
  { name: 'Encontro com a banda nos bastidores', stock: 120, returns: true },
];

/** Proportional to the audience: roughly 40% of it entered the promotion that
 *  closed, 35% the one on air, and the two slices overlap -- the repeat figures
 *  on the Audience dashboard are counting exactly that overlap. */
const CLOSED_ENTRIES = Math.round(LISTENER_COUNT * 0.4);
const LIVE_ENTRIES = Math.round(LISTENER_COUNT * 0.35);
const LIVE_OFFSET = Math.round(LISTENER_COUNT * 0.25);
const REQUEST_COUNT = Math.round(LISTENER_COUNT * 0.6);

async function main() {
  console.log(`\n  target      ${host}`);
  console.log(`  organization  ${ORGANIZATION}`);
  console.log(`  station       ${STATION}`);
  console.log(`  listeners     ${LISTENER_COUNT}\n`);

  // The one check that keeps this off a customer's data. It creates, never
  // appends: a name already in use is a stop, not a resume.
  const existing = await admin
    .from('organizations')
    .select('id, name')
    .eq('name', ORGANIZATION)
    .maybeSingle();
  if (existing.error) throw new Error(`looking for the Organization: ${existing.error.message}`);
  if (existing.data) {
    console.error(
      `\nseed:hosted refused to run - "${ORGANIZATION}" already exists on ${host}.\n` +
        'This script only ever creates. Run scripts/unseed-hosted-demo.mjs first, or pick another name\n' +
        'with DEMO_SEED_ORGANIZATION.',
    );
    process.exit(1);
  }

  // 1. The temporary provisioner.
  const provisionerId = await createUser(PROVISIONER_EMAIL, 'Demo Provisioner');
  const promoted = await admin.from('platform_admins').insert({ user_id: provisionerId });
  if (promoted.error) throw new Error(`platform_admins insert: ${promoted.error.message}`);
  console.log('  temporary platform admin created');

  // 2. The group and its Station, through the same two RPCs the console uses.
  const provisioner = await signIn(PROVISIONER_EMAIL);
  const ownerId = await createUser(OWNER_EMAIL, 'Demonstração PulchaTX');
  const organizationId = await rpc(provisioner, 'provision_organization', {
    p_user_id: ownerId,
    p_organization_name: ORGANIZATION,
  });
  const companyId = await rpc(provisioner, 'add_company', {
    p_organization_id: organizationId,
    p_name: STATION,
    p_timezone: 'America/Sao_Paulo',
  });
  console.log(`  organization ${organizationId}`);
  console.log(`  station      ${companyId}`);

  // 3. The provisional password expires and the middleware forces a change
  // before any screen. Cleared so the demo opens on a screen.
  const cleared = await admin
    .from('profiles')
    .update({ must_change_password: false, provisional_expires_at: null })
    .eq('id', ownerId);
  if (cleared.error) throw new Error(`clearing the provisional flag: ${cleared.error.message}`);

  const owner = await signIn(OWNER_EMAIL);

  // 4. Catalogue. References first: assert_song_references_live (0103) refuses a
  // song whose artist, label or genre is not already live.
  const genres = await createReferences(owner, companyId, 'GENRE', GENRES);
  const labels = await createReferences(owner, companyId, 'LABEL', LABELS);
  const shows = await createReferences(owner, companyId, 'SHOW', SHOWS);
  const artists = await createReferences(
    owner,
    companyId,
    'ARTIST',
    ARTISTS.map((a) => a.name),
  );

  const albums = [];
  for (const album of ALBUMS) {
    albums.push(
      await rpc(owner, 'create_album', {
        p_company_id: companyId,
        p_title: album.title,
        p_release_date: album.released,
      }),
    );
  }

  const songs = await inPool(SONGS, CONCURRENCY, (song, index) => {
    const artist = ARTISTS[song.artist];
    return rpc(owner, 'create_song', {
      p_company_id: companyId,
      p_title: song.title,
      p_artist_id: artists[artist.name],
      p_label_id: labels[artist.label],
      p_genre_id: genres[artist.genre],
      p_nationality: artist.nationality,
      p_vocal: artist.vocal,
      p_duration_seconds: song.seconds,
      p_internal_code: `DEMO-${String(index + 1).padStart(3, '0')}`,
      p_album_id: song.album === null ? null : albums[song.album],
      p_isrc: `BRPTX${String(2_300_001 + index)}`,
    });
  });
  console.log(
    `  catalogue: ${ARTISTS.length} artists, ${albums.length} albums, ${songs.length} songs`,
  );

  // 5. The audience.
  const listeners = await inPool(
    Array.from({ length: LISTENER_COUNT }, (_, i) => i),
    CONCURRENCY,
    (index) => {
      const place = PLACES[index % PLACES.length];
      return rpc(owner, 'create_member', {
        p_company_id: companyId,
        p_full_name: fullName(index),
        // NOT A ROUTABLE NUMBER, and that is deliberate. The DDD and the leading
        // 9 are real so the column looks like the column does on air, but a
        // Brazilian mobile's second digit is 6-9 and this one is 0. Nothing here
        // can reach a person if an outbound integration is ever pointed at this
        // Station by mistake.
        p_phone: `+55${place.ddd}90${String(index).padStart(7, '0')}`,
        // Not everybody: a listener with no e-mail is the ordinary case on air,
        // and the screens have to survive it.
        p_email: index % 5 === 0 ? null : `${slugify(fullName(index))}.${index}@ouvinte.test`,
        p_birth_date: birthDate(index),
        p_city: place.city,
        p_state: place.state,
        p_discovery_source: pick(DISCOVERY_SOURCES),
      });
    },
    'listeners',
  );
  console.log(`  listeners: ${listeners.length}`);

  // 6. Prizes and stock.
  const prizes = [];
  for (const prize of PRIZES) {
    const id = await rpc(owner, 'create_prize', {
      p_company_id: companyId,
      p_name: prize.name,
      p_allows_return_to_stock: prize.returns,
    });
    await rpc(owner, 'record_stock_entry', {
      p_company_id: companyId,
      p_prize_id: id,
      p_type: 'INITIAL_ENTRY',
      p_quantity: prize.stock,
      p_note: 'Demonstração',
    });
    prizes.push(id);
  }

  // 7. Three promotions, in the three states a Station has open at once.
  const now = Date.now();

  const closed = await rpc(owner, 'create_promotion', {
    p_company_id: companyId,
    p_name: 'Promoção encerrada - show de sábado',
    p_starts_at: new Date(now - 33 * DAY).toISOString(),
    p_ends_at: new Date(now - 3 * DAY).toISOString(),
  });
  await rpc(owner, 'link_prize_to_promotion', {
    p_promotion_id: closed,
    p_prize_id: prizes[0],
    p_quantity: 3,
  });

  const live = await rpc(owner, 'create_promotion', {
    p_company_id: companyId,
    p_name: 'No ar agora - fim de semana no litoral',
    p_starts_at: new Date(now - 7 * DAY).toISOString(),
    p_ends_at: new Date(now + 21 * DAY).toISOString(),
  });
  await rpc(owner, 'link_prize_to_promotion', {
    p_promotion_id: live,
    p_prize_id: prizes[1],
    p_quantity: 2,
  });

  const scheduled = await rpc(owner, 'create_promotion', {
    p_company_id: companyId,
    p_name: 'Agendada - bastidores da turnê',
    p_starts_at: new Date(now + 10 * DAY).toISOString(),
    p_ends_at: new Date(now + 40 * DAY).toISOString(),
  });
  await rpc(owner, 'link_prize_to_promotion', {
    p_promotion_id: scheduled,
    p_prize_id: prizes[2],
    p_quantity: 4,
  });

  // 8. Entries. None at all in the scheduled one: apply_participation refuses a
  // participated_at outside [starts_at, ends_at), which is the rule saying a
  // promotion that has not opened cannot have had anybody in it.
  const closedEntries = await recordEntries(
    owner,
    closed,
    listeners.slice(0, CLOSED_ENTRIES),
    now - 33 * DAY,
    now - 3 * DAY,
    'entries (closed)',
  );
  const liveEntries = await recordEntries(
    owner,
    live,
    listeners.slice(LIVE_OFFSET, LIVE_OFFSET + LIVE_ENTRIES),
    now - 7 * DAY,
    now,
    'entries (live)',
  );
  report('entries', [...closedEntries, ...liveEntries]);

  // 9. The draw on the closed promotion, and two of the three prizes handed
  // over -- the third stays AWAITING_PICKUP so the delivery screen opens on both
  // states rather than on one.
  const draw = await rpc(owner, 'run_draw', { p_promotion_id: closed });
  const winners = await admin
    .from('winners')
    .select('id')
    .eq('draw_id', draw)
    .order('awarded_rank');
  if (winners.error) throw new Error(`reading winners: ${winners.error.message}`);
  for (const winner of (winners.data ?? []).slice(0, 2)) {
    await rpc(owner, 'deliver_prize', { p_winner_id: winner.id, p_note: 'Retirado na recepção' });
  }
  console.log(`  draw: ${(winners.data ?? []).length} winner(s), 2 delivered`);

  // 10. The requests. Last, deliberately: it is the step whose presence proves a
  // run got all the way to the end.
  await inPool(
    Array.from({ length: REQUEST_COUNT }, (_, i) => i),
    CONCURRENCY,
    (index) =>
      rpc(owner, 'create_music_request', {
        p_company_id: companyId,
        // Round-robin rather than a random draw: every listener then has at
        // least one, so no record opens on an empty tab.
        p_member_id: listeners[index % listeners.length],
        p_song_id: pick(songs),
        p_show_id: index % 4 === 0 ? null : shows[pick(SHOWS)],
        p_requested_at: new Date(now - pickInt(1, 30 * 24) * HOUR).toISOString(),
      }),
    'requests',
  );

  // 11. The privilege goes back. The account stays -- profiles and audit_logs
  // point at it -- but it is an ordinary user again from here.
  const demoted = await admin.from('platform_admins').delete().eq('user_id', provisionerId);
  if (demoted.error)
    throw new Error(`removing the temporary platform admin: ${demoted.error.message}`);
  console.log('  temporary platform admin removed');

  await summarise(organizationId);
  console.log(`\n  sign in at /login   ${OWNER_EMAIL} / ${PASSWORD}`);
  console.log(
    '  to take it back out: run scripts/unseed-hosted-demo.sql in the SQL editor\n' +
      `  (its first line names the Organization -- set it to "${ORGANIZATION}")\n`,
  );
}

// ---------------------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------------------

/**
 * A fixed number of workers pulling from one cursor. Sequential would be honest
 * too, but 2400 round trips to a hosted project one at a time is twenty minutes
 * of a script that must not be interrupted half-way.
 */
async function inPool(items, limit, fn, label) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
      done += 1;
      if (label && done % 100 === 0) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length}`);
      }
    }
  });
  await Promise.all(workers);
  if (label) process.stdout.write(`\r  ${label}: ${items.length}/${items.length}\n`);
  return results;
}

async function createReferences(client, companyId, kind, names) {
  const byName = {};
  for (const name of names) {
    byName[name] = await rpc(client, 'create_music_reference', {
      p_company_id: companyId,
      p_kind: kind,
      p_name: name,
    });
  }
  return byName;
}

/**
 * Spreads one entry per listener evenly across [from, to). Evenly rather than at
 * random because the instant has to stay strictly inside the window: a random
 * offset that rounds up to `to` is refused, and it would be refused on maybe one
 * run in fifty.
 *
 * Returns every status rather than assuming VALID -- record_participation
 * ANSWERS with DUPLICATE, TOO_SOON or OVER_LIMIT, it does not raise, so a run
 * that quietly recorded nothing would otherwise look identical to one that
 * worked.
 */
async function recordEntries(client, promotionId, memberIds, from, to, label) {
  const step = (to - from) / (memberIds.length + 1);
  return inPool(
    memberIds,
    CONCURRENCY,
    (memberId, index) =>
      rpc(client, 'record_participation', {
        p_promotion_id: promotionId,
        p_member_id: memberId,
        p_participated_at: new Date(from + step * (index + 1)).toISOString(),
        p_source: 'MANUAL',
      }),
    label,
  );
}

function report(label, outcomes) {
  const counts = {};
  for (const outcome of outcomes) {
    const status = outcome?.status ?? 'UNKNOWN';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([status, n]) => `${n} ${status}`);
  console.log(`  ${label}: ${parts.join(', ')}`);
}

async function createUser(email, name) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message ?? 'no user'}`);

  const profile = await admin.from('profiles').insert({ id: data.user.id, email, full_name: name });
  if (profile.error) throw new Error(`profile for ${email}: ${profile.error.message}`);

  return data.user.id;
}

async function signIn(email) {
  const client = createClient(URL_, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** One retry on a transport failure, then loudly. Over 2400 calls a single
 *  dropped socket is likely, and it is not a reason to abandon a half-written
 *  Organization on a hosted project. A refusal FROM Postgres is not retried:
 *  those are answers, not accidents. */
async function rpc(client, name, params) {
  for (let attempt = 0; ; attempt += 1) {
    let data, error;
    try {
      ({ data, error } = await client.rpc(name, params));
    } catch (cause) {
      if (attempt === 0) continue;
      throw new Error(`${name}: ${cause.message}`);
    }
    if (!error) return data;
    const transport =
      error.message === 'Failed to fetch' || error.message?.includes('fetch failed');
    if (transport && attempt === 0) continue;
    throw new Error(`${name}: ${error.message}`);
  }
}

/**
 * Names, distinct by construction, WITHOUT the runs an odometer produces.
 *
 * Read as a plain odometer -- first = i % 40, middle = i / 40, last = i / 1200 --
 * the three pools give 48,000 unique combinations, which is the property worth
 * having: no two listeners can collide, and members_email_unique never has to
 * arbitrate. But the high digits barely move. The first forty listeners all came
 * out "<something> Beatriz <something>", and every one of them under 1200 shared
 * a surname. Both are invisible in a count and unmissable on the first page of a
 * listing, which is the only place this data is ever going to be looked at.
 *
 * So the odometer stays, the INDEX FEEDING IT is permuted first, and the surname
 * comes off the raw index instead of the odometer's top digit. A stride coprime
 * with the total is a bijection over 0..N-1, so (first, middle) is still unique
 * per listener -- and once that pair is unique the surname is free to be
 * whatever moves fastest.
 *
 * Both halves of this are load-bearing, and each one alone produced a different
 * wrong answer: permuting without freeing the surname gave a thousand Ferreiras
 * (below 1200 listeners the top digit never turns at all), and freeing the
 * surname without permuting gave forty consecutive Beatrizes.
 */
const NAME_STRIDE = (() => {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  let stride = 137;
  while (gcd(stride, LISTENER_COUNT) !== 1) stride += 2;
  return stride;
})();

function fullName(index) {
  const scattered = (index * NAME_STRIDE) % LISTENER_COUNT;
  const first = FIRST[scattered % FIRST.length];
  const middle = MIDDLE[Math.floor(scattered / FIRST.length) % MIDDLE.length];
  // 7 is coprime with 40: all forty surnames before one repeats.
  const last = LAST[(index * 7) % LAST.length];
  return `${first} ${middle} ${last}`;
}

function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function birthDate(index) {
  const year = 2008 - ((index * 7) % 50);
  const month = ((index * 5) % 12) + 1;
  const day = ((index * 11) % 28) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function countRows(table, column, companyIds) {
  const { count, error } = await admin
    .from(table)
    .select(column, { count: 'exact', head: true })
    .in('company_id', companyIds);
  if (error) throw new Error(`counting ${table}: ${error.message}`);
  return count ?? 0;
}

async function summarise(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id, name')
    .eq('organization_id', organizationId)
    .order('name');
  if (companies.error) throw new Error(`reading stations: ${companies.error.message}`);

  console.log('');
  for (const company of companies.data ?? []) {
    const ids = [company.id];
    console.log(
      `  ${company.name}: ` +
        `${await countRows('member_company_links', 'member_id', ids)} listener(s), ` +
        `${await countRows('promotions', 'id', ids)} promotion(s), ` +
        `${await countRows('participations', 'id', ids)} entr(ies), ` +
        `${await countRows('songs', 'id', ids)} song(s), ` +
        `${await countRows('music_requests', 'id', ids)} request(s)`,
    );
  }
}

// exitCode rather than process.exit(): killing the process while the Supabase
// client still holds sockets aborts libuv on Windows, and the assertion it
// prints buries the one line that says what actually went wrong.
main().catch((cause) => {
  console.error(`\nseed:hosted failed - ${cause.message}`);
  console.error(
    'The Organization may be half-written. scripts/unseed-hosted-demo.mjs takes it back out.',
  );
  process.exitCode = 1;
});
