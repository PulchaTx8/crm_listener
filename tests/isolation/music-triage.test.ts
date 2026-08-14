import { afterAll, describe, expect, it } from 'vitest';
import { UnauthorizedError } from '@/lib/errors';
import {
  listMusicRequestsPage,
  markMusicRequestPlayed,
  markMusicRequestRead,
  revealRequestPhone,
} from '@/services/music';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

afterAll(cleanupUsers);

/**
 * Block 22, Task 9. 0190's four doors -- mark_music_request_read,
 * mark_music_request_played, cancel_music_request, reveal_request_phone --
 * are SECURITY DEFINER, so none of them inherits the caller's RLS: the
 * boundary is only what each function body checks (Block 6c's rule). pgTAP
 * runs as superuser and gets `true` from has_permission unconditionally, so
 * 51_music_request_triage.test.sql cannot see any of this -- which is why
 * this file exists, on the same reasoning music.test.ts's own header gives
 * for Block 7a's tenant boundary: real users holding real, narrower grants.
 *
 * Every case drives the SERVICE functions (src/services/music.ts) rather
 * than a raw `.rpc()` call, because the service -- not the database directly
 * -- is what the screen calls, and listMusicRequestsPage's own comment on
 * asCaller is the reason an explicit access token lets this be driven from
 * outside Next.js at all.
 */
const STAMP = Date.now();

async function tokenFor(user: { email: string; password: string }): Promise<string> {
  const client = await signInAs(user.email, user.password);
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error(`could not read an access token: ${error?.message}`);
  return data.session.access_token;
}

/**
 * Registers an artist, a song and a listener at the given Station and
 * records one request against them, all as the owner -- fixture setup, never
 * the operation any case here is named for. There is no harness helper for
 * the music catalogue, so the RPCs are called directly the same way
 * music.test.ts's own fixtures already do.
 */
async function seedMusicRequest(
  customer: ProvisionedCustomer,
  companyId: string,
  label: string,
): Promise<string> {
  const owner = await signInAs(customer.email, customer.password);

  const { data: artistId, error: artistError } = await owner.rpc('create_music_reference', {
    p_company_id: companyId,
    p_kind: 'ARTIST',
    p_name: `Artist ${label}`,
  });
  if (artistError) throw new Error(`create_music_reference failed: ${artistError.message}`);

  const { data: songId, error: songError } = await owner.rpc('create_song', {
    p_company_id: companyId,
    p_title: `Song ${label}`,
    p_artist_id: artistId as string,
  });
  if (songError) throw new Error(`create_song failed: ${songError.message}`);

  const memberId = await createMemberAs(customer, companyId, {
    fullName: `Listener ${label}`,
    phone: `1198888${String(STAMP).slice(-4)}`,
  });

  const { data: requestId, error: requestError } = await owner.rpc('create_music_request', {
    p_company_id: companyId,
    p_member_id: memberId,
    p_song_id: songId as string,
  });
  if (requestError) throw new Error(`create_music_request failed: ${requestError.message}`);
  return requestId as string;
}

describe('Block 22 — attending a request stops at the Station boundary', () => {
  it('an attendant marks a request read at their own Station, and the list shows it', async () => {
    const label = `triage-own-${STAMP}`;
    const customer = await provisionCustomer(label);
    const requestId = await seedMusicRequest(customer, customer.companyId, label);

    const attendant = await grantRoleWith(customer, label, ['music.view', 'participations.view']);
    const token = await tokenFor(attendant);

    await expect(markMusicRequestRead(requestId, token)).resolves.toBeUndefined();

    const page = await listMusicRequestsPage(
      { companyId: customer.companyId, sort: 'requested', cursor: null, cursorSide: 'after' },
      token,
    );
    const row = page.rows.find((r) => r.requestId === requestId);
    expect(row?.readStatus).toBe('READ');
  });

  // THE CASE THAT MATTERS. mark_music_request_read (0190) never inherits the
  // caller's RLS -- its own body checks
  // `has_permission('participations.view', company_id)` against the ROW's
  // Station, not against whatever p_company_id a screen might have sent. A
  // door that instead trusted the caller's own scoping, or checked the
  // permission without joining it to the row's own company_id, would let
  // this attendant -- who holds participations.view only at their own
  // Station -- reach across into the neighbour's.
  it('refuses an attendant handed a request id belonging to another Station', async () => {
    const label = `triage-cross-${STAMP}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const foreignRequestId = await seedMusicRequest(customer, otherCompanyId, `${label}-foreign`);

    // Scoped to the FIRST Station only -- grantRoleWith's default company.
    const attendant = await grantRoleWith(customer, label, ['music.view', 'participations.view']);
    const token = await tokenFor(attendant);

    await expect(markMusicRequestRead(foreignRequestId, token)).rejects.toThrow(UnauthorizedError);
  });

  it('lists every row with the name and phone withheld for music.view alone, and refuses the reveal', async () => {
    const label = `triage-onlooker-${STAMP}`;
    const customer = await provisionCustomer(label);
    const requestId = await seedMusicRequest(customer, customer.companyId, label);

    const onlooker = await grantRoleWith(customer, label, ['music.view']);
    const token = await tokenFor(onlooker);

    const page = await listMusicRequestsPage(
      { companyId: customer.companyId, sort: 'requested', cursor: null, cursorSide: 'after' },
      token,
    );
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.memberName).toBeNull();
      expect(row.memberPhoneLast4).toBeNull();
    }

    await expect(revealRequestPhone(requestId, token)).rejects.toThrow(UnauthorizedError);
  });

  // The two powers design D5 and D8 keep separate: members.view discloses WHO
  // asked, participations.view is what lets somebody act on the request. A
  // caller holding the first without the second reads the digits and still
  // cannot attend -- which is the whole claim of the two designs together,
  // not two unrelated facts.
  it('reads the four digits with members.view, and is still refused the attend door without participations.view', async () => {
    const label = `triage-reader-${STAMP}`;
    const customer = await provisionCustomer(label);
    const requestId = await seedMusicRequest(customer, customer.companyId, label);

    const reader = await grantRoleWith(customer, label, ['music.view', 'members.view']);
    const token = await tokenFor(reader);

    const page = await listMusicRequestsPage(
      { companyId: customer.companyId, sort: 'requested', cursor: null, cursorSide: 'after' },
      token,
    );
    const row = page.rows.find((r) => r.requestId === requestId);
    expect(row?.memberPhoneLast4).toMatch(/^\d{4}$/);

    await expect(markMusicRequestPlayed(requestId, token)).rejects.toThrow(UnauthorizedError);
  });
});
