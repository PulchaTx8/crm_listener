import { randomUUID } from 'node:crypto';
import type { ApiErrorCode, ApiErrorDetail } from './errors';

/**
 * Headroom, not a proof of anything -- the same qualification the WhatsApp
 * webhook puts on its own ceiling. A caller that omits Content-Length, or lies
 * about it, is caught by nothing here; this only stops an unauthenticated caller
 * from making the route read a large body before there is any chance to reject
 * it.
 *
 * 256 KB is far above any honest payload: the largest of them is one Deezer
 * track object beside a listener's name and phone.
 */
export const MAX_BODY_BYTES = 256_000;

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Echoed if the caller sent one, minted if not.
 *
 * Without this, "it failed yesterday around two" is not investigable: our log
 * line and the caller's log line have nothing in common to join on.
 *
 * Bounded, because it is written into a response header and into a log: an
 * unbounded caller-supplied string in either is somebody else's problem waiting
 * to become ours.
 */
export function requestId(request: Request): string {
  const supplied = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (supplied && supplied.length <= 200) return supplied;
  return randomUUID();
}

export function jsonOk(body: unknown, status: number, id: string): Response {
  return Response.json(body, { status, headers: { [REQUEST_ID_HEADER]: id } });
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  id: string,
  details?: ApiErrorDetail[],
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message, ...(details?.length ? { details } : {}) } },
    { status, headers: { [REQUEST_ID_HEADER]: id, ...extraHeaders } },
  );
}

/**
 * The two checks that must happen BEFORE the body is read. Returns the refusal,
 * or null to carry on.
 */
export function guardRequest(request: Request, id: string): Response | null {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return apiError(
      'unsupported_media_type',
      'This endpoint accepts application/json.',
      415,
      id,
    );
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return apiError('payload_too_large', 'That body is too large.', 413, id);
  }

  return null;
}
