'use client';

import { useActionState, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { countryOptions } from '@/lib/countries';
import { ImageUploadField } from '@/components/media/image-upload-field';
import { inputFromKhz, type BroadcastBand } from '@/lib/frequency';
import { formatTaxId } from '@/lib/tax-id';
import { saveStationProfileAction, type StationProfileState } from './actions';
import type { CompanyProfileRecord } from '@/services/company-profile';

/**
 * The Station's own record, as the console reads and writes it (0153, 0155).
 *
 * An ALIAS rather than a second declaration of the same twenty-four fields: the
 * service that reads and writes them is the one place they are named, so this
 * form and that read cannot drift apart. `import type` is erased at compile
 * time, so the `server-only` guard on that module is not carried into the
 * client bundle -- the same direction page.tsx already relies on, in reverse.
 */
export type StationProfile = CompanyProfileRecord;

const IDLE: StationProfileState = { status: 'idle' };

/**
 * Everything this console can edit about a Station.
 *
 * Name, timezone and status are deliberately NOT here (design D10): this block
 * moved nothing about who may change them. The suspend/reactivate pair stays in
 * the row menu, where it was, because a status change is not a field.
 *
 * THE INVOICING BLOCK IS THE STATION'S OWN, and it is not a copy of the group's.
 * organizations.billing_entity says who EMITS an invoice; a radio has a legal
 * identity whatever that says, and this is where it is recorded (D7).
 *
 * THE PICTURE TRAVELS WITH THE FORM rather than uploading on pick, the shape
 * ImageUploadField was built for: the file and the fields succeed or fail
 * together, and there is no upload left behind when the record is refused.
 */
export function StationForm({
  companyId,
  profile,
  onSaved,
}: {
  companyId: string;
  profile: StationProfile;
  /**
   * Hands the saved record to the screen that owns the snapshot this form was
   * rendered from. Without it a save is invisible the moment this tab unmounts,
   * which switching tabs or closing the record is enough to do.
   */
  onSaved: (profile: StationProfile) => void;
}) {
  const t = useTranslations('admin');
  // For the country select's option names, which come from Intl rather than
  // from messages/*.json (src/lib/countries.ts says why).
  const locale = useLocale();
  const [state, action, pending] = useActionState(saveStationProfileAction, IDLE);

  // `profile` on a state means the read-back succeeded; its absence means the
  // write landed and only the refresh failed, and then there is nothing
  // truthful to hand upward -- so the snapshot keeps whatever it had rather
  // than being patched with a guess.
  useEffect(() => {
    if (state.status === 'saved' && state.profile) onSaved(state.profile);
    // onSaved is not a dependency on purpose: the parent re-creates it on every
    // render, and depending on it would re-report the same save each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Held in state because the frequency field's unit and label depend on it —
  // MHz for FM, kHz for AM, and nothing at all for a web-only Station.
  const [band, setBand] = useState<BroadcastBand | ''>(profile.broadcastBand ?? '');
  const [dirty, setDirty] = useState(false);

  const frequencyLabel =
    band === 'AM' ? t('frequencyInKhz') : band === 'FM' ? t('frequencyInMhz') : t('frequency');

  const markDirty = () => setDirty(true);

  return (
    // Keyed by Station, because the inputs are uncontrolled: moving from one
    // record to another without remounting would leave the previous Station's
    // values in the boxes.
    <form key={companyId} action={action} className="flex flex-col gap-5" data-testid="station-form">
      <input type="hidden" name="companyId" value={companyId} />

      <ImageUploadField
        name="thumb"
        kind="thumb"
        currentUrl={profile.thumbUrl}
        disabled={pending}
        onDirty={markDirty}
        label={t('stationPicture')}
        hint={t('shownOnTheStationCard')}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          {t('band')}
          <select
            name="broadcastBand"
            value={band}
            disabled={pending}
            onChange={(e) => {
              setBand(e.target.value as BroadcastBand | '');
              markDirty();
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            data-testid="station-band"
          >
            <option value="">—</option>
            <option value="FM">FM</option>
            <option value="AM">AM</option>
            <option value="WEB">{t('webOnly')}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {frequencyLabel}
          <Input
            name="frequency"
            type="text"
            inputMode="decimal"
            // A web-only Station has no dial position, and 0153's
            // companies_frequency_positive would refuse a 0 — so the field is
            // shut rather than left to be filled with something untrue.
            disabled={pending || band === '' || band === 'WEB'}
            defaultValue={inputFromKhz(profile.broadcastBand, profile.frequencyKhz)}
            onChange={markDirty}
            data-testid="station-frequency"
          />
        </label>
      </div>

      <fieldset className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t('address')}</legend>
        <TextField name="addressLine" label={t('street')} value={profile.addressLine} pending={pending} onDirty={markDirty} />
        <TextField name="addressNumber" label={t('number')} value={profile.addressNumber} pending={pending} onDirty={markDirty} />
        <TextField name="addressComplement" label={t('complement')} value={profile.addressComplement} pending={pending} onDirty={markDirty} />
        <TextField name="neighbourhood" label={t('neighbourhood')} value={profile.neighbourhood} pending={pending} onDirty={markDirty} />
        <TextField name="city" label={t('city')} value={profile.city} pending={pending} onDirty={markDirty} />
        <TextField name="state" label={t('state')} value={profile.state} pending={pending} onDirty={markDirty} />
        <TextField name="postalCode" label={t('postalCode')} value={profile.postalCode} pending={pending} onDirty={markDirty} />
        {/* Block 28. A SELECT, not a TextField, and update_company_profile
            (0213) RAISES 22023 for a country its resolver does not know rather
            than storing null — so this control and country_alpha2's own name
            list must offer the same set. tests/unit/countries.test.ts is what
            holds them together, because one of the two is SQL. */}
        <label className="flex flex-col gap-1 text-sm">
          {t('country')}
          <Select
            name="country"
            defaultValue={profile.country ?? ''}
            disabled={pending}
            onChange={markDirty}
            data-testid="station-country"
          >
            <option value="">{t('noCountry')}</option>
            {countryOptions(locale).map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
        </label>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField name="latitude" label={t('latitude')} value={profile.latitude?.toString() ?? null} pending={pending} onDirty={markDirty} />
        <TextField name="longitude" label={t('longitude')} value={profile.longitude?.toString() ?? null} pending={pending} onDirty={markDirty} />
      </div>
      {/* Said out loud, because the CHECK refuses one without the other and a
          constraint name is not an explanation. */}
      <p className="text-xs text-muted-foreground">{t('bothCoordinatesOrNeither')}</p>

      <fieldset className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {t('howTheStationIsReached')}
        </legend>
        <TextField name="contactEmail" label={t('contactEmail')} value={profile.contactEmail} pending={pending} onDirty={markDirty} />
        <TextField name="contactPhone" label={t('contactPhone')} value={profile.contactPhone} pending={pending} onDirty={markDirty} />
        {/* A scheme is added by the service when the operator omits one, because
            these land in an href — companies_website_shape refuses anything that
            is not http(s), and typing `instagram.com/radio` is what people do. */}
        <TextField name="websiteUrl" label={t('website')} value={profile.websiteUrl} pending={pending} onDirty={markDirty} />
        <TextField name="instagramUrl" label="Instagram" value={profile.instagramUrl} pending={pending} onDirty={markDirty} />
        <TextField name="facebookUrl" label="Facebook" value={profile.facebookUrl} pending={pending} onDirty={markDirty} />
        <TextField name="youtubeUrl" label="YouTube" value={profile.youtubeUrl} pending={pending} onDirty={markDirty} />
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {t('howTheStationDescribesItself')}
        </legend>
        <TextField name="tagline" label={t('tagline')} value={profile.tagline} pending={pending} onDirty={markDirty} />
        <label className="flex flex-col gap-1 text-sm">
          {t('description')}
          <textarea
            name="description"
            defaultValue={profile.description ?? ''}
            disabled={pending}
            onChange={markDirty}
            rows={3}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="station-description"
          />
        </label>
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {t('invoicingIdentity')}
        </legend>
        <TextField name="legalName" label={t('legalName')} value={profile.legalName} pending={pending} onDirty={markDirty} />
        {/* Shown punctuated and stored bare, exactly as the group's is. */}
        <TextField name="taxId" label={t('taxId')} value={formatTaxId(profile.taxId) || null} pending={pending} onDirty={markDirty} />
        <TextField name="municipalRegistration" label={t('municipalRegistration')} value={profile.municipalRegistration} pending={pending} onDirty={markDirty} />
        <TextField name="fiscalEmail" label={t('fiscalEmail')} value={profile.fiscalEmail} pending={pending} onDirty={markDirty} />
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {t('theStationKeepsItsOwnIdentity')}
        </p>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !dirty} data-testid="station-save">
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'saved' && (
          <span className="text-sm text-muted-foreground">{t('saved')}</span>
        )}
        {state.status === 'error' && (
          <span className="text-sm text-destructive" data-testid="station-error">
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

function TextField({
  name,
  label,
  value,
  pending,
  onDirty,
}: {
  name: string;
  label: string;
  value: string | null;
  pending: boolean;
  onDirty: () => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input
        name={name}
        defaultValue={value ?? ''}
        disabled={pending}
        onChange={onDirty}
        data-testid={`station-${name}`}
      />
    </label>
  );
}
