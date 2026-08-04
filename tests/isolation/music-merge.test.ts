import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 7b's boundary, proved the only way it can be: with real users holding
 * real, narrower grants.
 *
 * Every case here is invisible to pgTAP, which runs as superuser with a null
 * auth.uid(). That is not a gap in the pgTAP suite — it is why this file
 * exists, and why it is written in the same block as the functions rather than
 * at the end of it, which is the lesson Block 6c paid five commits for.
 */
// One stamp for the whole file, for the reason music.test.ts spells out:
// cleanupUsers can fail to delete a user referenced by an audited RPC, and an
// unstamped label only collides on the SECOND run — so it survives review and
// every single-run execution. One stamp reused everywhere a label feeds an
// e-mail is enough: the requirement is only that two RUNS never ask for the
// same address, not that every label be independently unique within a run.
const STAMP = Date.now();

describe('Block 7b — merging and requests across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`music7b-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station 7b');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  /** Registers an artist and a song in one Station, as the owner. */
  async function seedSong(companyId: string, title: string) {
    const owner = await signInAs(customer.email, customer.password);
    const { data: artistId, error: artistError } = await owner.rpc('create_music_reference', {
      p_company_id: companyId,
      p_kind: 'ARTIST',
      p_name: `Artist for ${title}`,
    });
    expect(artistError).toBeNull();
    // Fix round 1, Minor: a null id here (RLS/grant surprise, not a query
    // error) would still let cases 1 and 2 pass — merge_songs' own
    // `v_company is null` branch answers 42501 for a null p_winner_id too, for
    // the wrong reason entirely. Pin non-null before any case trusts these ids.
    expect(artistId).toBeTruthy();
    const { data: songId, error: songError } = await owner.rpc('create_song', {
      p_company_id: companyId,
      p_title: title,
      p_artist_id: artistId as string,
    });
    expect(songError).toBeNull();
    expect(songId).toBeTruthy();
    return { artistId: artistId as string, songId: songId as string };
  }

  it('refuses to merge without music.merge, even holding music.manage', async () => {
    const first = await seedSong(customer.companyId, 'Manager song A');
    const second = await seedSong(customer.companyId, 'Manager song B');

    // music.manage builds the catalogue and must NOT confer the power to
    // collapse it — D8's whole reason for a separate code.
    const manager = await grantRoleWith(customer, `merge-manager-${STAMP}`, [
      'music.view',
      'music.manage',
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: first.songId,
      p_loser_ids: [second.songId],
      p_reason: 'should not be allowed',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses a winner in a Station the caller cannot reach, without saying it exists', async () => {
    // A genuine second record in the hidden Station, distinct from the
    // winner, so this case is actually exercising the door's Station check
    // rather than merely reusing the winner-is-loser guard the core also has.
    const hiddenWinner = await seedSong(secondCompanyId, 'Hidden station song');
    const hiddenLoser = await seedSong(secondCompanyId, 'Hidden station song, duplicate');
    const merger = await grantRoleWith(
      customer,
      `merge-scoped-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: hiddenWinner.songId,
      p_loser_ids: [hiddenLoser.songId],
      p_reason: 'wrong station',
    });

    // 42501, never P0002: the id does exist, and the caller must not learn it.
    expect(error?.code).toBe('42501');
  });

  // Fix round 1, Minor: the pairing this comment set claims is proved by the
  // SQLSTATE alone (P0002) isn't the whole property. 0106's core has exactly
  // ONE raise for missing/archived/elsewhere, so the two cases below must also
  // produce the literal SAME MESSAGE, not merely the same code — a future
  // split into two distinct messages (one per cause) would still pass a
  // code-only assertion while reopening the oracle these cases exist to shut.
  // Carried across the two `it`s, which is the property's actual subject.
  let crossStationLoserMessage: string | undefined;

  it('refuses a LOSER that lives in another Station, and says nothing about it', async () => {
    const mine = await seedSong(customer.companyId, 'My song');
    const theirs = await seedSong(secondCompanyId, 'Their song');

    const merger = await grantRoleWith(
      customer,
      `merge-cross-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: mine.songId,
      p_loser_ids: [theirs.songId],
      p_reason: 'cross-station',
    });

    // P0002, the SAME answer a uuid naming nothing at all gets. The core scopes
    // its lock to the winner's Station, so "elsewhere" and "nonexistent" are
    // indistinguishable — a distinct message here would be an oracle.
    expect(error?.code).toBe('P0002');
    crossStationLoserMessage = error?.message;
    expect(crossStationLoserMessage).toBeTruthy();
  });

  it('answers a cross-Station loser identically to a uuid that names nothing', async () => {
    const mine = await seedSong(customer.companyId, 'My other song');
    const merger = await grantRoleWith(
      customer,
      `merge-nothing-${STAMP}`,
      ['music.view', 'music.merge'],
      [customer.companyId],
    );
    const client = await signInAs(merger.email, merger.password);

    const { error } = await client.rpc('merge_songs', {
      p_winner_id: mine.songId,
      p_loser_ids: ['00000000-0000-0000-0000-0000000000ff'],
      p_reason: 'nonexistent',
    });

    expect(error?.code).toBe('P0002');
    // The message, not just the code: 0106 has exactly one raise for
    // missing/archived/elsewhere, and this is what proves it stayed that way.
    expect(error?.message).toBe(crossStationLoserMessage);
  });

  it('merges, and the requests really move', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const winner = await seedSong(customer.companyId, 'Survivor');
    const loser = await seedSong(customer.companyId, 'Duplicate');

    const { data: memberId, error: memberError } = await owner.rpc('resolve_or_create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Listener ${STAMP}`,
      p_phone: `+5511${String(STAMP).slice(-9)}`,
    });
    expect(memberError).toBeNull();
    const resolved = memberId as { member_id: string };

    const { error: requestError } = await owner.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: resolved.member_id,
      p_song_id: loser.songId,
    });
    expect(requestError).toBeNull();

    const { data: moved, error: mergeError } = await owner.rpc('merge_songs', {
      p_winner_id: winner.songId,
      p_loser_ids: [loser.songId],
      p_reason: 'same recording',
    });
    expect(mergeError).toBeNull();
    expect(moved).toBe(1);

    // The proof that matters, read back through the real list rather than
    // asserted from the return value alone.
    const { data: rows, error: listError } = await owner.rpc('list_music_requests', {
      p_company_id: customer.companyId,
      p_song_id: winner.songId,
    });
    expect(listError).toBeNull();
    expect((rows as unknown[]).length).toBe(1);
  });

  it('lists requests without members.view, with the listener columns null', async () => {
    // D6's rule 2: the list still LISTS. An empty page here would be a
    // different bug wearing the same clothes. Fix round 1, Minor: this case
    // used to lean on case 5's request still being in the table — true today,
    // but silent and order-dependent. It now seeds its own request, so
    // editing case 5 cannot quietly break the premise here.
    const owner = await signInAs(customer.email, customer.password);
    const song = await seedSong(customer.companyId, 'No-name listener song');
    const { data: memberId, error: memberError } = await owner.rpc('resolve_or_create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Anonymous ${STAMP}`,
      p_phone: `+5512${String(STAMP).slice(-9)}`,
    });
    expect(memberError).toBeNull();
    const resolved = memberId as { member_id: string };
    const { error: requestError } = await owner.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: resolved.member_id,
      p_song_id: song.songId,
    });
    expect(requestError).toBeNull();

    const viewer = await grantRoleWith(customer, `req-noname-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.rpc('list_music_requests', {
      p_company_id: customer.companyId,
    });

    expect(error).toBeNull();
    const rows = data as {
      member_name: string | null;
      member_phone: string | null;
      song_title: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.member_name === null)).toBe(true);
    // Fix round 1, Important 2: D6's rule 2 nulls BOTH columns (0107's list
    // body cases on v_names for phone exactly as it does for name). Asserting
    // only member_name left the phone column's own `case when v_names then
    // f.phone else null end` unguarded by anything in this project.
    expect(rows.every((r) => r.member_phone === null)).toBe(true);
    // And the row is still useful: the song is there.
    expect(rows.every((r) => typeof r.song_title === 'string')).toBe(true);
  });

  it('returns nothing at all when a caller without members.view searches', async () => {
    // D6's rule 3: searching a field you may not read is an oracle.
    //
    // Fix round 1, Important 1: self-contained, and proves the zero means
    // "withheld" rather than "nothing was there". Seeds its own request naming
    // a listener the search term matches, and — as the OWNER, who holds
    // members.view — confirms the search really does find that row before
    // asserting the restricted caller gets none. Run alone, or after somebody
    // edits an earlier case's listener name, this no longer stays green for
    // the wrong reason.
    const owner = await signInAs(customer.email, customer.password);
    const song = await seedSong(customer.companyId, 'Searched-for song');
    const searchTerm = `Searchable Listener ${STAMP}`;
    const { data: memberId, error: memberError } = await owner.rpc('resolve_or_create_member', {
      p_company_id: customer.companyId,
      p_full_name: searchTerm,
      p_phone: `+5513${String(STAMP).slice(-9)}`,
    });
    expect(memberError).toBeNull();
    const resolved = memberId as { member_id: string };
    const { error: requestError } = await owner.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: resolved.member_id,
      p_song_id: song.songId,
    });
    expect(requestError).toBeNull();

    // Proof the row is really there and really matches the search, from a
    // caller who is allowed to see it.
    const { data: ownerRows, error: ownerError } = await owner.rpc('list_music_requests', {
      p_company_id: customer.companyId,
      p_search: searchTerm,
    });
    expect(ownerError).toBeNull();
    expect((ownerRows as unknown[]).length).toBeGreaterThan(0);

    const viewer = await grantRoleWith(customer, `req-nosearch-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.rpc('list_music_requests', {
      p_company_id: customer.companyId,
      p_search: searchTerm,
    });

    expect(error).toBeNull();
    expect((data as unknown[]).length).toBe(0);
  });

  it('refuses to record a request without music.request', async () => {
    const song = await seedSong(customer.companyId, 'No request permission');
    const viewer = await grantRoleWith(customer, `req-denied-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('create_music_request', {
      p_company_id: customer.companyId,
      p_member_id: '00000000-0000-0000-0000-0000000000ff',
      p_song_id: song.songId,
    });

    expect(error?.code).toBe('42501');
  });

  // Fix round 2: list_merge_candidates (0108) is gated on music.view, not
  // music.merge — moved there in this block's fix round 1 because
  // maintenance/page.tsx reads this list and getMusicPermissions in one
  // Promise.all, and gating the READ on music.merge made
  // "permissions.merge === false" and "the read already threw" the same
  // event, so the Maintenance screen's own required read-only mode could
  // never render. pgTAP proved the SQL side of that change (16_music_merge,
  // assertions 34-35); this file is what proves it as a real caller, since
  // pgTAP runs as superuser with a null auth.uid() and cannot exercise
  // has_permission at all.
  it('refuses the candidate list to a caller holding neither music.view nor music.merge', async () => {
    // music.manage alone, deliberately: it proves building the catalogue
    // (creating songs, artists, labels, genres, shows) does not confer
    // reading the Maintenance screen's list — a caller with music.view
    // AND music.manage would now succeed under the corrected gate, which
    // is exactly the case below and would prove nothing about a refusal.
    const manager = await grantRoleWith(customer, `cand-denied-${STAMP}`, ['music.manage']);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('list_merge_candidates', {
      p_company_id: customer.companyId,
      p_kind: 'SONG',
    });

    expect(error?.code).toBe('42501');
  });

  it('lets a caller holding music.view alone read the candidate list', async () => {
    // The property the whole fix-round-1 ruling rests on: a caller who can
    // see the catalogue but not merge it can still read this list, which is
    // what makes the Maintenance screen's read-only mode (MergePanel's
    // canMerge=false branch) reachable at all rather than a bare LoadError.
    const viewer = await grantRoleWith(customer, `cand-view-only-${STAMP}`, ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.rpc('list_merge_candidates', {
      p_company_id: customer.companyId,
      p_kind: 'SONG',
    });

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('has no write grant on music_merges for any caller', async () => {
    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner
      .from('music_merges')
      .insert({
        organization_id: customer.organizationId,
        company_id: customer.companyId,
        kind: 'SONG',
        winner_id: '00000000-0000-0000-0000-0000000000f1',
        loser_id: '00000000-0000-0000-0000-0000000000f2',
        reason: 'forged',
        children_moved: 0,
      });

    // Even the owner, who passes every permission gate, has no INSERT. Pinned
    // to the code, matching music.test.ts:227's sibling assertion (fix round
    // 1, Minor) — `.not.toBeNull()` alone would also pass for PGRST204 (an
    // unrecognised column, e.g. after a rename), which is a schema mistake,
    // not the missing-grant this case exists to prove.
    expect(error?.code).toBe('42501');
  });
});
