import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from '../src/lib/security/local-only.ts';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../tests/local-supabase.ts';

/**
 * Block 11c, D2. A demo Station with the whole cycle already visible.
 *
 * NOT `supabase/seed.sql`, deliberately: that file runs on every `db reset`,
 * which is what 1397 pgTAP assertions and 44 journeys start from. Putting rows
 * in front of them turns a demo convenience into a week of red suites whose
 * failures look like regressions in whatever block does the counting.
 *
 * Idempotent by Organization name: run it twice and nothing duplicates.
 *
 * IT DRIVES THE REAL RPCs ON REAL SESSIONS. They are permission-gated on
 * auth.uid(), so the service key would be refused rather than privileged; it is
 * used for exactly three things -- creating auth users, the platform_admins
 * insert no client may write (0006), and clearing the provisional-password flag
 * so the demo owner lands on a screen instead of on /change-password.
 */
const URL = process.env.SEED_SUPABASE_URL ?? LOCAL_SUPABASE_URL;
const SERVICE_KEY = process.env.SEED_SERVICE_ROLE_KEY ?? LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SEED_ANON_KEY ?? LOCAL_SUPABASE_ANON_KEY;

// Applied to whatever it ended up with, override or default, and before any
// client is built. The override is deliberately not called
// NEXT_PUBLIC_SUPABASE_URL, so a shell carrying the hosted environment cannot
// steer this script by accident.
//
// Caught here rather than left to throw: this runs at module scope, outside
// main()'s catch, and an uncaught throw prints a stack trace over the one
// sentence that actually tells the operator what happened.
try {
  assertLocalSupabase(URL);
} catch (cause) {
  console.error(`\nseed:demo refused to run - ${cause.message}`);
  process.exit(1);
}

const ORGANIZATION = 'Demo Broadcasting';
const STATION = 'Demo FM';
const SECOND_STATION = 'Demo AM';
const ADMIN_EMAIL = 'admin@demo.test';
const OWNER_EMAIL = 'owner@demo.test';
const PASSWORD = 'Demo-password-1';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Determinism.
//
// Every choice this script makes that is not spelled out in the tables below --
// which listener gets which song, what time a request arrived -- comes from
// here and not from Math.random(). A demo whose contents change on every
// `db:reset` cannot be used to reproduce anything: a screen that misbehaves on
// one listener's data is gone the next time somebody looks for it.
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
// The data.
// ---------------------------------------------------------------------------

/** Fifty distinct names -- distinct is the point: `members` holds a unique index
 *  per Organization on e-mail, and the addresses below are derived from these. */
const LISTENER_NAMES = [
  'Ana Beatriz Ferreira',
  'Bruno Sampaio Rocha',
  'Carla Menezes Duarte',
  'Diego Antunes Vilar',
  'Elaine Prado Cordeiro',
  'Fábio Nogueira Lins',
  'Gabriela Tavares Pinto',
  'Heitor Salgado Muniz',
  'Isabela Quintana Reis',
  'João Vitor Camargo',
  'Karina Bastos Leal',
  'Leandro Peixoto Faria',
  'Mariana Coutinho Alves',
  'Nelson Braga Teixeira',
  'Olívia Rezende Campos',
  'Paulo César Amorim',
  'Queila Fontes Barreto',
  'Rafael Mendonça Vieira',
  'Simone Aguiar Portela',
  'Thiago Belmonte Cruz',
  'Úrsula Kaminski Lopes',
  'Vinícius Aragão Serra',
  'Wanda Siqueira Moraes',
  'Xênia Portugal Dias',
  'Yuri Falcão Bandeira',
  'Zilda Marcondes Neves',
  'Adriana Pontes Guerra',
  'Bernardo Ottoni Xavier',
  'Cristiane Vilela Bomfim',
  'Daniel Escobar Trindade',
  'Érica Fagundes Padilha',
  'Felipe Zanetti Moura',
  'Giovana Rabelo Sarmento',
  'Hugo Valadares Pimentel',
  'Inês Carvalhães Brito',
  'Júlio Bittencourt Lara',
  'Kelly Andrade Vasques',
  'Lucas Beltrão Furtado',
  'Márcia Godoy Ferrari',
  'Natan Ribas Cavalcanti',
  'Otávio Lemos Bandeira',
  'Patrícia Seixas Nunes',
  'Quirino Batista Alencar',
  'Renata Feitosa Machado',
  'Sérgio Malta Andrade',
  'Tatiana Ourique Bezerra',
  'Ulisses Praxedes Gomes',
  'Vera Lúcia Sobral',
  'Wagner Delgado Motta',
  'Yasmin Correia Bulhões',
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

/** Invented acts. Genre, label, nationality and vocal live on the artist rather
 *  than on each song, because that is how they actually correlate -- a catalogue
 *  where every track rolls its own genre reads as noise on the Music dashboard. */
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
    name: 'Grupo Fundo de Quintal Falso',
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

/** artist: index into ARTISTS. album: index into ALBUMS, or null for a single. */
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
  { title: 'Duas Viola', artist: 9, album: null, seconds: 229 },
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
  { name: 'Par de ingressos, show de sábado', stock: 20, returns: true },
  { name: 'Fim de semana para dois no litoral', stock: 6, returns: false },
  { name: 'Encontro com a banda nos bastidores', stock: 10, returns: true },
];

