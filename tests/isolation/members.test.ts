import { afterAll, describe, expect, it } from 'vitest';
import { cpfLastDigits, hashCpf } from '@/services/members';
import {
  addCompany,
  addMemberByInvitation,
  admin,
  cleanupUsers,
  createMemberAs,
  createRoleAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

// Every RPC gated in 0033/0034 is a SECURITY DEFINER (or, for member_reachable,
// SECURITY INVOKER) body reading auth.uid(). pgTAP runs as superuser with no
// session user and cannot exercise any of that, and cannot exercise RLS under a
// real JWT either. This suite is the only place this block's claims are backed
// by a real signed-in user instead of by reading the SQL — inventory.test.ts's
// own header comment states the same thing for Block 2, and Block 1c shipped
// two defects that thirteen reviews missed because every scenario had the
// owner driving and the owner's bypass hid the delegate's failure. Every case
// below is driven by a non-owner delegate, except the two gap cases that name
// the owner/platform-admin bypass itself as the thing under test — there, the
// owner or platform admin is deliberately the subject, not a substitute actor.
describe('members', () => {
  // ---------------------------------------------------------------------
  // Cases 1-3: find_member_by_identifier (0033) — the one place this block
  // reads across the visibility boundary by design.
  // ---------------------------------------------------------------------
  describe('deduplication — find_member_by_identifier', () => {
    it('case 1: returns visible with the id when the caller can reach one of the Member\'s Stations', async () => {
      const label = `mem-dedup-visible-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const delegate = await grantRoleWith(customer, label, ['members.create', 'members.view']);
      const client = await signInAs(delegate.email, delegate.password);

      const phone = `55118${Date.now()}`;
      const created = await client.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: `Visible Probe ${label}`,
        p_phone: phone,
      });
      expect(created.error).toBeNull();
      const memberId = created.data as string;

      const found = await client.rpc('find_member_by_identifier', {
        p_organization_id: customer.organizationId,
        p_phone: phone,
      });
      expect(found.error).toBeNull();
      expect(found.data).toEqual({ outcome: 'visible', member_id: memberId });
    });

    it('case 2: returns elsewhere and nothing else — exactly one key — when the caller cannot reach it', async () => {
      const label = `mem-dedup-elsewhere-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');

      // Registered and linked only to Station B, as a fixture (not the
      // operation under test here).
      const phone = `55117${Date.now()}`;
      await createMemberAs(customer, stationB, { fullName: `Elsewhere Probe ${label}`, phone });

      // Delegate holds members.view only at Station A (the customer's
      // original Station), never linked to Station B at all.
      const delegate = await grantRoleWith(customer, label, ['members.view']);
      const client = await signInAs(delegate.email, delegate.password);

      const found = await client.rpc('find_member_by_identifier', {
        p_organization_id: customer.organizationId,
        p_phone: phone,
      });
      expect(found.error).toBeNull();
      expect(found.data).toEqual({ outcome: 'elsewhere' });
      // Named explicitly per the brief: toEqual above already fails on an
      // extra key, but a future field added carelessly (say, a `message`
      // the 0033 comment warns an earlier draft wrongly promised) deserves
      // its own assertion rather than riding on toEqual's side effect.
      expect(Object.keys(found.data as Record<string, unknown>)).toHaveLength(1);
    });

    it('case 3: refuses a caller holding no members.view anywhere in the Organization', async () => {
      const label = `mem-dedup-noperm-${Date.now()}`;
      const customer = await provisionCustomer(label);
      // A live membership under a role granting nothing — not a caller with
      // zero company access at all, so the refusal below is provably about
      // the permission has_org_permission looks for, not mere absence of any
      // Station membership.
      const delegate = await grantRoleWith(customer, label, []);
      const client = await signInAs(delegate.email, delegate.password);

      const denied = await client.rpc('find_member_by_identifier', {
        p_organization_id: customer.organizationId,
        p_phone: '5511999998888',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.view required');
    });
  });

  it(
    "case 4: a Member linked only to Station B is invisible to a delegate holding members.view in Station A who also holds a live membership in B under a role granting nothing",
    async () => {
      const label = `mem-rls-crossstation-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');

      const viewRole = await createRoleAs(customer, `View-${label}`, ['members.view']);
      const bystanderRole = await createRoleAs(customer, `Bystander-${label}`, []);
      const delegate = await addMemberByInvitation(customer, label, viewRole, [customer.companyId]);
      const owner = await signInAs(customer.email, customer.password);

      // A LIVE membership in Station B under a role granting nothing.
      // Without this, has_company_access(stationB) is already false and
      // has_permission short-circuits before the role branch ever runs —
      // the same correction Block 1c's headline test needed
      // (inventory.test.ts's own scope test carries the identical comment)
      // — which would leave this test passing at the access gate instead of
      // the permission-resolution layer it names.
      const { error: assignError } = await owner.rpc('assign_company_role', {
        p_company_id: stationB,
        p_user_id: delegate.userId,
        p_role_id: bystanderRole,
      });
      expect(assignError).toBeNull();

      const memberId = await createMemberAs(customer, stationB, { fullName: `Hidden Probe ${label}` });

      const client = await signInAs(delegate.email, delegate.password);
      const { data, error } = await client.from('members').select('id').eq('id', memberId);
      expect(error).toBeNull();
      expect(data).toEqual([]);

      // Positive control: the same client can see a Member linked to their
      // own reachable Station A, so the refusal above is about reach and not
      // a broken client or query.
      const visibleId = await createMemberAs(customer, customer.companyId, {
        fullName: `Visible Probe ${label}`,
      });
      const { data: visibleData, error: visibleError } = await client
        .from('members')
        .select('id')
        .eq('id', visibleId);
      expect(visibleError).toBeNull();
      expect(visibleData).toEqual([{ id: visibleId }]);
    },
  );

  it('case 5: "Stations they took part in" omits an unreachable Station', async () => {
    const label = `mem-links-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const stationB = await addCompany(customer, 'Station Two');

    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Multi-Station Probe ${label}`,
    });
    const owner = await signInAs(customer.email, customer.password);
    const { error: linkError } = await owner.rpc('link_member_to_company', {
      p_member_id: memberId,
      p_company_id: stationB,
    });
    expect(linkError).toBeNull();

    // Delegate holds members.view at Station A only.
    const delegate = await grantRoleWith(customer, label, ['members.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const { data, error } = await client
      .from('member_company_links')
      .select('company_id')
      .eq('member_id', memberId);
    expect(error).toBeNull();
    // Both links exist at the database level (Station A and Station B); only
    // Station A's is readable through this delegate's own RLS.
    expect(data).toEqual([{ company_id: customer.companyId }]);
  });

  it(
    "case 6 (+ gap 1): a block with a past ends_at no longer blocks, a future one does, and an indefinite Organization-wide one does — exercising is_member_blocked's company_id-is-null branch through the function itself, not just at insert",
    async () => {
      const label = `mem-block-expiry-${Date.now()}`;
      const customer = await provisionCustomer(label);
      // A third Station carrying no scoped block of its own — the only row
      // that can make probe 3 true is the Organization-wide one, and only
      // through the `company_id is null` disjunct, since `company_id =
      // p_company_id` can never match a NULL column against this Station's
      // real id.
      const stationC = await addCompany(customer, 'Station Three');
      const delegate = await grantRoleWith(customer, label, ['members.create', 'members.block']);
      const client = await signInAs(delegate.email, delegate.password);

      const created = await client.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: `Block Probe ${label}`,
      });
      expect(created.error).toBeNull();
      const memberId = created.data as string;

      // Probe 1: a Station-scoped block whose ends_at has already passed.
      const past = new Date(Date.now() - 60_000).toISOString();
      const pastBlock = await client.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'suspension',
        p_reason: 'already over',
        p_company_id: customer.companyId,
        p_ends_at: past,
      });
      expect(pastBlock.error).toBeNull();

      const notBlocked = await client.rpc('is_member_blocked', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
      });
      expect(notBlocked.error).toBeNull();
      expect(notBlocked.data).toBe(false);

      // Probe 2: a Station-scoped block whose ends_at is still ahead.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const futureBlock = await client.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'suspension',
        p_reason: 'active now',
        p_company_id: customer.companyId,
        p_ends_at: future,
      });
      expect(futureBlock.error).toBeNull();

      const blocked = await client.rpc('is_member_blocked', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
      });
      expect(blocked.error).toBeNull();
      expect(blocked.data).toBe(true);

      // Probe 3: an indefinite, Organization-wide block (company_id null).
      const orgWideBlock = await client.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'draw_ban',
        p_reason: 'indefinite, whole Organization',
      });
      expect(orgWideBlock.error).toBeNull();

      const blockedElsewhere = await client.rpc('is_member_blocked', {
        p_member_id: memberId,
        p_company_id: stationC,
      });
      expect(blockedElsewhere.error).toBeNull();
      expect(blockedElsewhere.data).toBe(true);
    },
  );

  describe('case 7: each of the six permissions is refused without it and allowed with it', () => {
    it('members.view gates find_member_by_identifier', async () => {
      const label = `mem-perm-view-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withView = await grantRoleWith(customer, `${label}-yes`, ['members.view']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('find_member_by_identifier', {
        p_organization_id: customer.organizationId,
        p_phone: '5511988887777',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.view required');

      const allowedClient = await signInAs(withView.email, withView.password);
      const allowed = await allowedClient.rpc('find_member_by_identifier', {
        p_organization_id: customer.organizationId,
        p_phone: '5511988887777',
      });
      expect(allowed.error).toBeNull();
    });

    it('members.create gates create_member', async () => {
      const label = `mem-perm-create-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withCreate = await grantRoleWith(customer, `${label}-yes`, ['members.create']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: 'Nope',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.create required');

      const allowedClient = await signInAs(withCreate.email, withCreate.password);
      const allowed = await allowedClient.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: 'Yes',
      });
      expect(allowed.error).toBeNull();
      expect(allowed.data).toBeTruthy();
    });

    it('members.edit gates update_member', async () => {
      const label = `mem-perm-edit-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Edit Probe ${label}`,
      });
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withEdit = await grantRoleWith(customer, `${label}-yes`, ['members.edit']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('update_member', {
        p_member_id: memberId,
        p_full_name: 'Nope Edited',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.edit required');

      const allowedClient = await signInAs(withEdit.email, withEdit.password);
      const allowed = await allowedClient.rpc('update_member', {
        p_member_id: memberId,
        p_full_name: 'Yes Edited',
      });
      expect(allowed.error).toBeNull();
    });

    it('members.block gates block_member', async () => {
      const label = `mem-perm-block-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Block-Perm Probe ${label}`,
      });
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withBlock = await grantRoleWith(customer, `${label}-yes`, ['members.block']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'draw_ban',
        p_reason: 'nope',
        p_company_id: customer.companyId,
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.block required');

      const allowedClient = await signInAs(withBlock.email, withBlock.password);
      const allowed = await allowedClient.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'draw_ban',
        p_reason: 'yes',
        p_company_id: customer.companyId,
      });
      expect(allowed.error).toBeNull();
      expect(allowed.data).toBeTruthy();
    });

    it('members.archive gates archive_member', async () => {
      const label = `mem-perm-archive-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Archive Probe ${label}`,
      });
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withArchive = await grantRoleWith(customer, `${label}-yes`, ['members.archive']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('archive_member', { p_member_id: memberId });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.archive required');

      const allowedClient = await signInAs(withArchive.email, withArchive.password);
      const allowed = await allowedClient.rpc('archive_member', { p_member_id: memberId });
      expect(allowed.error).toBeNull();
    });

    it('members.erase gates anonymize_member', async () => {
      const label = `mem-perm-erase-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Erase Probe ${label}`,
      });
      const without = await grantRoleWith(customer, `${label}-no`, []);
      const withErase = await grantRoleWith(customer, `${label}-yes`, ['members.erase']);

      const deniedClient = await signInAs(without.email, without.password);
      const denied = await deniedClient.rpc('anonymize_member', {
        p_member_id: memberId,
        p_reason: 'internal_policy',
      });
      expect(denied.error).not.toBeNull();
      expect(denied.error!.message).toContain('permission denied: members.erase required');

      const allowedClient = await signInAs(withErase.email, withErase.password);
      const allowed = await allowedClient.rpc('anonymize_member', {
        p_member_id: memberId,
        p_reason: 'internal_policy',
      });
      expect(allowed.error).toBeNull();
    });
  });

  it(
    'case 8 (+ gaps 3 and 6, rule 1): after anonymisation, no audit_logs row for the Member contains any erased value, and the three write RPCs guarded against an anonymised Member actually refuse',
    async () => {
      const label = `mem-audit-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');

      // One delegate holding every members.* permission at both Stations.
      // This case is not about permission gating — case 7 already proves
      // that per permission — it exists to exercise every write RPC and
      // search the trail it leaves, so one delegate driving the whole chain
      // keeps the scenario legible without re-litigating access control
      // here.
      const delegate = await grantRoleWith(
        customer,
        label,
        ['members.view', 'members.create', 'members.edit', 'members.block', 'members.archive', 'members.erase'],
        [customer.companyId, stationB],
      );
      const client = await signInAs(delegate.email, delegate.password);

      // Distinctive values, unique to this run and appearing nowhere else in
      // the database — Date.now() plus the label already makes every
      // fixture in this suite unique.
      const distinctiveName = `Zzq Probe ${label}`;
      const distinctivePhone = `55119${Date.now()}`;
      const distinctiveEmail = `zzq-${label}@example.test`;
      const distinctiveCpf = String(Date.now()).slice(-11).padStart(11, '7');
      const cpfHash = hashCpf(distinctiveCpf);
      const cpfLast3 = cpfLastDigits(distinctiveCpf);
      const distinctiveOrigin = `consent captured by Zzq at the front desk, ${label}`;
      const distinctiveNoteBody = `Note about ${distinctiveName}, phone ${distinctivePhone}`;
      const distinctiveBlockReason = `Blocked: ${distinctiveName} used e-mail ${distinctiveEmail}`;
      const distinctiveLiftReason = `Unblocked after ${distinctiveName} called and apologised`;

      // 1. create_member
      const created = await client.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: distinctiveName,
        p_phone: distinctivePhone,
        p_email: distinctiveEmail,
        p_cpf_hash: cpfHash,
        p_cpf_last_digits: cpfLast3,
      });
      expect(created.error).toBeNull();
      const memberId = created.data as string;

      // 2. update_member
      const updated = await client.rpc('update_member', {
        p_member_id: memberId,
        p_full_name: distinctiveName,
        p_phone: distinctivePhone,
        p_email: distinctiveEmail,
        p_cpf_hash: cpfHash,
        p_cpf_last_digits: cpfLast3,
      });
      expect(updated.error).toBeNull();

      // 3. link_member_to_company
      const linked = await client.rpc('link_member_to_company', {
        p_member_id: memberId,
        p_company_id: stationB,
      });
      expect(linked.error).toBeNull();

      // 4. record_member_consent
      const consent = await client.rpc('record_member_consent', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
        p_consent_type: 'rules',
        p_granted: true,
        p_origin: distinctiveOrigin,
      });
      expect(consent.error).toBeNull();
      const consentId = consent.data as string;

      // 5. add_member_note
      const note = await client.rpc('add_member_note', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
        p_body: distinctiveNoteBody,
      });
      expect(note.error).toBeNull();
      const noteId = note.data as string;

      // 6. block_member
      const block = await client.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'draw_ban',
        p_reason: distinctiveBlockReason,
        p_company_id: customer.companyId,
      });
      expect(block.error).toBeNull();
      const blockId = block.data as string;

      // 7. lift_member_block
      const lift = await client.rpc('lift_member_block', {
        p_block_id: blockId,
        p_reason: distinctiveLiftReason,
      });
      expect(lift.error).toBeNull();

      // 8. anonymize_member — deliberately BEFORE archive_member (9, below),
      // not after. archive_member's own guard checks only deleted_at, never
      // anonymized_at, so anonymising first and archiving last is what lets
      // the gap-6 refusals right below be caused by anonymized_at alone: at
      // this point deleted_at is still null. Anonymising after archiving
      // instead (which is equally legal — anonymize_member does not filter
      // on deleted_at) would leave both flags set by the time gap 6 runs,
      // and a P0002 caused by deleted_at would be indistinguishable from one
      // caused by anonymized_at — exactly the "test passes for the wrong
      // reason" failure mode this project keeps warning about. Confirmed by
      // mutation: with archive_member run first (the original draft of this
      // case), deleting `and anonymized_at is null` from
      // record_member_consent's own guard left this case green, because
      // `and deleted_at is null` alone still caught it.
      const anonymized = await client.rpc('anonymize_member', {
        p_member_id: memberId,
        p_reason: 'subject_request',
      });
      expect(anonymized.error).toBeNull();

      // gap 6: record_member_consent, add_member_note and block_member all
      // refuse outright on an already-anonymised Member (guard added during
      // Task 4's review) — proved directly here, and isolated to
      // anonymized_at specifically by the ordering above (deleted_at is
      // still null at this point).
      const consentAfter = await client.rpc('record_member_consent', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
        p_consent_type: 'rules',
        p_granted: true,
      });
      expect(consentAfter.error).not.toBeNull();
      expect(consentAfter.error!.code).toBe('P0002');

      const noteAfter = await client.rpc('add_member_note', {
        p_member_id: memberId,
        p_company_id: customer.companyId,
        p_body: 'should be refused',
      });
      expect(noteAfter.error).not.toBeNull();
      expect(noteAfter.error!.code).toBe('P0002');

      const blockAfter = await client.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'suspension',
        p_reason: 'should be refused',
        p_company_id: customer.companyId,
      });
      expect(blockAfter.error).not.toBeNull();
      expect(blockAfter.error!.code).toBe('P0002');

      // 9. archive_member — last, so every one of the nine write RPCs has
      // now run against this Member exactly once, and the audit search
      // below covers all nine rows.
      const archived = await client.rpc('archive_member', { p_member_id: memberId });
      expect(archived.error).toBeNull();

      // Rule 1's own scrub check (owner's Ruling B, Task 4 review): the
      // three lifecycle tables' free text is nulled for an erased Member,
      // not merely absent from audit_logs. Read with the service client,
      // which bypasses RLS but not the actual stored value.
      const { data: noteRow, error: noteRowError } = await admin
        .from('member_notes')
        .select('body')
        .eq('id', noteId)
        .single();
      expect(noteRowError).toBeNull();
      expect(noteRow?.body).toBeNull();

      const { data: consentRow, error: consentRowError } = await admin
        .from('member_consents')
        .select('origin')
        .eq('id', consentId)
        .single();
      expect(consentRowError).toBeNull();
      expect(consentRow?.origin).toBeNull();

      const { data: blockRow, error: blockRowError } = await admin
        .from('member_blocks')
        .select('reason, lift_reason')
        .eq('id', blockId)
        .single();
      expect(blockRowError).toBeNull();
      expect(blockRow?.reason).toBeNull();
      expect(blockRow?.lift_reason).toBeNull();

      // gap 3: record_member_consent/add_member_note/block_member/
      // lift_member_block's only prior evidence was an aggregate "zero
      // hits" audit search, which proves the no-personal-data rule only if
      // the RPC actually inserted a row. Counting exactly nine rows here —
      // one per write RPC exercised above — proves the insert happened for
      // every one of them, not just the five with direct probe evidence
      // before this task. Scoped via detail->>member_id rather than
      // target_id: target_id is the note/consent/block's OWN id for three
      // of the nine rows, not the Member's.
      const { data: memberRows, error: memberRowsError } = await admin
        .from('audit_logs')
        .select('action, detail')
        .eq('organization_id', customer.organizationId)
        .eq('detail->>member_id', memberId);
      expect(memberRowsError).toBeNull();
      expect(memberRows).toHaveLength(9);

      // Rule 1's headline, and case 8's own reason to exist: every one of
      // those nine rows' detail, searched for each distinctive value.
      // Scoped to the whole Organization (not just the nine rows above) so
      // this also catches a value written under the wrong member_id by
      // mistake. The first four are the brief's own named values (name,
      // phone, e-mail, CPF); the rest extend the same check to the free
      // text 0034's own comment says must never reach detail either (a
      // note's body, a block's reason, a lift's reason, a consent's
      // origin) and to the CPF's hash, which is exactly as identifying as
      // the raw number once paired with member_id.
      const { data: orgRows, error: orgRowsError } = await admin
        .from('audit_logs')
        .select('detail')
        .eq('organization_id', customer.organizationId);
      expect(orgRowsError).toBeNull();
      const haystack = JSON.stringify(orgRows ?? []);
      const needles = [
        distinctiveName,
        distinctivePhone,
        distinctiveEmail,
        distinctiveCpf,
        cpfHash,
        distinctiveOrigin,
        distinctiveNoteBody,
        distinctiveBlockReason,
        distinctiveLiftReason,
      ];
      for (const needle of needles) {
        expect(haystack).not.toContain(needle);
      }
    },
  );

  it('case 9: anonymisation clears the generated columns too, so the same phone can be re-registered', async () => {
    const label = `mem-reuse-anon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['members.create', 'members.erase']);
    const client = await signInAs(delegate.email, delegate.password);

    const phone = `55116${Date.now()}`;
    const first = await client.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Reuse Probe ${label}`,
      p_phone: phone,
    });
    expect(first.error).toBeNull();

    const anon = await client.rpc('anonymize_member', {
      p_member_id: first.data as string,
      p_reason: 'subject_request',
    });
    expect(anon.error).toBeNull();

    const second = await client.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Reuse Probe Two ${label}`,
      p_phone: phone,
    });
    expect(second.error).toBeNull();
    expect(second.data).not.toBe(first.data);
  });

  it("case 10: an archived Member's phone can be reused", async () => {
    const label = `mem-reuse-archive-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['members.create', 'members.archive']);
    const client = await signInAs(delegate.email, delegate.password);

    const phone = `55115${Date.now()}`;
    const first = await client.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Archive Reuse Probe ${label}`,
      p_phone: phone,
    });
    expect(first.error).toBeNull();

    const archived = await client.rpc('archive_member', { p_member_id: first.data as string });
    expect(archived.error).toBeNull();

    const second = await client.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Archive Reuse Probe Two ${label}`,
      p_phone: phone,
    });
    expect(second.error).toBeNull();
    expect(second.data).not.toBe(first.data);
  });

  it(
    "gap 2: member_reachable admits the platform admin outside the per-link check, even when the Member's only Station is suspended",
    async () => {
      const label = `mem-admin-bypass-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');
      const memberId = await createMemberAs(customer, stationB, {
        fullName: `Admin Bypass Probe ${label}`,
      });

      const { error: suspendError } = await customer.adminClient.rpc('suspend_company', {
        p_company_id: stationB,
        p_reason: 'non-payment',
      });
      expect(suspendError).toBeNull();

      // has_permission requires an ACTIVE Station for every caller (0016),
      // so an ordinary role holder — even one who WAS linked to Station B —
      // could no longer reach this Member through the per-link branch.
      // member_reachable's own is_platform_admin() disjunct sits OUTSIDE
      // that branch entirely for exactly this reason (0033's own comment).
      // Only the owner arm of this fix was probed before this task
      // (progress ledger, Task 3 minor).
      const { data: reachable, error } = await customer.adminClient.rpc('member_reachable', {
        p_member_id: memberId,
        p_organization_id: customer.organizationId,
        p_permission: 'members.view',
      });
      expect(error).toBeNull();
      expect(reachable).toBe(true);
    },
  );

  it(
    'gap 5a: member_consents is visible only at the Station that recorded it, not from a sibling Station the caller can otherwise reach',
    async () => {
      const label = `mem-consents-rls-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');
      const memberId = await createMemberAs(customer, customer.companyId, {
        fullName: `Consent RLS Probe ${label}`,
      });
      const owner = await signInAs(customer.email, customer.password);
      const { error: linkError } = await owner.rpc('link_member_to_company', {
        p_member_id: memberId,
        p_company_id: stationB,
      });
      expect(linkError).toBeNull();

      const opB = await grantRoleWith(customer, `${label}-b`, ['members.view', 'members.edit'], [stationB]);
      const opBClient = await signInAs(opB.email, opB.password);
      const consent = await opBClient.rpc('record_member_consent', {
        p_member_id: memberId,
        p_company_id: stationB,
        p_consent_type: 'rules',
        p_granted: true,
      });
      expect(consent.error).toBeNull();

      // opA holds members.view at Station A — a real, non-empty permission
      // that reaches this Member through Station A's own link, exactly the
      // condition under which member_reachable (any-link) would wrongly
      // admit them if this table's policy called that function instead of
      // its own per-row company_id check (0035's own comment explains why
      // the four child tables cannot reuse member_reachable for this
      // reason).
      const opA = await grantRoleWith(customer, `${label}-a`, ['members.view']);
      const opAClient = await signInAs(opA.email, opA.password);
      const { data: hiddenFromA, error: hiddenError } = await opAClient
        .from('member_consents')
        .select('id')
        .eq('member_id', memberId);
      expect(hiddenError).toBeNull();
      expect(hiddenFromA).toEqual([]);

      const { data: visibleToB, error: visibleError } = await opBClient
        .from('member_consents')
        .select('id')
        .eq('member_id', memberId);
      expect(visibleError).toBeNull();
      expect(visibleToB).toEqual([{ id: consent.data }]);
    },
  );

  it(
    "gap 5b: an Organization-wide block does not leak to a delegate who cannot reach the Member's own Station",
    async () => {
      const label = `mem-blocks-rls-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const stationB = await addCompany(customer, 'Station Two');
      const memberId = await createMemberAs(customer, stationB, { fullName: `Block RLS Probe ${label}` });

      const opB = await grantRoleWith(customer, `${label}-b`, ['members.view', 'members.block'], [stationB]);
      const opBClient = await signInAs(opB.email, opB.password);
      const block = await opBClient.rpc('block_member', {
        p_member_id: memberId,
        p_kind: 'draw_ban',
        p_reason: 'org-wide, Station B recorded it',
      });
      expect(block.error).toBeNull();

      // opA holds members.view at Station A only, so has_org_permission
      // ('members.view', org) is true through that role — half of the
      // member_blocks READ policy's own org-wide disjunct (0035:164) — but
      // opA has no link at all to Station B, so the policy's OTHER half, an
      // exists() over member_company_links requiring members.view at some
      // Station the Member is linked to, fails. That second half — not
      // has_org_permission, and not block_member's own write gate, which
      // uses has_org_permission('members.block', ...), a different
      // permission entirely (0034:584) — must be what refuses opA here.
      // Owner's ruling, Task 5 review, added this second half after finding
      // the org-wide branch originally read every Organization-wide block
      // for any members.view holder, disclosing exactly what
      // members_select_reachable hides.
      const opA = await grantRoleWith(customer, `${label}-a`, ['members.view']);
      const opAClient = await signInAs(opA.email, opA.password);
      const { data: hiddenFromA, error: hiddenError } = await opAClient
        .from('member_blocks')
        .select('id')
        .eq('member_id', memberId);
      expect(hiddenError).toBeNull();
      expect(hiddenFromA).toEqual([]);

      const { data: visibleToB, error: visibleError } = await opBClient
        .from('member_blocks')
        .select('id')
        .eq('member_id', memberId);
      expect(visibleError).toBeNull();
      expect(visibleToB).toEqual([{ id: block.data }]);
    },
  );

  it(
    'bonus (rule 2): a raw eleven-digit CPF sent directly to create_member is refused by the database CHECK, not only by Node hashing it away first',
    async () => {
      const label = `mem-raw-cpf-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const delegate = await grantRoleWith(customer, label, ['members.create']);
      const client = await signInAs(delegate.email, delegate.password);

      const raw = await client.rpc('create_member', {
        p_company_id: customer.companyId,
        p_full_name: `Raw CPF Probe ${label}`,
        // Eleven digits — what a caller bypassing services/members.ts's
        // hashCpf would send. 0031's own CHECK (`cpf_hash ~
        // '^[0-9a-f]{64}$'`) exists precisely so this cannot land in the
        // column even if Node's own hashing step were skipped or bypassed.
        p_cpf_hash: '12345678909',
      });
      expect(raw.error).not.toBeNull();
      expect(raw.error!.message).toMatch(/violates check constraint "members_cpf_hash_check"/);
    },
  );
});
