'use client';

import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/input';
import { GENDER_VALUES } from '@/lib/conversation/steps';

/**
 * The listener's sex, on both operator forms.
 *
 * ONE COMPONENT FOR TWO FORMS, where `CountryField` beside it is written twice.
 * The duplication is affordable for a country because the option list comes from
 * `Intl` and cannot drift; it is not affordable here, because these three
 * options must agree with a CHECK constraint (`members_gender_shape`, 0220) and
 * with `gender_normalize`'s three codes. A fourth code added in one form and not
 * the other is a save that fails on one screen and works on the next, and the
 * operator has no way to tell which screen is wrong.
 *
 * A SELECT, NOT A TEXT INPUT, for the reason the country field states for
 * itself: the column accepts three codes, so a typed answer meets a CHECK at
 * save time. The values come from `GENDER_VALUES` rather than being spelled
 * here, so the form cannot offer a code the column will not take.
 *
 * THE BLANK OPTION IS "not recorded", AND IT IS NOT THE SAME AS "declined".
 * `update_member` (0220) sets this column on every save, so choosing the blank
 * is how an operator UNDOES a wrong value — which is exactly why the decline has
 * a code of its own ('N') rather than being spelled as the empty selection. If
 * it did not, clearing a mistake and recording a refusal would be one click, and
 * a campaign filter could never tell them apart again.
 */
export function GenderSelect({ defaultValue }: { defaultValue: string }) {
  const t = useTranslations('members');
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{t('fieldGender')}</span>
      <Select name="gender" defaultValue={defaultValue} data-testid="member-gender">
        <option value="">{t('genderNotRecorded')}</option>
        {GENDER_VALUES.map((value) => (
          <option key={value} value={value}>
            {t(`gender_${value}`)}
          </option>
        ))}
      </Select>
    </label>
  );
}
