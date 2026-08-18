import { z } from 'zod';
import { GENDER_VALUES } from '@/lib/conversation/steps';
import { MUSIC_REQUEST_CHANNELS } from '@/schemas/music';

/**
 * Block 29d-1. The shape of "what was filtered" for each of the three screens
 * a send list can be cut from, plus the source vocabulary (0237) that says
 * which shape applies.
 *
 * SORT, DIRECTION, LIMIT AND THE CURSOR ARE ALL DELIBERATELY ABSENT. None of
 * them changes who is in a list -- they only change the order rows arrive in,
 * or how many arrive per round trip -- and resolveListMembers
 * (services/send-lists.ts) manages its own cursor and picks its own ordering
 * so that a list's membership never depends on which column the screen
 * happened to be sorted by when the operator clicked "create list".
 *
 * EVERY OTHER FIELD HERE IS A DIRECT NARROWING, mirrored from the same
 * screen's own params type (MemberListParams, ParticipationListParams,
 * RequestListParams in services/members|participations|music.ts) so that a
 * list's stored `filters` can always be replayed through the one function
 * that already knows how to read it -- never a second, independently
 * maintained description of the same narrowing.
 */

export const SEND_LIST_SOURCES = ['members', 'participations', 'requests'] as const;
export const sendListSourceSchema = z.enum(SEND_LIST_SOURCES);
export type SendListSource = z.infer<typeof sendListSourceSchema>;

/** Mirrors MemberListParams (services/members.ts), minus sort/direction/cursor -- see this file's header. */
export const memberSendListFiltersSchema = z.object({
  organizationId: z.string().uuid(),
  search: z.string().trim().min(1).optional(),
  ageMin: z.number().int().min(0).optional(),
  ageMax: z.number().int().min(0).optional(),
  blockedOnly: z.boolean().optional(),
  hasRulesConsent: z.boolean().optional(),
  // 'none' is a fourth population alongside the three stored codes -- nobody
  // asked, not merely nobody said yes (GenderValue's own distinction, and
  // members/list-params.ts's parseGender carries the identical pair).
  gender: z.enum([...GENDER_VALUES, 'none'] as const).optional(),
  registeredFrom: z.string().optional(),
  registeredTo: z.string().optional(),
});
export type MemberSendListFilters = z.infer<typeof memberSendListFiltersSchema>;

// The two vocabularies below mirror participation_status and
// participation_source (0052's enums, confirmed against the generated
// database.types.ts) rather than importing PARTICIPATION_STATUSES from
// @/lib/participation-status: that constant is typed as a plain
// `readonly ParticipationStatus[]`, not the `[T, ...T[]]` tuple z.enum
// requires, and schemas/music.ts already hand-copies its own small,
// stable enums (MUSIC_REQUEST_CHANNELS and neighbours) for the same reason.
const PARTICIPATION_STATUS_VALUES = ['VALID', 'DUPLICATE', 'TOO_SOON', 'OVER_LIMIT'] as const;
const PARTICIPATION_SOURCE_VALUES = ['MANUAL', 'IMPORT', 'WHATSAPP', 'WEB'] as const;

/** Mirrors ParticipationListParams (services/participations.ts), minus its cursor pair -- see this file's header. */
export const participationSendListFiltersSchema = z.object({
  companyId: z.string().uuid(),
  promotionId: z.string().uuid().optional(),
  status: z.enum(PARTICIPATION_STATUS_VALUES).optional(),
  source: z.enum(PARTICIPATION_SOURCE_VALUES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().trim().min(1).optional(),
  answeredCorrectly: z.boolean().optional(),
  optionId: z.string().uuid().optional(),
});
export type ParticipationSendListFilters = z.infer<typeof participationSendListFiltersSchema>;

// music_request_read_status and music_request_play_status (0189/0191). No
// exported runtime array exists for either in schemas/music.ts -- only the
// two type aliases -- so these are hand-copied here on the same convention.
const REQUEST_READ_STATUS_VALUES = ['UNREAD', 'READ', 'CANCELLED'] as const;
const REQUEST_PLAY_STATUS_VALUES = ['NOT_PLAYED', 'PLAYED', 'CANCELLED'] as const;

/**
 * Mirrors RequestListParams (services/music.ts), minus sort/limit/cursor.
 *
 * `channel` DELIBERATELY USES MUSIC_REQUEST_CHANNELS (two values: MANUAL,
 * IMPORT), NOT the full four-value music_request_channel enum
 * (MANUAL/IMPORT/API/WEB) MusicRequestChannel itself carries. This is not a
 * narrower copy of the database's vocabulary by accident -- it is the exact
 * vocabulary music/requests/list-params.ts's own parseChannel already limits
 * the screen's filter form to, so this schema stays faithful to what a
 * "filters that built this list" payload could actually have come from,
 * rather than accepting a value the screen itself could never have sent.
 */
export const requestSendListFiltersSchema = z.object({
  companyId: z.string().uuid(),
  songId: z.string().uuid().optional(),
  showId: z.string().uuid().optional(),
  channel: z.enum(MUSIC_REQUEST_CHANNELS).optional(),
  search: z.string().trim().min(1).optional(),
  readStatus: z.enum(REQUEST_READ_STATUS_VALUES).optional(),
  playStatus: z.enum(REQUEST_PLAY_STATUS_VALUES).optional(),
});
export type RequestSendListFilters = z.infer<typeof requestSendListFiltersSchema>;

/** Which filters shape applies to which source -- resolveListMembers' own overloads key off this. */
export interface SendListFiltersMap {
  members: MemberSendListFilters;
  participations: ParticipationSendListFilters;
  requests: RequestSendListFilters;
}

/**
 * Task 6. What the two write doors that take a name/id pair need --
 * rename_send_list's own two arguments and delete_send_list's own one
 * (0239). Not a third filters shape: these two never touch `filters` at all.
 */
export const renameSendListSchema = z.object({
  listId: z.string().uuid(),
  name: z.string().trim().min(1),
});
export type RenameSendListInput = z.infer<typeof renameSendListSchema>;

export const deleteSendListSchema = z.object({
  listId: z.string().uuid(),
});
export type DeleteSendListInput = z.infer<typeof deleteSendListSchema>;
