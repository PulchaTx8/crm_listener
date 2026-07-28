'use client';

import { useEffect, useState } from 'react';
import { useActionState } from 'react';
import Link from 'next/link';
import {
  checkMemberIdentifierAction,
  linkMemberToStationAction,
  registerMemberAction,
  type CheckIdentifierState,
  type LinkMemberState,
  type RegisterMemberState,
} from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { RegistrableStation } from './station-access';

const CHECK_INITIAL: CheckIdentifierState = { status: 'idle' };
const REGISTER_INITIAL: RegisterMemberState = { status: 'idle' };
const LINK_INITIAL: LinkMemberState = { status: 'idle' };

/**
 * Registration, split into exactly the two steps the brief requires: check
 * first, register second — so the person sees one of
 * find_member_by_identifier's three answers (spec §4, 0033) rather than a raw
 * 23505 unique-violation after the fact. The identifying fields (phone,
 * e-mail, CPF, passport) are checked via checkMemberIdentifierAction; only a
 * 'none' answer reveals the rest of the identity fields and the actual
 * registerMemberAction submit button below them.
 *
 * The four identifying inputs are locked (not merely re-usable) the moment a
 * check comes back, and carried into the registration submit as hidden
 * fields read from the SAME React state the check just ran against — not
 * re-read live from the (now-disabled) visible inputs — so what gets
 * registered is provably what was checked. "Edit search" is the only way to
 * change them, and doing so hides the registration step until a fresh check
 * runs.
 */