const LISTENER_COUNT = LISTENER_NAMES.length; // 50
const REQUEST_COUNT = 100;
const ENTRIES_PER_LIVE_PROMOTION = 15;

async function main() {
  const existing = await admin
    .from('organizations')
    .select('id')
    .eq('name', ORGANIZATION)
    .maybeSingle();

  if (existing.data) {
    // "The Organization exists" is NOT the same question as "the seed
    // finished", and the difference cost a debugging round on the very first
    // run: provisioning succeeded, a later step failed, and the next run
    // then reported success over an Organization with nothing in it.
    //
    // There is no compensating teardown here on purpose. Deleting the users
    // this script creates runs into non-cascading foreign keys and the
    // at-least-one-owner trigger, so a half-written cleanup would leave a
    // different mess and claim to have tidied. `db:reset` is one command and it
    // is exact.
    const complete = await isComplete(existing.data.id);
    if (!complete) {
      console.error(
        `"${ORGANIZATION}" exists but its seeding did not finish -- an earlier run failed part-way.\n` +
          'Run `npm run db:reset` (then restart Kong) and seed again.',
      );
      process.exit(1);
    }
    console.log(`"${ORGANIZATION}" is already seeded. Nothing to do.`);
    await summarise(existing.data.id);
    printSignIn();
    return;
  }

  // 1. The platform admin. `platform_admins` accepts no client write (0006),
  // so this insert is what the service key exists for.
  const adminUser = await createUser(ADMIN_EMAIL, 'Demo Administrator');
  const promoted = await admin.from('platform_admins').insert({ user_id: adminUser });
  if (promoted.error) throw new Error(`platform_admins insert: ${promoted.error.message}`);

  // 2. The customer group, provisioned exactly as the console provisions one --
  // signed in as the admin, because provision_organization is SECURITY DEFINER
  // and re-checks is_platform_admin() against auth.uid(), which the service key
  // has none of.
  //
  // TWO CALLS SINCE BLOCK 16, WHERE THERE WAS ONE. provision_customer created an
  // Organization and a Company together and was dropped in 0157: a customer's
  // radio count is not known when the customer is taken on. Both Stations below
  // now arrive the same way, through add_company, which is what the console
  // does.
  const adminSession = await signIn(ADMIN_EMAIL);
  const ownerUser = await createUser(OWNER_EMAIL, 'Demo Owner');
  const organizationId = await rpc(adminSession, 'provision_organization', {
    p_user_id: ownerUser,
    p_organization_name: ORGANIZATION,
  });

  const companyId = await rpc(adminSession, 'add_company', {
    p_organization_id: organizationId,
    p_name: STATION,
    p_timezone: 'America/Sao_Paulo',
  });

  // 3. A second Station, through the same RPC. Left empty on purpose: it is
  // what proves the Station switcher switches.
  await rpc(adminSession, 'add_company', {
    p_organization_id: organizationId,
    p_name: SECOND_STATION,
    p_timezone: 'America/Sao_Paulo',
  });

  // 4. The provisional password expires and the middleware forces a change
  // before any screen (src/middleware.ts). Cleared here so `npm run dev` opens
  // straight onto a full screen, which is the entire point of a demo seed.
  const cleared = await admin
    .from('profiles')
    .update({ must_change_password: false, provisional_expires_at: null })
    .eq('id', ownerUser);
  if (cleared.error) throw new Error(`clearing the provisional flag: ${cleared.error.message}`);

  const owner = await signIn(OWNER_EMAIL);

  // 5. The music catalogue: references first, then albums, then songs. In that
  // order because create_song takes ids, and assert_song_references_live (0103)
  // refuses one whose artist, label or genre is not live.
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

  const songs = [];
  for (const [index, song] of SONGS.entries()) {
    const artist = ARTISTS[song.artist];
    songs.push(
      await rpc(owner, 'create_song', {
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
        // songs_isrc_shape: two letters, three alphanumerics, seven digits.
        p_isrc: `BRPTX${String(2_300_001 + index)}`,
      }),
    );
  }
  console.log(
    `  catalogue: ${ARTISTS.length} artists, ${albums.length} albums, ${songs.length} songs`,
  );

  // 6. The listeners. Registered on Demo FM; `members` itself is
  // Organization-scoped (0031) and the link is what makes them reachable here.
  const listeners = [];
  for (const [index, fullName] of LISTENER_NAMES.entries()) {
    const place = PLACES[index % PLACES.length];
    listeners.push(
      await rpc(owner, 'create_member', {
        p_company_id: companyId,
        p_full_name: fullName,
        // Unique by construction: the index is inside the subscriber number,
        // and members_phone_unique is per Organization on the normalised form.
        p_phone: `+55${place.ddd}9${String(80_000_000 + index).padStart(8, '0')}`,
        // Deliberately not everybody. A listener with no e-mail is the ordinary
        // case on air, and the screens have to survive it.
        p_email: index % 5 === 0 ? null : `${slugify(fullName)}@listener.test`,
        p_birth_date: birthDate(index),
        p_city: place.city,
        p_state: place.state,
        p_discovery_source: pick(DISCOVERY_SOURCES),
      }),
    );
  }
  console.log(`  listeners: ${listeners.length}`);

  // 7. Prizes and the stock to draw from.
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
      p_note: 'Demo seed',
    });
    prizes.push(id);
  }

  // 8. Three promotions in the three states a Station actually has open at once.
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

  // 9. Entries. Fifteen each in the two promotions that can hold them, and none
  // at all in the scheduled one -- apply_participation (0054:144) refuses a
  // participated_at outside [starts_at, ends_at), which is the rule saying a
  // promotion that has not opened cannot have had anybody in it. Backdating the
  // closed one's entries is fine and is what the same check makes possible.
  //
  // The two slices overlap by seven people on purpose: a listener who entered
  // twice is what the Audience dashboard's repeat figures are counting.
  await recordEntries(owner, closed, listeners.slice(0, 15), now - 33 * DAY, now - 3 * DAY);
  await recordEntries(owner, live, listeners.slice(8, 23), now - 7 * DAY, now);

  // 10. The closed promotion's draw, and the prize handed to two of the three
  // winners. The third is left AWAITING_PICKUP so the delivery screen opens on
  // both states rather than on one.
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

  // 11. The requests. Last, and that is what isComplete() below leans on.
  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    await rpc(owner, 'create_music_request', {
      p_company_id: companyId,
      // Round-robin over the listeners rather than a random draw: every one of
      // the fifty then has at least one request, so no listener's record opens
      // on an empty tab.
      p_member_id: listeners[index % listeners.length],
      p_song_id: pick(songs),
      // A quarter arrive with no programme attached, which is what a request
      // taken off a message rather than off the studio log looks like.
      p_show_id: index % 4 === 0 ? null : shows[pick(SHOWS)],
      p_requested_at: new Date(now - pickInt(1, 30 * 24) * HOUR).toISOString(),
    });
  }

  await summarise(organizationId);
  printSignIn();
}

