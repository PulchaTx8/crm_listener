import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { ICONS, type ShellUser } from '@/components/layout/app-shell';
import type { NavSection } from '@/components/layout/sidebar-nav';
import { getTranslations } from 'next-intl/server';

/**
 * Everything the chrome needs, resolved once per request. Both the member area
 * and the platform console call this, so the navigation cannot drift between
 * them — and the platform links only appear for a platform admin, which is a
 * convenience, not the guard: the admin layout still redirects and every RPC
 * re-checks in its own body.
 */
export async function getShellContext(): Promise<{ sections: NavSection[]; user: ShellUser }> {
  // Block 12a. The navigation is the one place a person sees every area of the
  // product at once, so its wording is the first thing that has to speak their
  // language. Fetched here because this function is already async and already
  // the single builder of the tree.
  const t = await getTranslations('nav');

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
      key: 'inventory',
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
        // Block 6d, Task 10. /inventory/movements redirects nobody by
        // itself — it opens on whichever Station listCompanyAccess resolves
        // inventory.view in, the same courtesy the item above already
        // extends — and list_movements (0096) re-checks that permission
        // itself regardless. ICONS.inbox rather than ICONS.box: this Record
        // has no dedicated ledger/list glyph, so the choice is among what
        // already exists, and reusing box here — the ROW DIRECTLY ABOVE, in
        // this SAME section — is exactly the case the Audience section's own
        // ticket/megaphone comment warns against (one icon on two adjacent
        // rows reads as one link rendered twice). inbox's tray-with-a-flow
        // shape is otherwise idle in this section (its only other use is
        // Platform > Contact requests, a different section entirely, the
        // same non-adjacency that already lets box itself serve both
        // Inventory and Pickups) and reads reasonably as things moving in
        // and out, which a stock ledger is.
        { href: '/inventory/movements', label: t('movements'), icon: ICONS.inbox },
      ],
    },
    {
      key: 'audience',
      // Visible to every member, including those holding members.view
      // nowhere in the Organization — the same courtesy Inventory just above
      // extends for inventory.view. /members redirects at the top of its own
      // page for anyone holding members.view nowhere (access.ts's
      // canViewAudience), and members_select_reachable plus its four sibling
      // policies (0035_rls_members.sql) filter every read underneath
      // regardless of that redirect. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: t('audience'),
      items: [
        { href: '/members', label: t('members'), icon: ICONS.headphones },
        // Moved here from Promotions in Block 6c, on the owner's ruling: this
        // is the listing of PEOPLE taking part, and it is where the draw is
        // run from, so it belongs beside the audience rather than beside the
        // promotions it happens to reference. The courtesy is unchanged:
        // /participations redirects at the top of its own page for anyone
        // holding participations.view in no Station, 0053's policies and
        // list_participations' own two-permission gate (0090) filter every
        // read regardless, and the write RPCs re-check has_permission in their
        // own bodies (0054). Hiding a link is a courtesy; the boundary is in
        // the database.
        { href: '/participations', label: t('participations'), icon: ICONS.ticket },
        // Block 18, on the owner's ruling. A programme was a name in a tab of
        // the music catalogue; it is now a record with a presenter, a schedule
        // and a run of dates, and it belongs beside the audience it is made
        // for rather than beside the songs it happens to play.
        //
        // THE PERMISSION DID NOT MOVE WITH THE SCREEN, and that is recorded
        // rather than accidental: `shows` carries one policy, gated on
        // music.view, so a member who administers the audience and holds
        // nothing in music sees this link and finds nothing behind it. A
        // shows.* pair would be a permissions migration plus every role a
        // customer has already configured, none of which would grant it —
        // shipping the screen behind a permission nobody holds would hide it
        // from everyone. The Block 18 spec's §5 carries the full reasoning.
        { href: '/shows', label: t('programmes'), icon: ICONS.radio },
        // Block 20b, D1, on the owner's ruling. This is the listing of PEOPLE
        // asking for something, and it belongs beside the audience rather than
        // beside the recordings it happens to reference — the same argument
        // Block 6c used to move Participations here out of Promotions. The
        // href does not change.
        //
        // ICONS.music rather than ICONS.ticket, which is what it carried under
        // the catalogue: `ticket` is Participations, two rows up in THIS SAME
        // section, and one glyph on two adjacent rows reads as one link
        // rendered twice. `music` is unused in Audience and a song request is
        // the one thing here that is about a recording; its other uses are in
        // Dashboards and Catalogue, distant sections.
        { href: '/music/requests', label: t('requests'), icon: ICONS.music },
      ],
    },
    {
      key: 'promotions',
      // Visible to every member, on the same courtesy the two sections above
      // extend: /promotions redirects at the top of its own page for anyone
      // holding promotions.view in no Station, and 0044's three select
      // policies plus every RPC in 0042/0043 re-check has_permission
      // regardless of that redirect. Hiding a link is a courtesy; the boundary
      // is in the database.
      label: t('promotions'),
      items: [
        { href: '/promotions', label: t('promotions'), icon: ICONS.megaphone },
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
        // Block 20b, D2. These three replace the single "Catalogue" item, which
        // could not survive the section's rename: a section and an item
        // spelling the same word read as one link rendered twice, the rule this
        // file already records for Inventory > Stock and for the three
        // Dashboards entries.
        //
        // The addresses already answer — `parseCatalogTab`
        // (music/catalog/page.tsx) reads exactly this three-word vocabulary —
        // so this block ships the NAVIGATION and Block 20c replaces what those
        // addresses render. ICONS.building for a label because a label is a
        // company and `building`'s only other use is Platform > Organizations,
        // a distant section; `tag` and `disc` are new (app-shell.tsx says why).
        { href: '/music/catalog?tab=labels', label: t('labels'), icon: ICONS.building },
        { href: '/music/catalog?tab=genres', label: t('genres'), icon: ICONS.tag },
        { href: '/music/catalog?tab=albums', label: t('albums'), icon: ICONS.disc },
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
      key: 'templates',
      // Visible to every member, including those holding templates.view in no
      // Station at all — the same courtesy every section above extends. Both
      // pages redirect at the top of their own render for anyone holding it
      // nowhere, 0109's and 0110's select policies cut every read to the
      // Stations that do hold it, and all four doors in 0113 re-check
      // templates.manage in their own bodies. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: t('templates'),
      items: [
        // ICONS.message is new, and is the block's own: this is the one
        // section about WORDS rather than records, and nothing already
        // declared meant that (see the path's own comment in app-shell.tsx).
        { href: '/templates/messages', label: t('messages'), icon: ICONS.message },
        // ICONS.megaphone rather than message again: these two sit on ADJACENT
        // ROWS OF THIS SAME SECTION, which is exactly the case the Audience
        // section's ticket/megaphone comment warns against — one icon on both
        // would read as one link rendered twice. megaphone is otherwise used
        // only by Promotions, a different section entirely, the same
        // non-adjacency that already lets box serve both Inventory and
        // Pickups. Its shape reads reasonably here: a registered template is
        // the only thing that lets a Station SPEAK FIRST rather than answer.
        { href: '/templates/whatsapp', label: t('whatsapp'), icon: ICONS.megaphone },
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
  };
}
