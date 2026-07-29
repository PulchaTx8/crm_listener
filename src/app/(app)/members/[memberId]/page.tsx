import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getMember,
  listMemberBlocks,
  listMemberConsents,
  listMemberNotes,
  listMemberStations,
  memberReachable,
} from '@/services/members';
import type {
  MemberBlockRow,
  MemberConsentRow,
  MemberDetail,
  MemberNoteRow,
  MemberStationRow,
} from '@/services/members';
import { describeMembersReadError } from '../errors';
import {
  BLOCK_KIND_LABELS,
  CONSENT_TYPE_LABELS,
  formatCalendarDate,
  formatDate,
  formatDateTime,
} from '../format';
import { BlockForm } from '../block-form';
import { ConsentForm } from '../consent-form';
import { EraseMemberForm } from '../erase-member-form';
import { LiftBlockButton } from '../lift-block-button';

// Renders from the caller's session cookies and a live per-listener
// reachability check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let member: MemberDetail | null;
  let consents: MemberConsentRow[] = [];
  let notes: MemberNoteRow[] = [];
  let blocks: MemberBlockRow[] = [];
  let stations: MemberStationRow[] = [];
  try {
    member = await getMember(memberId, accessToken);
    // Skipped entirely when the listener itself did not come back: each of
    // these four reads is independently RLS-scoped to `memberId`, so nothing
    // here would return anything for a caller who cannot even reach the
    // listener's own row — but there is no reason to make four requests to
    // learn that a fifth already told us.
    if (member) {
      [consents, notes, blocks, stations] = await Promise.all([
        listMemberConsents(memberId, accessToken),
        listMemberNotes(memberId, accessToken),
        listMemberBlocks(memberId, accessToken),
        listMemberStations(memberId, accessToken),
      ]);
    }
  } catch (cause) {
    logger.error({ err: cause, memberId }, 'could not load this listener');
    return <LoadError message={describeMembersReadError(cause)} />;
  }

  // Collapses three different facts — the listener was archived, never
  // existed, or exists but is linked only to Stations this caller cannot
  // reach — into one honest message, the same reasoning
  // inventory/[prizeId]/page.tsx's own NotFound gives for a prize: RLS is the
  // boundary, and it does not leak which of the three actually happened.
  if (!member) return <NotFound />;

  // member_reachable (0033) takes an organizationId, not a companyId — the
  // same "caller's first live organization_membership" resolution
  // page.tsx uses for the list screen, needed here only for these three
  // courtesy gates below (Task 9's forms). The RPCs themselves
  // (record_member_consent/block_member/anonymize_member, 0034) re-check
  // their own permission from the row regardless of what this resolves to.
  // `user` is the same one resolved (and confirmed non-null) at the top of
  // this function.
  const { data: memberships } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  const organizationId = memberships?.[0]?.organization_id;

  // Rendered only as a courtesy — see this file's own precedent
  // (inventory/[prizeId]/page.tsx's permissions block) for why these three
  // RPCs are still the boundary regardless of what this resolves to. A member
  // whose organizationId could not be resolved (should not happen once
  // `member` itself came back non-null, since RLS already proved the caller
  // reaches this Organization) sees none of the three forms rather than a
  // thrown error — failing to a hidden form, not a broken page.
  let canEdit = false;
  let canBlock = false;
  let canErase = false;
  if (organizationId) {
    try {
      [canEdit, canBlock, canErase] = await Promise.all([
        memberReachable(memberId, organizationId, 'members.edit', accessToken),
        memberReachable(memberId, organizationId, 'members.block', accessToken),
        memberReachable(memberId, organizationId, 'members.erase', accessToken),
      ]);
    } catch (cause) {
      logger.error({ err: cause, memberId }, 'could not resolve member action permissions');
    }
  }

  const companyNameById = new Map(stations.map((s) => [s.companyId, s.companyName]));
  // True only when at least one Station the caller can reach currently
  // treats this listener as blocked (is_member_blocked, computed per Station
  // inside listMemberStations) — an org-wide block already answers true
  // against any one reachable Station, so this does not miss one merely
  // because it was checked through a Station other than where it was raised.
  const currentlyBlocked = stations.some((s) => s.blocked);
  // A consent's origin, a note's body and a block's reason/lift_reason are
  // each nulled by exactly one write path (anonymize_member, 0034, Ruling B)
  // — for notes and block reasons that write is the ONLY way any of them can
  // ever be null (add_member_note/block_member both enforce a non-blank
  // value at creation), so a null there always means "erased", never "never
  // recorded". A consent's origin is the one exception: record_member_consent
  // leaves it optional from the start, so a null origin on a listener who was
  // never anonymised genuinely means "no origin was given" — this flag is
  // what tells the three sections below which of those two null states they
  // are looking at (Task 8 review: rendering the same scrubbed-vs-never-set
  // null three different ways across those sections was the defect).
  const erased = Boolean(member.anonymizedAt);

  return (
    <>
      <PageHeader
        title={member.anonymizedAt ? 'Personal data erased' : (member.fullName ?? 'Unnamed listener')}
        description={member.anonymizedAt ? `Erased ${formatDate(member.anonymizedAt)}` : undefined}
        action={
          <Link href="/members" className="text-sm text-primary underline underline-offset-2">
            Back to members
          </Link>
        }
      />

      {currentlyBlocked && (
        <p
          data-testid="member-blocked-banner"
          className="mb-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Currently blocked at one or more Stations you can reach — see Stations below.
        </p>
      )}

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {member.anonymizedAt ? (
              <p className="text-muted-foreground sm:col-span-2">
                This listener&apos;s personal data was erased. The record is kept so their
                participations and deliveries still reference something.
              </p>
            ) : (
              <>
                <Field label="Phone" value={member.phone} />
                <Field label="E-mail" value={member.email} />
                <Field label="CPF" value={member.cpfLastDigits ? `···${member.cpfLastDigits}` : null} />
                <Field label="Passport" value={member.passport} />
                <Field
                  label="Birth date"
                  value={member.birthDate ? formatCalendarDate(member.birthDate) : null}
                />
                <Field label="How they found the station" value={member.discoverySource} />
                <Field
                  label="Address"
                  value={
                    [
                      member.addressLine,
                      member.addressNumber,
                      member.addressComplement,
                      member.neighbourhood,
                      member.city,
                      member.state,
                      member.postalCode,
                    ]
                      .filter(Boolean)
                      .join(', ') || null
                  }
                />
                <Field
                  label="First contact"
                  value={
                    member.firstContactAt
                      ? `${formatDateTime(member.firstContactAt)}${
                          member.firstContactOrigin ? ` — ${member.firstContactOrigin}` : ''
                        }`
                      : null
                  }
                />
              </>
            )}
            <Field label="Registered" value={formatDate(member.createdAt)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stations</CardTitle>
          </CardHeader>
          <CardContent>
            {stations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Station you can reach has this listener linked.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {stations.map((s) => (
                  <div
                    key={s.companyId}
                    data-testid="member-station-row"
                    className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 text-sm last:border-0 last:pb-0"
                  >
                    <span className="font-medium">{s.companyName}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      Linked {formatDate(s.linkedAt)}
                      {s.blocked && (
                        <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                          Blocked
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Consents</CardTitle>
          </CardHeader>
          <CardContent>
            {consents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No consent recorded yet at a Station you can reach.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {consents.map((c) => (
                  <div
                    key={c.id}
                    data-testid="member-consent-row"
                    className="border-b pb-3 text-sm last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{CONSENT_TYPE_LABELS[c.consentType]}</span>
                      <span
                        className={
                          c.granted
                            ? 'text-xs font-medium text-primary'
                            : 'text-xs font-medium text-muted-foreground'
                        }
                      >
                        {c.granted ? 'Granted' : 'Withdrawn'}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      {companyNameById.get(c.companyId) ?? 'A Station'} ·{' '}
                      {formatDateTime(c.grantedAt)}
                      {c.origin
                        ? ` — ${c.origin}`
                        : erased
                          ? ' — (personal data erased)'
                          : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            {notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No note recorded yet at a Station you can reach.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {notes.map((n) => (
                  <div
                    key={n.id}
                    data-testid="member-note-row"
                    className="border-b pb-3 text-sm last:border-0 last:pb-0"
                  >
                    {/* body is null only when anonymize_member scrubbed it
                        (add_member_note enforces a non-blank body at
                        creation, 0034) — never "was left blank". */}
                    <p>{n.body ?? '(personal data erased)'}</p>
                    <p className="text-muted-foreground">
                      {companyNameById.get(n.companyId) ?? 'A Station'} · {formatDateTime(n.createdAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Block history</CardTitle>
          </CardHeader>
          <CardContent>
            {blocks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No block recorded yet at a Station you can reach.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {blocks.map((b) => (
                  <div
                    key={b.id}
                    data-testid="member-block-row"
                    className="border-b pb-3 text-sm last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{BLOCK_KIND_LABELS[b.kind]}</span>
                      <span className="text-xs font-medium text-muted-foreground">
                        {b.companyId ? (companyNameById.get(b.companyId) ?? 'A Station') : 'Organization-wide'}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      From {formatDateTime(b.startsAt)}
                      {b.endsAt ? ` until ${formatDateTime(b.endsAt)}` : ', no end date set'}
                    </p>
                    {/* reason is null only when anonymize_member scrubbed it
                        (block_member enforces a non-blank reason at
                        creation, 0034) — never "no reason was given". */}
                    <p>{b.reason ?? '(personal data erased)'}</p>
                    {/* Whether THIS row is still in effect right now is
                        deliberately not stated here — see listMemberBlocks'
                        own comment (services/members.ts) for why that
                        judgement is left to is_member_blocked (surfaced
                        above as the Stations section's per-row badge and the
                        banner) rather than re-derived from these dates. What
                        is shown below is only the directly observed fact:
                        whether a lift was ever recorded — "No lift recorded"
                        states that fact alone and does not claim the block is
                        therefore still in effect (an expired, never-lifted
                        block would render identically here, which is
                        correct: this line answers "was it lifted", not "is
                        it active"). liftReason null while liftedAt is set can
                        only mean anonymize_member scrubbed it — lift_member_
                        block (0034) enforces a non-blank lift_reason at the
                        moment of lifting, so there is no "lifted without
                        giving a reason" state for the fallback below to
                        confuse this one with. */}
                    <p className="text-muted-foreground">
                      {b.liftedAt
                        ? `Lifted ${formatDateTime(b.liftedAt)}${
                            b.liftReason ? ` — ${b.liftReason}` : ' — (personal data erased)'
                          }`
                        : 'No lift recorded'}
                    </p>
                    {/* Rendered only as a courtesy — lift_member_block (0034)
                        re-checks members.block itself before writing
                        anything. canBlock is the same flag that gates the
                        "Block this listener" card below, so a caller sees
                        both or neither. */}
                    {canBlock && !b.liftedAt && (
                      <div className="mt-2">
                        <LiftBlockButton blockId={b.id} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Each rendered only as a courtesy — record_member_consent,
            block_member and anonymize_member (0034) each re-check their own
            permission themselves before writing anything, so hiding a form
            from someone who lacks it is convenience, not the refusal itself
            (the same reasoning inventory/[prizeId]/page.tsx's own permission
            gates carry). Consent and Block are restricted to `erased ===
            false` implicitly by their own RPCs (both refuse an anonymised
            listener, 0034), so no separate check is needed here beyond
            member_reachable itself. Erase is hidden outright once already
            erased — there is nothing left for it to do. */}
        {/* stations.length > 0 as well as canEdit: record_member_consent has
            no Organization-wide shape (unlike block_member), so a caller who
            holds members.edit somewhere without holding members.view at any
            Station this listener is linked to (member_company_links'
            own select policy is gated on members.view, not edit — an unusual
            role composition, but not one the permission catalogue forbids)
            would otherwise see a form with no valid Station to choose. */}
        {canEdit && !erased && stations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Record consent</CardTitle>
            </CardHeader>
            <CardContent>
              <ConsentForm memberId={member.id} stations={stations} />
            </CardContent>
          </Card>
        )}

        {/* stations.length > 0, same guard as Consent immediately above and
            for the same reason (Task 9 re-review, Important): canBlock is
            memberReachable(..., 'members.block', ...), true for an ordinary
            delegate holding members.block at ANY Station this listener is
            linked to (member_reachable's per-link exists(), 0033:58-66) —
            but `stations` comes from listMemberStations, filtered by
            member_company_links_select_reachable, which is gated on
            members.view (0035:106-112), a DIFFERENT permission code
            (0031:141-144). A delegate holding members.block without
            members.view at the listener's only linked Station has exactly
            canBlock === true and stations === [] — a real, reachable state,
            not the "owner/platform-admin only" case an earlier draft of
            this comment (and of block-form.tsx's own) claimed. Without this
            guard such a caller saw a Scope picker offering only "Whole
            Organization", which block_member's own has_org_permission gate
            would then refuse for anyone who holds members.block only at
            that one Station — a silent dead end, not a working form. */}
        {canBlock && !erased && stations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Block this listener</CardTitle>
            </CardHeader>
            <CardContent>
              <BlockForm memberId={member.id} stations={stations} />
            </CardContent>
          </Card>
        )}

        {canErase && !erased && (
          <Card>
            <CardHeader>
              <CardTitle>Erase personal data</CardTitle>
            </CardHeader>
            <CardContent>
              <EraseMemberForm memberId={member.id} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader
        title="Listener"
        action={
          <Link href="/members" className="text-sm text-primary underline underline-offset-2">
            Back to members
          </Link>
        }
      />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="Listener not found" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            This listener does not exist, or you do not have permission to view them at a Station
            you can reach.
          </p>
          <Link href="/members" className="text-sm text-primary underline underline-offset-2">
            Back to members
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