/** Creates one kind of music reference and returns a name -> id map. */
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
 * random because the interval has to stay strictly inside the window: a random
 * offset that rounds up to `to` is refused by apply_participation with a message
 * about a promotion that was not taking entries, and it would be refused on
 * maybe one run in fifty.
 */
async function recordEntries(client, promotionId, memberIds, from, to) {
  const step = (to - from) / (memberIds.length + 1);
  for (const [index, memberId] of memberIds.entries()) {
    await rpc(client, 'record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date(from + step * (index + 1)).toISOString(),
      p_source: 'MANUAL',
    });
  }
}

async function createUser(email, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message ?? 'no user'}`);

  // provision_organization expects the profile to exist already, exactly as
  // src/services/organizations.ts writes it before calling.
  const profile = await admin
    .from('profiles')
    .insert({ id: data.user.id, email, full_name: fullName });
  if (profile.error) throw new Error(`profile for ${email}: ${profile.error.message}`);

  return data.user.id;
}

async function signIn(email) {
  const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** Calls an RPC and fails loudly rather than returning undefined into the next step. */
async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/** Accents out, spaces to dots. members_email_unique is on the normalised form. */
function slugify(fullName) {
  return fullName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

/** Between 18 and 67, derived from the index so a rerun produces the same ages. */
function birthDate(index) {
  const year = 2008 - ((index * 7) % 50);
  const month = ((index * 5) % 12) + 1;
  const day = ((index * 11) % 28) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A finished seed has both Stations and music requests in the first one.
 * Checking the LAST thing a run writes rather than the first is what makes this
 * an honest question: anything less means the run stopped somewhere in the
 * middle. It used to ask about listeners, which stopped being the last step the
 * moment the catalogue and the hundred requests were added after them.
 */
async function isComplete(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id')
    .eq('organization_id', organizationId);
  if ((companies.data ?? []).length < 2) return false;

  return (
    (await countRows(
      'music_requests',
      'id',
      (companies.data ?? []).map((c) => c.id),
    )) > 0
  );
}

/**
 * Listeners go through member_company_links, because a Member belongs to the
 * ORGANIZATION and is linked to Stations (Block 3, the shared-listener design
 * H3) -- `members` has no company_id at all.
 *
 * The error is checked rather than ignored, and that is not ceremony: the first
 * version of this filtered `members.company_id`, which does not exist, and
 * PostgREST answered with an error that a `?? 0` turned into a summary reading
 * "0 listener(s)" over ten rows that were sitting right there.
 */
async function countRows(table, column, companyIds) {
  const { count, error } = await admin
    .from(table)
    .select(column, { count: 'exact', head: true })
    .in('company_id', companyIds);
  if (error) throw new Error(`counting ${table}: ${error.message}`);
  return count ?? 0;
}

const countListeners = (companyIds) => countRows('member_company_links', 'member_id', companyIds);

async function summarise(organizationId) {
  const companies = await admin
    .from('companies')
    .select('id, name')
    .eq('organization_id', organizationId)
    .order('name');

  for (const company of companies.data ?? []) {
    const ids = [company.id];
    const listeners = await countListeners(ids);
    const promotions = await countRows('promotions', 'id', ids);
    const songs = await countRows('songs', 'id', ids);
    const requests = await countRows('music_requests', 'id', ids);
    const entries = await countRows('participations', 'id', ids);
    console.log(
      `  ${company.name}: ${listeners} listener(s), ${promotions} promotion(s), ` +
        `${entries} entr(ies), ${songs} song(s), ${requests} request(s)`,
    );
  }
}

function printSignIn() {
  console.log(`\n  the product: http://localhost:3000/login  ${OWNER_EMAIL} / ${PASSWORD}`);
  console.log(`  the console: http://localhost:3000/admin    ${ADMIN_EMAIL} / ${PASSWORD}`);
}

main().catch((cause) => {
  console.error(`\nseed:demo failed - ${cause.message}`);
  process.exit(1);
});
