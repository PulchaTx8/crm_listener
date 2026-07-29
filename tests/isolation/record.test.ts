import { afterAll, describe, expect, it } from 'vitest';
import {
  archiveMember,
  getMember,
  listMemberBlocks,
  listMemberConsents,
  listMemberNotes,
  listMemberStations,
  updateMember,
} from '@/services/members';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

/**
 * Block 3c opened three paths that had never been reachable from a screen:
 * the whole-record read behind the audience dialog, update_member and
 * archive_member. The first is new code; the other two are RPCs that shipped
 * in Block 3 with no interface at all, so nothing had ever called them as a
 * real signed-in user.
 *
 * Every case here is driven by a NON-OWNER delegate, for the reason
 * members.test.ts's own header gives: Block 1c shipped two defects that
 * thirteen reviews missed because every scenario had the owner driving, and
 * the owner's bypass hid the delegate's failure. The owner client appears
 * below only as fixture setup — registering a listener — never as the actor of
 * an assertion.
 *
 * These call the service functions the server actions call, with a real
 * delegate's access token. That is the whole of what the actions add beyond
 * `requireAccessToken()`, so the RLS and permission behaviour proved here is
 * the behaviour the dialog gets.
 */
async function tokenFor(email: string, password: string): Promise<string> {
  const client = await signInAs(email, password);
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(`no access token for ${email}`);
  return token;
}

describe('the record dialog', () => {
  describe('the whole-record read', () => {
    it('returns the record to a delegate who can reach the listener', async () => {
      const label = `rec-read-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Reachable ${label}`,
        phone: `55119${Date.now()}`,
      });

      const delegate = await grantRoleWith(customer, label, ['members.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      const detail = await getMember(memberId, token);
      expect(detail).not.toBeNull();
      expect(detail?.fullName).toBe(`Reachable ${label}`);

      // The four reads the dialog's tabs render from, each RLS-scoped on its
      // own. The Stations list is what proves the read reached past the
      // members row itself.
      const [stations, consents, notes, blocks] = await Promise.all([
        listMemberStations(memberId, token),
        listMemberConsents(memberId, token),
        listMemberNotes(memberId, token),
        listMemberBlocks(memberId, token),
      ]);
      expect(stations.map((s) => s.companyId)).toEqual([customer.companyId]);
      expect(consents).toEqual([]);
      expect(notes).toEqual([]);
      expect(blocks).toEqual([]);
    });

    it('returns nothing at all to a delegate at another Station', async () => {
      const label = `rec-read-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');

      // Registered and linked only to Station B — fixture setup, as the
      // owner, not the operation under test.
      const memberId = await createMemberAs(customer, stationB, {
        fullName: `Unreachable ${label}`,
        phone: `55116${Date.now()}`,
      });

      // The delegate holds members.view, but only at Station A. This is the
      // exact shape of somebody pasting ?record=<id> for a listener they are
      // not entitled to see.
      const delegate = await grantRoleWith(customer, label, ['members.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      // Null, not a partial record and not an error: getMemberRecordAction
      // turns precisely this into `not-found`, which the dialog renders as one
      // sentence covering both "no such listener" and "not yours". A row that
      // came back here — even with every field blank — would be the leak that
      // collapse exists to prevent.
      expect(await getMember(memberId, token)).toBeNull();

      // And each tab's own read is narrowed too, rather than the members row
      // being the only thing guarded. The action skips these four when the
      // listener does not come back, so this is what would be exposed if that
      // short-circuit were ever removed.
      expect(await listMemberStations(memberId, token)).toEqual([]);
      expect(await listMemberConsents(memberId, token)).toEqual([]);
      expect(await listMemberNotes(memberId, token)).toEqual([]);
      expect(await listMemberBlocks(memberId, token)).toEqual([]);
    });
  });

  describe('update_member through the action path', () => {
    it('saves for a delegate holding members.edit, and the re-read shows what was stored', async () => {
      const label = `rec-update-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Before ${label}`,
        phone: `55115${Date.now()}`,
      });

      const delegate = await grantRoleWith(customer, label, ['members.view', 'members.edit']);
      const token = await tokenFor(delegate.email, delegate.password);

      await updateMember({ memberId, fullName: `After ${label}`, city: 'Santos' }, token);

      // The action re-reads rather than echoing the form back, because
      // cpf_last_digits is derived and the normalised columns are generated.
      // This asserts the re-read, which is the value the grid patches its row
      // with.
      const detail = await getMember(memberId, token);
      expect(detail?.fullName).toBe(`After ${label}`);
      expect(detail?.city).toBe('Santos');
      // update_member replaces the record wholesale: a field left out of the
      // call is blanked, not preserved. That is why the dialog's Data tab
      // submits every field on every save, and this is the proof the rule is
      // real rather than a comment about it.
      expect(detail?.phone).toBeNull();
    });

    it('refuses a delegate who holds members.view but not members.edit', async () => {
      const label = `rec-update-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Untouched ${label}`,
      });

      const delegate = await grantRoleWith(customer, label, ['members.view']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(
        updateMember({ memberId, fullName: `Renamed ${label}` }, token),
      ).rejects.toThrow();

      // Hiding the Save button is courtesy; this is the boundary. The row is
      // unchanged for a caller who can still read it.
      const ownerToken = await tokenFor(customer.email, customer.password);
      expect((await getMember(memberId, ownerToken))?.fullName).toBe(`Untouched ${label}`);
    });
  });

  describe('archive_member through the action path', () => {
    it('archives for a delegate holding members.archive, and the row leaves every read', async () => {
      const label = `rec-archive-ok-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Doomed ${label}`,
      });

      const delegate = await grantRoleWith(customer, label, [
        'members.view',
        'members.archive',
      ]);
      const token = await tokenFor(delegate.email, delegate.password);

      await archiveMember(memberId, token);

      // The confirmation dialog tells the operator this cannot be undone from
      // the app, and this is why that sentence is true rather than cautious:
      // members_select_reachable (0035) hides an archived row from every read,
      // for every caller — the delegate who archived it AND the owner.
      expect(await getMember(memberId, token)).toBeNull();
      const ownerToken = await tokenFor(customer.email, customer.password);
      expect(await getMember(memberId, ownerToken)).toBeNull();
    });

    it('refuses a delegate who holds members.edit but not members.archive', async () => {
      const label = `rec-archive-denied-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Survivor ${label}`,
      });

      const delegate = await grantRoleWith(customer, label, ['members.view', 'members.edit']);
      const token = await tokenFor(delegate.email, delegate.password);

      await expect(archiveMember(memberId, token)).rejects.toThrow();

      // Still there, and still readable: the refusal left nothing half-done.
      expect((await getMember(memberId, token))?.fullName).toBe(`Survivor ${label}`);
    });
  });
});
