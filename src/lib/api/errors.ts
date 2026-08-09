/**
 * The stable vocabulary this API answers with.
 *
 * The CODE is the machine contract and never changes meaning; the message is for
 * a human reading a log. Both in English, deliberately: the screens are
 * trilingual because people read them, and an automation reads the code.
 */
export type ApiErrorCode =
  | 'malformed_json'
  | 'unauthorized'
  | 'forbidden_scope'
  | 'listener_anonymized'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'invalid_payload'
  | 'listener_name_required'
  | 'show_not_found'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorDetail {
  path: string;
  message: string;
}

/**
 * Postgres SQLSTATE to an HTTP answer.
 *
 * THE DEFAULT BRANCH IS THE POINT. describeMusicReadError already writes the
 * rule down for the screens: an internal error means the fault is ours, not
 * theirs, and its message may carry a raw database error -- not something to
 * show. It applies more sharply here, because this body lands in somebody else's
 * log file and stays there.
 *
 * The named branches match on SQLSTATE **and** on text the doors in 0152 raise
 * deliberately. Text alone would be fragile; SQLSTATE alone cannot tell 22023's
 * several cases apart, and "a new listener must arrive with a name" is exactly
 * the one an integrator has to be able to act on without reading our source.
 */
export function mapPostgresError(
  code: string | undefined,
  message: string,
): { status: number; code: ApiErrorCode; message: string } {
  if (code === '42501') {
    // The raw text names the scope ("permission denied: music.manage required"),
    // which is what an integrator needs and gives away nothing -- they already
    // hold a valid key for this Station.
    return { status: 403, code: 'forbidden_scope', message };
  }

  if (code === '23514' && message.includes('anonymised')) {
    return {
      status: 409,
      code: 'listener_anonymized',
      message: 'That listener has exercised erasure and cannot be recorded against.',
    };
  }

  if (code === 'P0002' && message.includes('programme not found')) {
    return {
      status: 422,
      code: 'show_not_found',
      // No programme name echoed back: it came from the caller, and reflecting
      // caller-supplied text into a response body is a habit worth not having.
      message: 'No programme with that name exists in this station.',
    };
  }

  if (code === '22023') {
    if (message.includes('must arrive with a name')) {
      return {
        status: 422,
        code: 'listener_name_required',
        message: 'A listener not yet registered must arrive with a name.',
      };
    }
    // Every other 22023 in 0152 is a statement about the payload written for a
    // caller to read -- "a title is required", "a song must name an artist" --
    // so it passes through.
    return { status: 422, code: 'invalid_payload', message };
  }

  return {
    status: 500,
    code: 'internal',
    message: 'The request could not be completed.',
  };
}