export function RegisterMemberForm({ stations }: { stations: RegistrableStation[] }) {
  const [companyId, setCompanyId] = useState(stations[0]?.id ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cpf, setCpf] = useState('');
  const [passport, setPassport] = useState('');
  const [manualEditing, setManualEditing] = useState(false);

  const [checkState, checkAction, checkPending] = useActionState(
    checkMemberIdentifierAction,
    CHECK_INITIAL,
  );
  const [registerState, registerAction, registerPending] = useActionState(
    registerMemberAction,
    REGISTER_INITIAL,
  );
  const [linkState, linkAction, linkPending] = useActionState(linkMemberToStationAction, LINK_INITIAL);

  // A fresh answer just arrived (including a fresh 'checked' after "Edit
  // search" was used to change something) — re-lock the fields against it,
  // the same reasoning member-search-form.tsx's own resync effect gives for
  // why a derived display must not go stale relative to the state it is
  // derived from.
  useEffect(() => {
    setManualEditing(false);
  }, [checkState]);

  const fieldsLocked = checkState.status === 'checked' && !manualEditing;
  const showRegistrationStep =
    checkState.status === 'checked' && checkState.outcome === 'none' && !manualEditing;

  return (
    <div className="flex flex-col gap-4">
      <form action={checkAction} data-testid="member-check-form" className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Station being registered at
          <Select
            name="companyId"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            disabled={fieldsLocked}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>

        <p className="text-xs text-muted-foreground">
          Enter at least one of the four below, then check for an existing listener before
          continuing — this Organization&apos;s audience is shared across every Station, so the
          same person entering at two Stations must be one record, not two.
        </p>

        <label className="flex flex-col gap-1 text-sm">
          Phone
          <Input
            name="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={fieldsLocked}
            maxLength={40}
            placeholder="e.g. 5511987654321"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          E-mail
          <Input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={fieldsLocked}
            maxLength={320}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          CPF
          <Input
            name="cpf"
            value={cpf}
            onChange={(e) => setCpf(e.target.value)}
            disabled={fieldsLocked}
            placeholder="000.000.000-00 or digits only"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Passport
          <Input
            name="passport"
            value={passport}
            onChange={(e) => setPassport(e.target.value)}
            disabled={fieldsLocked}
            maxLength={40}
          />
        </label>

        <div className="flex items-center gap-3">
          {!fieldsLocked ? (
            <Button type="submit" disabled={checkPending}>
              {checkPending ? 'Checking…' : 'Check for an existing listener'}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => setManualEditing(true)}>
              Edit search
            </Button>
          )}
        </div>

        {checkState.status === 'error' && (
          <p className="text-sm text-destructive">{checkState.message}</p>
        )}
      </form>

      {checkState.status === 'checked' && checkState.outcome === 'visible' && !manualEditing && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <p>
            A listener matching what you entered is already registered, and you can already see
            their record.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={`/members/${checkState.memberId}`}
              className="text-primary underline underline-offset-2"
            >
              View this listener
            </Link>
            <form action={linkAction} className="flex items-center gap-2">
              <input type="hidden" name="memberId" value={checkState.memberId} />
              <input type="hidden" name="companyId" value={companyId} />
              <Button type="submit" variant="outline" disabled={linkPending}>
                {linkPending ? 'Linking…' : 'Link them to this Station instead of registering again'}
              </Button>
            </form>
          </div>
          {linkState.status === 'saved' && (
            <p className="mt-2 text-sm text-emerald-700">
              Linked. This listener now also appears at the selected Station.
            </p>
          )}
          {linkState.status === 'error' && (
            <p className="mt-2 text-sm text-destructive">{linkState.message}</p>
          )}
        </div>
      )}

      {checkState.status === 'checked' && checkState.outcome === 'elsewhere' && !manualEditing && (
        <div
          data-testid="member-check-elsewhere"
          className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p>
            A listener matching one of these details is already registered in your Organization,
            at a Station you don&apos;t have access to. This screen can&apos;t show you who it is
            or which Station — that is by design, the same as it would be for anyone else&apos;s
            audience you cannot reach.
          </p>
          <p className="mt-2">
            Ask a colleague who works at that Station to look them up for you, or ask whoever
            manages access in your Organization to add you there. Once you can reach that Station,
            checking these same details again will find the existing record instead of stopping
            here.
          </p>
        </div>
      )}

      {showRegistrationStep && (
        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            No existing listener matches what you entered. Continue below to finish registering
            them.
          </p>
          <form
            action={registerAction}
            data-testid="register-member-form"
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="phone" value={phone} />
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="cpf" value={cpf} />
            <input type="hidden" name="passport" value={passport} />

            <label className="flex flex-col gap-1 text-sm">
              Name
              <Input name="fullName" required maxLength={200} />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Birth date
              <Input name="birthDate" type="date" />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Address
                <Input name="addressLine" maxLength={200} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Number
                <Input name="addressNumber" maxLength={20} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Complement
                <Input name="addressComplement" maxLength={200} placeholder="Optional" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Neighbourhood
                <Input name="neighbourhood" maxLength={120} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                City
                <Input name="city" maxLength={120} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                State
                <Input name="state" maxLength={100} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Postal code
                <Input name="postalCode" maxLength={20} />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              How they found the station
              <Input name="discoverySource" maxLength={200} placeholder="Optional" />
            </label>

            <fieldset className="flex flex-col gap-2 rounded-md border p-3">
              <legend className="px-1 text-xs uppercase tracking-wide text-muted-foreground">
                First contact
              </legend>
              <p className="text-xs text-muted-foreground">
                Fill in both together if this listener messaged the Station before registering —
                this is the evidence this product relies on for a listener who contacts the
                Station first having authorised the reply. Neither can be edited once saved.
              </p>
              <label className="flex flex-col gap-1 text-sm">
                When
                <Input name="firstContactAt" type="datetime-local" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Where (WhatsApp, phone call, in person…)
                <Textarea name="firstContactOrigin" maxLength={200} placeholder="Optional" />
              </label>
            </fieldset>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={registerPending}>
                {registerPending ? 'Registering…' : 'Register listener'}
              </Button>
              {registerState.status === 'saved' && (
                <p className="text-sm text-emerald-700">
                  Registered.{' '}
                  <Link
                    href={`/members/${registerState.memberId}`}
                    className="underline underline-offset-2"
                  >
                    View listener
                  </Link>
                </p>
              )}
            </div>

            {registerState.status === 'error' && (
              <p className="text-sm text-destructive">{registerState.message}</p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
