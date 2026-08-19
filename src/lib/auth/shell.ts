import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { ICONS, type ShellUser } from '@/components/layout/app-shell';
import type { NavSection } from '@/components/layout/sidebar-nav';
import { getTranslations } from 'next-intl/server';
import { NAV_COOKIE, parseExpanded } from '@/lib/nav/disclosure';
import { NAV_COLLAPSED_COOKIE, parseCollapsed } from '@/lib/nav/collapse';

/**
 * Everything the chrome needs, resolved once per request. Both the member area
 * and the platform console call this, so the navigation cannot drift between
 * them — and the platform links only appear for a platform admin, which is a
 * convenience, not the guard: the admin layout still redirects and every RPC
 * re-checks in its own body.
 */
export async function getShellContext(): Promise<{
  sections: NavSection[];
  user: ShellUser;
  /**
   * Block 20b, D5. Which sections this caller has expanded, read on the SERVER
   * so the sidebar arrives in the right state. Read in the browser instead, it
   * would render open and collapse after hydration — a flash on every single
   * navigation, on every screen, since the shell wraps all of them.
   */
  expandedSections: string[];
  /**
   * Block 27. Whether the sidebar is folded to a rail of icons — read on the
   * SERVER for the identical reason expandedSections is: read in the browser
   * instead, the chrome arrives at full width and snaps narrow after hydration,
   * a flash on every navigation, on every screen, since the shell wraps all of
   * them.
   *
   * A SEPARATE cookie from the disclosure one, and separate on purpose: folding
   * must not disturb which sections are open, and expanding must restore exactly
   * what was open before. See src/lib/nav/collapse.ts.
   */
  collapsed: boolean;
}> {
  // Block 12a. The navigation is the one place a person sees every area of the
  // product at once, so its wording is the first thing that has to speak their
  // language. Fetched here because this function is already async and already
  // the single builder of the tree.
  const t = await getTranslations('nav');

  const cookieStore = await cookies();
  const expandedSections = parseExpanded(cookieStore.get(NAV_COOKIE)?.value);
  const collapsed = parseCollapsed(cookieStore.get(NAV_COLLAPSED_COOKIE)?.value);

  const supabase = await createUserClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: isAdmin }] = await Promise.all([
    supabase.from('profiles').select('email, full_name').eq('id', user.id).single(),
    supabase.rpc('is_platform_admin'),
  ]);

  const sections: NavSection[] = [
    {
      key: 'overview',
      label: t('overview'),
      items: [{ href: '/app', label: t('myStations'), icon: ICONS.radio }],
    },
    {
      key: 'dashboards',
      // Visible to every member, including those holding members.view,
      // music.view and promotions.view in no Station at all — the same
      // courtesy every section below extends. Each of the three pages
      // redirects at the top of its own render for a caller who holds its
      // permission nowhere, and the three functions in 0118–0120 re-check
      // it themselves regardless of that redirect, raising 42501 rather
      // than returning a page of zeros. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: t('dashboards'),
      items: [
        // "... overview", not the bare domain word, and the same rule the
        // Inventory section below records for its own rename (Block 6d): a
        // SECTION and an ITEM spelling the same word read as one link
        // rendered twice. This block shipped three of them at once — every
        // one of "Audience", "Music" and "Promotions" is already a section
        // label further down THIS SAME sidebar, so the shipped nav offered
        // two "Audience" entries (one a link here, one a heading over
        // Members and Participations), two "Music" and two "Promotions".
        // Unlike Inventory > Stock, the href is not what changed; only the
        // accessible name is, and tests/e2e/dashboards.spec.ts selects on
        // it by role and name, so its three getByRole('link') calls moved
        // with this.
        { href: '/dashboards/audience', label: t('audienceOverview'), icon: ICONS.chart },
        { href: '/dashboards/music', label: t('musicOverview'), icon: ICONS.music },
        { href: '/dashboards/promotions', label: t('promotionsOverview'), icon: ICONS.megaphone },
      ],
    },
    {
      key: 'audience',
      // MOVED ABOVE INVENTORY IN BLOCK 26, on the owner's ruling. The four
      // operational sections now read in the order the work happens: who is
      // listening, what is being promised them, what there is to hand over, and
      // what is on the air. Inventory, which used to open this run, is now below
      // Promotions — the other half of the same move.
      //
      // Visible to every member, including those holding members.view
      // nowhere in the Organization — the same courtesy Inventory below
      // extends for inventory.view. /members redirects at the top of its own
      // page for anyone holding members.view nowhere (access.ts's
      // canViewAudience), and members_select_reachable plus its four sibling
      // policies (0035_rls_members.sql) filter every read underneath
      // regardless of that redirect. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: t('audience'),
      items: [
        { href: '/members', label: t('members'), icon: ICONS.headphones },
        // Block 26, on the owner's ruling: Requests and Programmes swapped
        // places. Both are things this section already held; what changed is
        // which one a reader meets first, and a request is the commoner errand
        // — it arrives all day, while a programme is edited when the schedule
        // does.
        //
        // Block 20b, D1, on the owner's ruling, is why it is in this section at
        // all. This is the listing of PEOPLE asking for something, and it
        // belongs beside the audience rather than beside the recordings it
        // happens to reference — the same argument Block 6c used to move
        // Participations here out of Promotions. (Block 26 has now moved
        // Participations back, which does not disturb that reasoning: it moved
        // for a different one, recorded on its own row under Promotions.)
        //
        // ICONS.music rather than ICONS.ticket, which is what it carried under
        // the catalogue: `music` is unused in Audience and a song request is
        // the one thing here that is about a recording; its other uses are in
        // Dashboards and Catalogue, distant sections. The clash `ticket` would
        // have caused is gone with Participations, but the glyph stays — it is
        // the better one for the row regardless.
        { href: '/music/requests', label: t('requests'), icon: ICONS.music },
        // PROGRAMMES LEFT THIS SECTION IN BLOCK 27, for Catalog, on the owner's
        // ruling — reversing where Block 18 filed it. Its full reasoning, and
        // what the move did to the permission mismatch Block 18 recorded as a
        // cost, is on its new row under `catalog` below. Noted here rather than
        // silently absent: this section held three items for eight blocks, and a
        // reader comparing against an older screenshot should find out why it
        // holds two, in the file that decides it.
      ],
    },
    {
      key: 'promotions',
      // Visible to every member, on the same courtesy the sections above
      // extend: /promotions redirects at the top of its own page for anyone
      // holding promotions.view in no Station, and 0044's three select
      // policies plus every RPC in 0042/0043 re-check has_permission
      // regardless of that redirect. Hiding a link is a courtesy; the boundary
      // is in the database.
      label: t('promotions'),
      items: [
        { href: '/promotions', label: t('promotions'), icon: ICONS.megaphone },
        // BACK HERE IN BLOCK 26, on the owner's ruling, after Block 6c moved it
        // to Audience on the opposite one. Both readings are true — a
        // participation is a person, and it is also an entry in a promotion —
        // and what settled it is the neighbour: this row now sits directly above
        // Pickups, and the two are one errand read end to end (somebody entered,
        // somebody won, somebody collects). Under Audience it sat beside Members,
        // where the shared word was "people" and nothing followed on from it.
        //
        // The courtesy is unchanged by the move: /participations redirects at the
        // top of its own page for anyone holding participations.view in no
        // Station, 0053's policies and list_participations' own two-permission
        // gate (0090) filter every read regardless, and the write RPCs re-check
        // has_permission in their own bodies (0054).
        //
        // ICONS.ticket travels with it and collides with nothing here: this
        // section holds megaphone above and box below. It was chosen in Audience
        // against `music`, and the reason it kept that glyph rather than gaining
        // a promotions-flavoured one is that a participation IS a ticket in a
        // draw, whichever heading it files under.
        { href: '/participations', label: t('participations'), icon: ICONS.ticket },
        // Block 6d, Task 9. /pickups redirects nobody by itself — it opens on
        // whichever Station listCompanyAccess resolves promotions.view in,
        // the same courtesy every item in this section already extends — and
        // list_pickups (0095) re-checks that permission itself regardless.
        // ICONS.box rather than a new path: it is the box/package shape
        // ICONS already declares for Inventory, and reusing it here is
        // unlike the ticket/megaphone case just above — those two sit on
        // adjacent ROWS OF THIS SAME SECTION, where one icon on both would
        // read as one link rendered twice, while Inventory is a different
        // section entirely, so the two never appear side by side.
        { href: '/pickups', label: t('pickups'), icon: ICONS.box },
      ],
    },
    {
      key: 'inventory',
      // MOVED HERE IN BLOCK 26, on the owner's ruling — it opened the
      // operational run until then, above Audience. It now follows Promotions,
      // which is what asks for the stock: a prize is registered because
      // something is being given away, so the section that spends comes before
      // the section that counts.
      //
      // Visible to every member, including those holding no inventory
      // permission in any Station at all — the same courtesy Team and Roles
      // below already extend. /inventory redirects at the top of its own
      // page for anyone holding inventory.view nowhere, and every RPC in
      // 0027/0028 (and the select policies in 0029) re-check has_permission
      // themselves regardless of that redirect. Hiding a link is a courtesy;
      // the boundary is in the database.
      label: t('inventory'),
      items: [
        // Same href as before Block 6d, Task 10 — only the label changed,
        // from 'Inventory' to 'Stock', so no existing href anywhere breaks.
        // The accessible name DID change, and did break one thing that
        // selected on it: tests/e2e/inventory-flow.spec.ts's own
        // getByRole('link', { name: ... }) had to be updated from 'Inventory'
        // to 'Stock' alongside this rename. 'Inventory' is now the SECTION
        // name, one level up, and having both the section and its first item
        // spell the same word read as one link rendered twice; 'Stock' is
        // what this item actually lists.
        { href: '/inventory', label: t('stock'), icon: ICONS.box },
        // Block 26, on the owner's ruling. DIRECTLY BELOW STOCK, because a
        // category is the first field on a prize: the screen above is where an
        // operator lands, and this is what its second column already says.
        //
        // The screen replaces a button. A category could be registered from a
        // dialog on Stock and nothing else — no list, no rename, no way to
        // retire one — and every category is also a filter option on that same
        // screen, so a label an operator could only ever add was a filter list
        // that could only ever grow. Registering one mid-prize survives, inside
        // the Register Prize dialog, next to the picker that turned out to be
        // missing it.
        //
        // /inventory/categories redirects nobody by itself: it opens on
        // whichever Station listCompanyAccess resolves inventory.view in, the
        // same courtesy every item in this section already extends, and 0029's
        // select policy plus both doors in 0202 re-check the permission
        // themselves regardless.
        //
        // ICONS.tag rather than a new path. Its only other use is Catalogue >
        // Genres, a distant section, so it never sits adjacent to itself — the
        // whole of the rule this file records for box, building and shield. A
        // category IS a tag, which is exactly what the glyph means there too.
        { href: '/inventory/categories', label: t('categories'), icon: ICONS.tag },
        // Block 24, item 7. Who the prizes come from.
        //
        // MOVED ABOVE MOVEMENTS IN BLOCK 27, on the owner's ruling. Block 24 put
        // it last and argued the position: "the reference list the others consume
        // rather than a place stock is counted or moved". The owner's order reads
        // the section the other way round and it is the better reading — Stock,
        // Categories and Vendors are the three lists an operator maintains, and
        // Movements is the ledger those three produce. A ledger interrupted by a
        // reference list was the odd one out.
        //
        // /inventory/vendors redirects nobody by itself: it opens on whichever
        // Station listCompanyAccess resolves inventory.view in, the same
        // courtesy the items above already extend, and 0198's select policy
        // plus both doors in 0199 re-check the permission themselves regardless.
        //
        // ICONS.building rather than a new path. Its two other uses — Catalogue
        // > Labels and Platform > Organizations — are in distant sections, so it
        // never sits adjacent to itself, which is the whole of the rule this
        // file records for box and shield. A supplier IS a company, which is
        // exactly what the glyph means in Catalogue > Labels.
        { href: '/inventory/vendors', label: t('vendors'), icon: ICONS.building },
        // Block 6d, Task 10. /inventory/movements redirects nobody by
        // itself — it opens on whichever Station listCompanyAccess resolves
        // inventory.view in, the same courtesy the items above already
        // extend — and list_movements (0096) re-checks that permission
        // itself regardless. ICONS.inbox rather than ICONS.box: this Record
        // has no dedicated ledger/list glyph, so the choice is among what
        // already exists, and reusing box here would put one icon on two rows
        // of this SAME section, which reads as one link rendered twice.
        // (Block 26 put Categories between the two, and Block 27 then put
        // Vendors there as well, so they are two rows apart; the rule is about
        // the section, not only about neighbours, and the glyph earns its place
        // on its own.) inbox's tray-with-a-flow shape is otherwise idle in this
        // section (its only other use is Platform > Contact requests, a
        // different section entirely, the same non-adjacency that already lets
        // box itself serve both Inventory and Pickups) and reads reasonably as
        // things moving in and out, which a stock ledger is.
        //
        // LAST IN THE SECTION SINCE BLOCK 27, which is what it should have been
        // all along: it is the only row here that is read rather than
        // maintained.
        { href: '/inventory/movements', label: t('movements'), icon: ICONS.inbox },
      ],
    },
    {
      key: 'catalog',
      // Visible to every member, including those holding no music permission
      // in any Station at all — the same courtesy Inventory, Audience and
      // Promotions already extend. Each of the three pages redirects at the
      // top of its own render for anyone holding music.view nowhere, the
      // select policies in 0099 cut every read to the Stations that do hold
      // it, and every RPC in 0100/0101 re-checks has_permission in its own
      // body. Hiding a link is a courtesy; the boundary is in the database.
      label: t('catalog'),
      items: [
        { href: '/music/songs', label: t('songs'), icon: ICONS.music },
        { href: '/music/artists', label: t('artists'), icon: ICONS.users },
        // Block 20b, D2. These three replace the single "Catalog" item, which
        // could not survive the section's rename: a section and an item
        // spelling the same word read as one link rendered twice, the rule this
        // file already records for Inventory > Stock and for the three
        // Dashboards entries.
        //
        // Block 20c. These are the routes: `/catalog/labels`, `/catalog/genres`
        // and `/catalog/albums`, three real screens rather than three tabs of
        // one. The `?tab=` version was an interim — 20b shipped the navigation
        // ahead of the screens it would eventually point at, and the design
        // spec's §2 D2 amendment records why: 20c's three routes did not exist
        // yet, so the sidebar had nowhere else to send anybody. ICONS.building
        // for a label because a label is a company and `building`'s only other
        // use is Platform > Organizations, a distant section; `tag` and `disc`
        // are new (app-shell.tsx says why).
        //
        // BLOCK 27 SPREAD THEM OUT, on the owner's order for the whole section:
        // Albums moves up beside Artists, and Record labels down past the two
        // classification lists. Nothing about the three screens changed.
        { href: '/catalog/albums', label: t('albums'), icon: ICONS.disc },
        // Block 27, renamed in Block 28 on the owner's correction. A songwriter
        // is who WROTE the song, beside the artist rather than instead of it:
        // the artist PERFORMS the recording, and the two are routinely
        // different people. Directly above Genres, because this row and that
        // one answer neighbouring questions and an operator setting one usually
        // sets the other.
        //
        // /catalog/songwriters redirects nobody by itself: it opens on whichever
        // Station listCompanyAccess resolves music.view in, the same courtesy
        // every item in this section already extends, and 0205's select policy
        // plus 0100's three doors re-check the permission themselves regardless.
        //
        // ICONS.pen is NEW rather than a reuse, and TWO neighbours make that
        // matter: `tag` is Genres, the very next row, and `users` is Artists,
        // two rows up — and the artist/songwriter distinction is the whole
        // reason this row was renamed, so sharing a glyph with it would undo in
        // the sidebar what the rename did everywhere else.
        { href: '/catalog/songwriters', label: t('songwriters'), icon: ICONS.pen },
        { href: '/catalog/genres', label: t('genres'), icon: ICONS.tag },
        { href: '/catalog/labels', label: t('labels'), icon: ICONS.building },
        // MOVED HERE FROM AUDIENCE IN BLOCK 27, on the owner's ruling, reversing
        // where Block 18 filed it. Both readings are true — a programme is made
        // for listeners, and it is also the slot the catalogue is played in — and
        // what settles it is the neighbour: a programme is edited when the
        // schedule is, which is the same errand as curating the songs above it.
        // Under Audience it sat beside Members, where the shared word was
        // "people" and nothing followed on from it.
        //
        // THE PERMISSION STILL DOES NOT MOVE WITH THE SCREEN, and now it agrees
        // with where the screen sits. `shows` carries one policy, gated on
        // music.view — which is THIS section's permission. Block 18's §5 recorded
        // the mismatch as a cost of filing it under Audience (a member who
        // administers the audience and holds nothing in music saw the link and
        // found nothing behind it); the move removes it rather than working
        // around it, and no permissions migration was needed to do so.
        //
        // ICONS.radio travels with it and collides with nothing here: this
        // section holds music, users, disc, folder, tag, building and shield. Its
        // only other use is Overview > My stations, a distant section.
        { href: '/shows', label: t('programmes'), icon: ICONS.radio },
        // Last in the section on purpose: it is the destructive one, and a
        // sidebar is read top to bottom. Every other Catalog item above is a
        // place to build (register a song, an artist, a label, a genre, an
        // album); this is the only place to collapse two records into one,
        // irreversibly (0106's apply_music_merge — see merge-panel.tsx's own
        // comment). ICONS.shield rather than a new path: it is already
        // declared for Roles, in a different section entirely (Organization),
        // so the two never sit adjacent — the same non-adjacency Pickups'
        // reuse of ICONS.box relies on, two comments above. Its guard-like
        // shape reads reasonably as the one screen in Catalog that asks for
        // care.
        { href: '/music/maintenance', label: t('maintenance'), icon: ICONS.shield },
      ],
    },
    {
      // THE KEY STAYS 'templates' THOUGH THE SECTION IS NOW CALLED MESSAGES,
      // and that is not an oversight to tidy up later. `NavSection.key`'s own
      // comment (components/layout/sidebar-nav.tsx) states the rule this is the
      // first real test of: the disclosure cookie is keyed on it, so renaming
      // the key would forget which sections every operator had open, on their
      // next page load, for a copy change they did not ask about. The label is
      // what a member reads; the key is what the browser remembers.
      key: 'templates',
      // Visible to every member, including those holding NEITHER permission
      // this section's four rows answer to, in no Station at all -- the same
      // courtesy every section above extends. FIX ROUND 1, F10: not "both
      // pages" any more -- Promo Messages and Templates redirect at the top
      // of their own render for anyone holding templates.view nowhere
      // (0109's and 0110's select policies cut every read to the Stations
      // that do hold it, and all four doors in 0113 re-check templates.manage
      // in their own bodies); Send lists and Campaigns do the identical
      // redirect for messaging.view, under 0238's and 0242's own select
      // policies, with messaging.send/messaging.manage re-checked inside
      // their own doors (0239, 0243) the same way. Two permissions, two
      // pairs of rows, one courtesy. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: t('messages'),
      items: [
        // FOUR ITEMS NOW, WHERE BLOCK 29's original design named five and
        // this comment once said two: Campaigns (below) and Send lists
        // arrived one pass each, WITH THE SCREENS THEY POINT AT, rather than
        // in one shot up front -- Block 20b shipped navigation ahead of its
        // destinations and its own report calls that the error of the block,
        // three sidebar rows that answered a click with a 404 being worse
        // than three rows nobody had yet. Only Schedules and Message History
        // remain unbuilt.
        //
        // ICONS.message is the Templates block's own: this is the one section
        // about WORDS rather than records, and nothing already declared meant
        // that (see the path's own comment in app-shell.tsx). It stays with
        // this row through the rename, because the row's SUBJECT did not
        // change — only its name did.
        { href: '/messages/promo', label: t('promoMessages'), icon: ICONS.message },
        // ICONS.megaphone rather than message again: these two sit on ADJACENT
        // ROWS OF THIS SAME SECTION, which is exactly the case the Audience
        // section's ticket/megaphone comment warns against — one icon on both
        // would read as one link rendered twice. megaphone is otherwise used
        // only by Promotions, a different section entirely, the same
        // non-adjacency that already lets box serve both Inventory and
        // Pickups. Its shape reads reasonably here: a registered template is
        // the only thing that lets a Station SPEAK FIRST rather than answer.
        { href: '/messages/templates', label: t('templates'), icon: ICONS.megaphone },
        // Block 29d-1, Task 6. LAST IN THE SECTION: it is the newest capability
        // here and reads a list built FROM the two rows above it as much as
        // from Audience -- Ouvintes, Pedidos and Participações are all it can
        // be cut from (the empty state on /messages/lists itself names the
        // three) -- so this row is where those journeys end up.
        //
        // Visible to every member, the same courtesy every entry in this
        // section already extends: /messages/lists redirects at the top of
        // its own render for anyone holding messaging.view nowhere, and
        // 0238's own select policy filters every read regardless of that
        // redirect. Hiding a link is a courtesy; the boundary is in the
        // database.
        //
        // ICONS.list is new for this row -- see its own comment in
        // app-shell.tsx for why neither message nor megaphone, its two
        // neighbours here, could serve instead.
        { href: '/messages/lists', label: t('lists'), icon: ICONS.list },
        // Block 29d-2, Task 7. LAST IN THE SECTION, one row below Send lists,
        // for the same reason that row sits below Templates: a campaign is
        // built FROM a send list, so this is where that journey now ends up.
        //
        // Visible to every member, the same courtesy every entry in this
        // section already extends: /messages/campaigns redirects at the top
        // of its own render for anyone holding messaging.view nowhere, and
        // 0242's own select policy filters every read regardless of that
        // redirect. Hiding a link is a courtesy; the boundary is in the
        // database.
        //
        // ICONS.send is new for this row -- see its own comment in
        // app-shell.tsx for why neither list nor its other two neighbours
        // here could serve instead.
        { href: '/messages/campaigns', label: t('campaigns'), icon: ICONS.send },
      ],
    },
    {
      key: 'organization',
      // Visible to every member, including those holding no organization-scoped
      // permission at all. Deliberate, and not a hole: Team renders the member
      // roster (widened per-permission by RLS, 0024), the role list, the
      // invite form and the per-Station assignment grid — every one of those
      // reads and writes is itself gated by RLS or by a SECURITY DEFINER
      // function re-checking has_org_permission; Roles redirects at the top of
      // its own page for anyone lacking roles.manage, and
      // create_role/update_role/delete_role re-check has_org_permission
      // themselves regardless of that redirect. Hiding a link is a courtesy;
      // the boundary is in the database.
      label: t('organization'),
      items: [
        { href: '/team', label: t('team'), icon: ICONS.users },
        { href: '/roles', label: t('roles'), icon: ICONS.shield },
      ],
    },
    {
      key: 'reports',
      // Block 8b. Its own section rather than an item under Dashboards,
      // because what it lists crosses every domain -- listeners, promotions,
      // music and stock all export into the same place -- and filing it under
      // one of them would misname where it belongs.
      //
      // "My reports" rather than "Reports", so the section and its single item
      // do not spell the same word: the sidebar renders both, and Block 8a's
      // own note here records what that looks like when they match.
      //
      // No permission guards this link, and none guards the page either. It
      // lists the caller's OWN runs, limited by report_runs' RLS (0122), so
      // there is nothing to hide from somebody whose list is empty. The
      // boundary is on the export buttons, each guarded by its own domain's
      // permission, and in request_report (0127), which re-checks regardless.
      //
      // Block 20b, D3. Moved here from third in the list. The owner's item 8
      // read "before Modelos", which was already true — these sat third and
      // fourth and Templates was ninth — and the intent was the opposite
      // direction: two administrative sections were cutting the operational
      // ones (Stock, Audience, Promotions, Catalogue) in half, and they gather
      // at the foot of the list instead.
      label: t('reports'),
      items: [{ href: '/reports', label: t('myReports'), icon: ICONS.inbox }],
    },
    {
      key: 'administration',
      // Block 10a. The Organization's record of itself, not the platform's --
      // so it lives here rather than in the admin console (design D7).
      //
      // Visible to every member, like every other section: the page carries no
      // permission gate either, and deliberately. list_audit_logs is SECURITY
      // INVOKER, so audit_logs' own policies decide every row -- a caller
      // holding audit.view nowhere gets an empty page with a sentence saying
      // why, which is more useful to somebody who expected to see something
      // than a silent bounce to /app.
      label: t('administration'),
      items: [{ href: '/audit', label: t('auditTrail'), icon: ICONS.shield }],
    },
  ];

  if (isAdmin) {
    sections.push({
      key: 'platform',
      label: t('platform'),
      // Block 16, design D6. THREE ITEMS WHERE THERE WERE THREE, but the third
      // is not the one that left.
      //
      // "Customers" listed STATIONS and called them customers, so four rows
      // could equally mean four customers or one customer with four radios. It
      // is now two screens, because the platform has two records: a group, and
      // the radios under it.
      //
      // "WhatsApp integrations" went entirely. It was a list of every Station
      // with a card each — a Stations screen wearing another name, and the
      // second one this console had. A Station's connection is a fact about the
      // Station, so it is a tab in its record. What that block's D5 argued
      // stays true, and is now argued by where the tab sits rather than by a nav
      // item: the three Meta credentials are installation-wide environment
      // variables, so the account being configured is the platform's and the
      // whole of this section is platform-admin only.
      items: [
        { href: '/admin/organizations', label: t('organizations'), icon: ICONS.building },
        { href: '/admin/stations', label: t('stations'), icon: ICONS.message },
        { href: '/admin/contact-requests', label: t('contactRequests'), icon: ICONS.inbox },
        // After Contact requests, and NOT sharing its glyph. The two rows are
        // adjacent and read almost alike -- both are "somebody wrote in" --
        // which is precisely why one icon on both would make the pair look like
        // one link rendered twice. ICONS.trash is new for this row; see its
        // comment for the two candidates it beat.
        //
        // The section is platform-admin only, which is also the correct
        // audience for this screen: the erasure it leads to is a procedure run
        // by hand across every Station's data, not something an Organization
        // owner performs on their own tenant.
        {
          href: '/admin/data-deletion-requests',
          label: t('deletionRequests'),
          icon: ICONS.trash,
        },
      ],
    });
  }

  return {
    sections,
    user: {
      email: profile?.email ?? user.email ?? '',
      fullName: profile?.full_name ?? null,
      // 'Team member', not 'Member' — this same file's "Audience" section,
      // just above, adds a "Members" nav link for the audience Block 3
      // built (project vocabulary: members are the audience,
      // company_memberships are internal panel users, and the two must
      // never be confused in copy). This label names the signed-in panel
      // user, so it collided with that word the moment this diff added the
      // nav item beside it (Task 8 review, Important 3).
      roleLabel: isAdmin ? 'Platform admin' : 'Team member',
    },
    expandedSections,
    collapsed,
  };
}
