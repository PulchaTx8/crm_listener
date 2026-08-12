/**
 * Block 19b. What the application presentation draws above the panels, and the
 * one reader for the door that answers it.
 *
 * NOT `server-only`, and deliberately unlike its neighbour `session.ts`: these
 * two functions touch no secret and no request, and the parser is the shape a
 * unit test asserts without a database. The privileged half — the RPC call —
 * lives in `src/services/widget-installations.ts`, which is `server-only`.
 */
export interface StationIdentity {
  name: string;
  thumbUrl: string | null;
  /** Already an address, not a number: the component that draws it has no business reducing digits. */
  whatsappHref: string | null;
}

/**
 * `integrations.display_phone_number` is typed by an operator into a free-text
 * box, so `+55 11 98888-7777` and `5511988887777` both arrive. wa.me takes
 * digits and nothing else.
 *
 * NOTHING SURVIVING THE REDUCTION IS `null`, NOT `https://wa.me/`. An operator
 * who typed a note into the number box would otherwise produce a button that
 * opens an error page, and a listener who taps it learns that the Station's
 * widget is broken rather than that its number is unrecorded.
 */
export function whatsappHref(displayNumber: string | null): string | null {
  if (displayNumber === null) return null;
  const digits = displayNumber.replace(/\D/g, '');
  return digits === '' ? null : `https://wa.me/${digits}`;
}

/**
 * `widget_station_identity` (0185) answers a `jsonb` object, which reaches
 * supabase-js as `Json` — so the shape is checked rather than asserted, the
 * discipline `readAnswer` (door-answer.ts) and `readLinkAnswer` (enter/route.ts)
 * already apply to their own doors.
 *
 * ONE `null` FOR A REFUSAL AND FOR AN UNKNOWN SHAPE, unlike those two, and it
 * is safe here precisely because the caller has nothing to distinguish: the
 * page draws the header or does not, and §7 of the design says an unreachable
 * door is a missing header rather than a missing page. There is no second
 * branch for a reason to feed.
 */
export function readStationIdentity(data: unknown): StationIdentity | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (row.found !== true) return null;
  if (typeof row.name !== 'string') return null;
  return {
    name: row.name,
    thumbUrl: typeof row.thumb_url === 'string' ? row.thumb_url : null,
    whatsappHref: whatsappHref(typeof row.whatsapp_number === 'string' ? row.whatsapp_number : null),
  };
}
