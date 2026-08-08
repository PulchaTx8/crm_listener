'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A password field with the show/hide control the sign-in screen was drawn
 * with.
 *
 * A client component for the one reason that justifies one here: the toggle is
 * state, and there is no server round trip that could hold it.
 *
 * IT STAYS AN ORDINARY `<input name=…>`. The form it sits in posts to a Server
 * Action, so nothing here may become a controlled value or a hidden field —
 * `type` is the only attribute this component owns, and the browser submits the
 * element exactly as it would without it.
 */
export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>) {
  const t = useTranslations('auth');
  const [revealed, setRevealed] = React.useState(false);

  return (
    <div className="relative">
      <Input
        type={revealed ? 'text' : 'password'}
        // Room for the button, so a long password does not run underneath it.
        className={cn('pr-10', className)}
        {...props}
      />
      <button
        type="button"
        // Without this the button is a submit button — the default inside a
        // form — and revealing the password would post it instead.
        onClick={() => setRevealed((shown) => !shown)}
        // The label states what the control DOES, not what it shows: a screen
        // reader reaching a hidden password should hear "show the password".
        aria-label={revealed ? t('hidePassword') : t('showPassword')}
        // The field's own value is what matters to a screen reader, and it
        // announces its type change on its own. `aria-pressed` would add a
        // second, competing description of the same state.
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {revealed ? (
          <EyeOff aria-hidden="true" className="h-4 w-4" />
        ) : (
          <Eye aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
