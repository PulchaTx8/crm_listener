/**
 * Block 8b. What a report IS, in one file, with no import that would tie it to
 * the server: the writers, the schemas, the screens and the unit tests all read
 * from here, and a value that lived in two of them would drift.
 *
 * `period.ts` in the dashboards folder is the precedent and the reason this
 * carries no `server-only`: a pure module needs no stub in vitest.config.ts.
 */

export const REPORT_TYPES = [
  'LISTENERS',
  'PARTICIPATIONS',
  'WINNERS',
  'MUSIC_REQUESTS',
  'MOVEMENTS',
  'AUDIENCE_PANEL',
  'MUSIC_PANEL',
  'PROMOTIONS_PANEL',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export const LISTING_TYPES = [
  'LISTENERS',
  'PARTICIPATIONS',
  'WINNERS',
  'MUSIC_REQUESTS',
  'MOVEMENTS',
] as const;

export type ListingType = (typeof LISTING_TYPES)[number];

export const PANEL_TYPES = ['AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL'] as const;

export type PanelType = (typeof PANEL_TYPES)[number];

export function isPanelType(type: ReportType): type is PanelType {
  return (PANEL_TYPES as readonly string[]).includes(type);
}

export const REPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The row ceiling, matching 0127's own constant. Above it a request is refused. */
export const REPORT_ROW_CEILING = 50_000;

/** How many rows the worker asks for per page. */
export const REPORT_PAGE_SIZE = 1_000;

export interface ReportColumn {
  /** The key in the page function's `row_data` jsonb. */
  key: string;
  /** The heading a human reads. */
  header: string;
}

/**
 * Column ORDER and headings, per listing type. The keys must match the
 * `jsonb_build_object` calls in 0124 and 0125 exactly: a key here that the SQL
 * does not produce becomes a column of blanks, which is the one thing D7
 * forbids — an empty column is a statement about the data, not about the query.
 * `tests/unit/reports/columns.test.ts` holds the two in agreement.
 *
 * A withheld key is not removed from this list; the writer skips it and the
 * provenance block names it. Keeping it here is what lets the file say WHICH
 * column is missing rather than just being narrower than expected.
 */
export const REPORT_COLUMNS: Record<ListingType, readonly ReportColumn[]> = {
  LISTENERS: [
    { key: 'station', header: 'Station' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone' },
    { key: 'email', header: 'E-mail' },
    // Three digits, and there is no fuller column anywhere: 0031 stores a
    // SHA-256 and says the raw number "is stored nowhere and appears in no
    // query log".
    { key: 'cpf_last_digits', header: 'CPF (last 3)' },
    { key: 'birth_date', header: 'Birth date' },
    { key: 'city', header: 'City' },
    { key: 'state', header: 'State' },
    { key: 'discovery_source', header: 'Discovery source' },
    { key: 'situation', header: 'Situation' },
    { key: 'consent', header: 'Consent' },
    { key: 'linked_at', header: 'Joined at' },
  ],
  PARTICIPATIONS: [
    { key: 'station', header: 'Station' },
    { key: 'promotion', header: 'Promotion' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone' },
    { key: 'cpf_last_digits', header: 'CPF (last 3)' },
    { key: 'status', header: 'Status' },
    { key: 'source', header: 'Source' },
    { key: 'participated_at', header: 'Participated at' },
  ],
  WINNERS: [
    { key: 'station', header: 'Station' },
    { key: 'promotion', header: 'Promotion' },
    { key: 'prize', header: 'Prize' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone' },
    { key: 'rank', header: 'Rank' },
    { key: 'status', header: 'Status' },
    { key: 'drawn_at', header: 'Drawn at' },
    { key: 'deadline_at', header: 'Deadline' },
    { key: 'met_deadline', header: 'Met deadline' },
  ],
  MUSIC_REQUESTS: [
    { key: 'station', header: 'Station' },
    { key: 'song', header: 'Song' },
    { key: 'artist', header: 'Artist' },
    { key: 'song_archived', header: 'Song archived' },
    { key: 'show', header: 'Show' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone' },
    { key: 'channel', header: 'Channel' },
    { key: 'requested_at', header: 'Requested at' },
  ],
  MOVEMENTS: [
    { key: 'station', header: 'Station' },
    { key: 'moved_at', header: 'Moved at' },
    { key: 'prize', header: 'Prize' },
    { key: 'promotion', header: 'Promotion' },
    { key: 'promotion_archived', header: 'Promotion archived' },
    { key: 'movement_type', header: 'Type' },
    { key: 'quantity', header: 'Quantity' },
    { key: 'from_bucket', header: 'From' },
    { key: 'to_bucket', header: 'To' },
    // Both, and 0096's header explains why neither alone will do: actor is
    // nullable for a human with no display name AND for the clock, and only
    // actor_id tells those apart.
    { key: 'actor', header: 'Actor' },
    { key: 'actor_id', header: 'Actor id' },
    { key: 'note', header: 'Note' },
  ],
};

/** Which permission would have carried a withheld column, for the provenance block. */
export const WITHHELD_BY_PERMISSION: Record<string, string> = {
  name: 'members.view',
  phone: 'members.view',
  email: 'members.view',
  cpf_last_digits: 'members.view',
};

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  LISTENERS: 'Listeners',
  PARTICIPATIONS: 'Participations',
  WINNERS: 'Winners and deliveries',
  MUSIC_REQUESTS: 'Music requests',
  MOVEMENTS: 'Inventory movements',
  AUDIENCE_PANEL: 'Audience panel',
  MUSIC_PANEL: 'Music panel',
  PROMOTIONS_PANEL: 'Promotions panel',
};

export const FORMAT_EXTENSIONS: Record<ReportFormat, string> = {
  CSV: 'csv',
  XLSX: 'xlsx',
  PDF: 'pdf',
};

export const FORMAT_CONTENT_TYPES: Record<ReportFormat, string> = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};

/** One row as the page functions return it. */
export interface ReportPageRow {
  sort_at: string;
  sort_id: string;
  row_data: Record<string, unknown>;
  total_count: number;
  withheld: string[];
}
