/**
 * Block 30a. What an operator sees before they ask to see it.
 *
 * PURE, AND IN `lib` RATHER THAN BESIDE A SCREEN. `maskedPhone` lived in
 * `music/requests/request-status.tsx` from Block 22 until this block, and
 * `participations/participation-dialog.tsx` already reached across two feature
 * folders to import it — which is the shape that says a rule has outgrown the
 * screen that first needed it. Three screens render these now.
 *
 * NONE OF THIS IS A BOUNDARY. The boundary is `list_*`'s projection, which no
 * longer sends the whole value, and `reveal_member_field`, which records who
 * asked for it. These functions decide what a value LOOKS like once the door
 * has already decided the operator may have it — masking a value the page
 * already carries would be a lock on a door standing in an open field
 * (`services/music.ts` says the same about the number this replaces).
 */

/** Four of them, so a mask reads as a mask at any font size. */
export const DOTS = '••••';

/**
 * The last four digits of anything, or null under four.
 *
 * Digits only, because `normalize_phone` (0031) is digits only and a mask that
 * counted punctuation would show three digits for `(11) 985-95` and four for
 * the same number typed without the dash.
 *
 * NULL RATHER THAN WHATEVER IS THERE. A mask that reveals a two-digit number is
 * not a mask — `participation-dialog.tsx` stated this for phones in Block 24,
 * and it is the reason this returns null instead of padding.
 */
export function lastFourDigits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length < 4 ? null : digits.slice(-4);
}

/** `•••• 4985`, or bare dots when there are no four digits to stand behind them. */
export function maskedPhone(last4: string | null): string {
  return last4 === null ? DOTS : `${DOTS} ${last4}`;
}

/**
 * `j•••@•••.com` — the first character and the suffix after the last dot.
 *
 * ANYTHING IT CANNOT TAKE APART IS MASKED WHOLE. An address with no `@`, an
 * empty local part, or a host with no dot are all masked entirely rather than
 * half-guessed: the point of showing the first letter and the TLD is that an
 * operator reading a support ticket can tell two listeners apart, and a partial
 * guess at a malformed value serves that badly while disclosing more.
 */
export function maskedEmail(email: string | null): string | null {
  const trimmed = email?.trim();
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf('@');
  if (at < 1) return DOTS;

  const host = trimmed.slice(at + 1);
  const dot = host.lastIndexOf('.');
  if (dot < 1 || dot === host.length - 1) return DOTS;

  return `${trimmed[0]}•••@•••${host.slice(dot)}`;
}

/** Same rule as a phone, on characters rather than digits: a passport is not numeric. */
export function maskedPassport(passport: string | null): string | null {
  const trimmed = passport?.trim();
  if (!trimmed) return null;
  return trimmed.length < 4 ? DOTS : `${DOTS} ${trimmed.slice(-4)}`;
}

/**
 * Dots, or null.
 *
 * ONE FACT, NOT THREE. A street, a number and a flat identify a household
 * together and disclose it together, so the card shows one row and the reveal
 * asks for one value — which is why `reveal_member_field` takes `address`
 * rather than three field names.
 */
export function maskedAddress(parts: {
  line: string | null;
  number: string | null;
  complement: string | null;
}): string | null {
  const anything = [parts.line, parts.number, parts.complement].some(
    (part) => (part ?? '').trim() !== '',
  );
  return anything ? DOTS : null;
}
