/**
 * Converting between the instants the database stores and the wall-clock the
 * operator types, in the STATION's timezone rather than the browser's.
 *
 * One module because three callers need the same rule — the filter's two date
 * inputs and the promotion form's two datetime inputs — and a second copy of a
 * timezone conversion is how two controls on one screen start disagreeing
 * about which day a promotion starts (spec L2).
 */

/**
 * How far the zone was from UTC at that instant. Computed by asking what the
 * zone's wall-clock actually read, rather than assuming a fixed offset: Brazil
 * has run daylight saving before and may again, and a hard-coded -03:00 would
 * silently shift every window by an hour when it does.
 */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // Intl renders midnight as hour 24 in some engines under hour12: false.
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return asUtc - at.getTime();
}

/** `YYYY-MM-DD`, the shape `<input type="date">` wants, in the Station's zone. */
export function toZonedDate(instant: string | undefined, timeZone: string): string {
  if (!instant) return '';
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(instant));
}

/** `YYYY-MM-DDTHH:mm`, the shape `<input type="datetime-local">` wants, in the Station's zone. */
export function toZonedDateTime(instant: string | undefined, timeZone: string): string {
  if (!instant) return '';
  const at = new Date(instant);
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, timeZone));
  return shifted.toISOString().slice(0, 16);
}

/**
 * The inverse: a wall-clock the operator typed, read as that time in the
 * Station's zone, returned as an instant.
 *
 * The offset is looked up at the naive instant rather than the final one. On
 * the two days a year a zone changes offset those differ by an hour, and no
 * correct answer exists for a wall-clock inside the skipped hour — this picks
 * one deterministically instead of throwing at somebody filling in a form.
 */
export function fromZonedWallClock(value: string, timeZone: string): string | undefined {
  if (!value) return undefined;
  const naive = new Date(`${value}Z`);
  if (Number.isNaN(naive.getTime())) return undefined;
  return new Date(naive.getTime() - zoneOffsetMs(naive, timeZone)).toISOString();
}

/** A whole day in the Station's zone: its first instant, or its last. */
export function fromZonedDay(day: string, timeZone: string, endOfDay: boolean): string | undefined {
  if (!day) return undefined;
  return fromZonedWallClock(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`, timeZone);
}
