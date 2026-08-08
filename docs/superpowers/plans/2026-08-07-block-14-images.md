# Block 14 — Images for promotions and prizes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a file picker for a promotion's thumb, a promotion's WhatsApp banner and a prize's photograph, upload each to a public bucket at a key derived from the record, and show a thumbnail on the promotions and inventory lists.

**Architecture:** One public Storage bucket, `artwork`, with three prefixes keyed
`<slot>/<company_id>/<record_id>` and **no file extension** — so re-uploading
overwrites the same object and nothing accumulates. Each image gets its own
writer RPC (`set_promotion_thumb`, `set_promotion_art`, `set_prize_photo`) in the
shape of `attach_delivery_receipt` (0086), because `update_promotion` replaces
every field it takes and leaving the art on it would make every Save delete the
banner. Uploads go through a Server Action on the caller's own token, so the
bucket's write policy is the boundary rather than a decoration.

**Tech Stack:** Next.js App Router (Server Actions), Supabase Storage + RLS on
`storage.objects`, PostgreSQL 15, zod, vitest, pgTAP, Playwright, next-intl.

**Spec:** `docs/superpowers/specs/2026-08-07-promotion-and-prize-images-design.md`

## Global Constraints

- **Branch:** `block-14-images`, already created from `origin/main`. One PR at the end.
- **Accepted types:** `image/jpeg` and `image/png` only. Meta accepts nothing else for an image message.
- **Byte ceiling:** 5 MB (`5242880`), Meta's, enforced by the bucket.
- **Pixel ceiling:** ours, not Meta's — 512 px longest side for a thumb, 1920 px for a banner. Any comment claiming Meta requires it is false.
- **Bucket:** `artwork`, `public = true`.
- **Keys:** `promotion-thumbs/<company_id>/<promotion_id>`, `promotion-banners/<company_id>/<promotion_id>`, `prize-photos/<company_id>/<prize_id>`. No extension, ever.
- **Every upload sets `contentType` explicitly** from the validated MIME type. An extensionless object uploaded without one is served as `application/octet-stream` and Meta refuses it.
- **Stored URLs carry a version stamp** (`?v=<epoch ms>`), because the key is stable and the CDN would otherwise serve the replaced image.
- **All three locales.** Every new sentence goes into `messages/en.json`, `messages/pt.json` and `messages/es.json`. A key present in one and missing in another fails `tests/unit/i18n`.
- **No `revalidatePath`** in `promotions/actions.ts` or `inventory/actions.ts`. Both files carry the Block 3c rule at the top; the grids patch their own rows.
- **Comments explain decisions, not mechanics** — the house style. A comment that restates the line below it is noise; a comment naming why a shape was rejected is the point.

---

### Task 1: The rules an image must satisfy

**Files:**
- Create: `src/lib/security/artwork.ts`
- Create: `src/lib/security/image-dimensions.ts`
- Test: `tests/unit/artwork-rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ArtworkKind = 'thumb' | 'banner'`
  - `ARTWORK_MAX_BYTES: number` (5242880)
  - `ARTWORK_ACCEPT: string` (`'image/jpeg,image/png'`)
  - `ARTWORK_MAX_PIXELS: Record<ArtworkKind, number>` (`{ thumb: 512, banner: 1920 }`)
  - `artworkExtensionless(mime: string): boolean`
  - `describeArtworkRejection(kind, file: { type: string; size: number }, dimensions: { width: number; height: number } | null): string | null`
  - `readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/artwork-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ARTWORK_ACCEPT,
  ARTWORK_MAX_BYTES,
  describeArtworkRejection,
} from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';

/** A PNG is a signature, then an IHDR whose first eight payload bytes are the size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * A JPEG whose SOF0 sits behind two other segments, which is the case a reader
 * that peeks at a fixed offset gets wrong. APP0 and DQT come first, exactly as
 * a camera writes them.
 */
function jpeg(width: number, height: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00); // APP0, length 4
  parts.push(0xff, 0xdb, 0x00, 0x05, 0x00, 0x00, 0x00); // DQT, length 5
  parts.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  );
  return new Uint8Array(parts);
}

describe('readImageDimensions', () => {
  it('reads a PNG', () => {
    expect(readImageDimensions(png(1125, 600))).toEqual({ width: 1125, height: 600 });
  });

  it('reads a JPEG whose SOF0 is behind other segments', () => {
    expect(readImageDimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it('answers null for anything else, rather than guessing', () => {
    expect(readImageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it('answers null for a truncated PNG rather than reading past the end', () => {
    expect(readImageDimensions(png(10, 10).slice(0, 18))).toBeNull();
  });
});

describe('describeArtworkRejection', () => {
  const jpegFile = { type: 'image/jpeg', size: 1000 };

  it('accepts a banner inside every limit', () => {
    expect(describeArtworkRejection('banner', jpegFile, { width: 1125, height: 600 })).toBeNull();
  });

  it('refuses a file over five megabytes', () => {
    const message = describeArtworkRejection(
      'banner',
      { type: 'image/jpeg', size: ARTWORK_MAX_BYTES + 1 },
      { width: 100, height: 100 },
    );
    expect(message).toMatch(/5 MB/);
  });

  it('names HEIC, because that is what an iPhone hands over', () => {
    const message = describeArtworkRejection(
      'banner',
      { type: 'image/heic', size: 1000 },
      null,
    );
    expect(message).toMatch(/HEIC/);
  });

  it('refuses a banner wider than the ceiling and says what it found', () => {
    const message = describeArtworkRejection('banner', jpegFile, { width: 4032, height: 3024 });
    expect(message).toMatch(/4032/);
    expect(message).toMatch(/1920/);
  });

  it('holds a thumb to the tighter ceiling', () => {
    expect(describeArtworkRejection('thumb', jpegFile, { width: 800, height: 200 })).toMatch(/512/);
    expect(describeArtworkRejection('thumb', jpegFile, { width: 512, height: 200 })).toBeNull();
  });

  it('refuses a file whose dimensions could not be read at all', () => {
    // A JPEG by its content type whose bytes no reader recognised is not a
    // JPEG, and storing it would mean Meta fetching something it cannot render.
    expect(describeArtworkRejection('banner', jpegFile, null)).toMatch(/could not be read/i);
  });

  it('offers the picker exactly the two types the bucket accepts', () => {
    expect(ARTWORK_ACCEPT).toBe('image/jpeg,image/png');
  });
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `npm test -- tests/unit/artwork-rules.test.ts`
Expected: FAIL — `Cannot find module '@/lib/security/artwork'`.

- [ ] **Step 3: Write `src/lib/security/image-dimensions.ts`**

```ts
/**
 * Width and height from the file's own bytes.
 *
 * NOT a general image library, and small only because the bucket accepts
 * exactly two formats (0143): everything else is answered `null` and refused
 * upstream. Reading this on the server is what makes the pixel ceiling a
 * decision rather than a suggestion -- the browser check that runs first exists
 * so the operator reads a sentence before waiting for an upload, not as a
 * boundary.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Markers between C0 and CF that are NOT a frame header. C4 is the Huffman
 * table, C8 is reserved and CC is arithmetic coding -- all three are ordinary
 * length-prefixed segments, and treating one as a frame would read a table's
 * contents as a picture's size.
 */
const NOT_A_FRAME = new Set([0xc4, 0xc8, 0xcc]);

function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walked segment by segment rather than searched for the FFC0 pair. A search
  // finds that pair inside the thumbnail an EXIF block carries, and answers
  // with the thumbnail's size.
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];

    // Padding, and the standalone markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or the scan itself

    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPng(bytes) ?? readJpeg(bytes);
}
```

- [ ] **Step 4: Write `src/lib/security/artwork.ts`**

```ts
/**
 * Block 14. What a promotion's or a prize's picture may be.
 *
 * MUST agree with `supabase/migrations/0143_artwork_bucket.sql`, which is the
 * real barrier, and with `supabase/tests/29_artwork_bucket.test.sql`, which
 * asserts the bucket half so the two cannot drift apart unnoticed. This file
 * exists so the operator reads a sentence instead of a raw Storage error.
 *
 * THE TWO KINDS ARE NOT THE SAME PICTURE. A `thumb` identifies a record inside
 * this system and is never sent anywhere; a `banner` is fetched by Meta and
 * shown to listeners. They share a bucket and nothing else.
 */
import type { ImageDimensions } from './image-dimensions';

export type ArtworkKind = 'thumb' | 'banner';

/** Meta's, for an image message. The bucket enforces it (0143). */
export const ARTWORK_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Meta's list, and the whole of it: an image message is JPEG or PNG. WebP and
 * HEIC are deliberately absent -- HEIC is what an iPhone hands over, and
 * accepting it here would move the failure to the moment of sending, where
 * nothing points back at this field.
 */
const ARTWORK_TYPES = ['image/jpeg', 'image/png'] as const;

/** For the file picker. Convenience, not a defence: it filters a dialog. */
export const ARTWORK_ACCEPT = ARTWORK_TYPES.join(',');

/**
 * OURS, NOT META'S. The Cloud API publishes no pixel limit for an image
 * message; the 1.91:1 / 1125x600 figure that circulates belongs to template and
 * carousel media. This ceiling exists to stop a forty-megapixel phone
 * photograph being pushed through a message header, and to keep a list of fifty
 * rows from downloading fifty full-size pictures. Anything asserting Meta
 * requires it would be false.
 */
export const ARTWORK_MAX_PIXELS: Record<ArtworkKind, number> = {
  thumb: 512,
  banner: 1920,
};

export function isArtworkType(mime: string): boolean {
  return (ARTWORK_TYPES as readonly string[]).includes(mime);
}

/** The reason to refuse, in a sentence, or null when the picture is fine. */
export function describeArtworkRejection(
  kind: ArtworkKind,
  file: { type: string; size: number },
  dimensions: ImageDimensions | null,
): string | null {
  if (file.size > ARTWORK_MAX_BYTES) {
    const megabytes = Math.round(file.size / (1024 * 1024));
    return `That file is ${megabytes} MB. An image may be at most 5 MB.`;
  }
  if (!isArtworkType(file.type)) {
    return 'An image must be a JPEG or a PNG. WhatsApp accepts nothing else, so an iPhone photograph saved as HEIC has to be exported first.';
  }
  if (!dimensions) {
    // Refused rather than stored unmeasured: a file calling itself a JPEG whose
    // bytes no reader recognises is not one, and Meta would fetch something it
    // cannot render.
    return 'That image could not be read. Save it again as a JPEG or a PNG.';
  }
  const ceiling = ARTWORK_MAX_PIXELS[kind];
  const longest = Math.max(dimensions.width, dimensions.height);
  if (longest > ceiling) {
    const noun = kind === 'thumb' ? 'A thumbnail' : 'A banner';
    return `That image is ${dimensions.width}×${dimensions.height} pixels. ${noun} may be at most ${ceiling} pixels on its longest side.`;
  }
  return null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/unit/artwork-rules.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/security/artwork.ts src/lib/security/image-dimensions.ts tests/unit/artwork-rules.test.ts
git commit -m "feat(images): what a picture may be, and reading its size from its own bytes"
```

---

### Task 2: Where a picture lives

**Files:**
- Create: `src/lib/storage/artwork-keys.ts`
- Test: `tests/unit/artwork-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ARTWORK_BUCKET = 'artwork'`
  - `type ArtworkSlot = 'promotion-thumbs' | 'promotion-banners' | 'prize-photos'`
  - `artworkKey(slot: ArtworkSlot, companyId: string, recordId: string): string`
  - `artworkPublicUrl(origin: string, key: string, version: number): string`

**Why a separate file from Task 1's:** one answers "may this file be stored",
the other "under what name". They change for different reasons — the first when
Meta changes its list, the second when the bucket is renamed.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/artwork-keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const RECORD = '22222222-2222-2222-2222-222222222222';

describe('artworkKey', () => {
  it('names the slot, the Station and the record, and nothing else', () => {
    expect(artworkKey('promotion-banners', COMPANY, RECORD)).toBe(
      `promotion-banners/${COMPANY}/${RECORD}`,
    );
  });

  it('carries no file extension, which is what makes a re-upload a replacement', () => {
    expect(artworkKey('prize-photos', COMPANY, RECORD)).not.toMatch(/\.(jpg|jpeg|png)$/);
  });

  it('puts the Station second, where the bucket policy reads it', () => {
    expect(artworkKey('promotion-thumbs', COMPANY, RECORD).split('/')[1]).toBe(COMPANY);
  });
});

describe('artworkPublicUrl', () => {
  it('builds the public address with a version stamp', () => {
    expect(artworkPublicUrl('https://abc.supabase.co', 'prize-photos/a/b', 1754582400000)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/artwork/prize-photos/a/b?v=1754582400000',
    );
  });

  it('tolerates the trailing slash a configured URL may carry', () => {
    // .env.hosted.local really does end in one, and two slashes in a storage
    // path is a 400 rather than a redirect.
    expect(artworkPublicUrl('https://abc.supabase.co/', 'prize-photos/a/b', 1)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/artwork/prize-photos/a/b?v=1',
    );
  });

  it('keeps the local http origin intact', () => {
    // Development's Storage is http://127.0.0.1:54321. promotions_art_https
    // was relaxed for exactly this (0144); silently upgrading it here would
    // produce an address that resolves to nothing.
    expect(artworkPublicUrl('http://127.0.0.1:54321', 'promotion-banners/a/b', 7)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/artwork/promotion-banners/a/b?v=7',
    );
  });
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `npm test -- tests/unit/artwork-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/storage/artwork-keys.ts`**

```ts
/**
 * Block 14. The name an image is stored under, and the address it is read from.
 *
 * Pure, and NOT `server-only`: the upload control in the browser shows the
 * address it is about to replace, and a second copy of this arithmetic is how
 * the two would drift.
 */
export const ARTWORK_BUCKET = 'artwork';

export type ArtworkSlot = 'promotion-thumbs' | 'promotion-banners' | 'prize-photos';

/**
 * `<slot>/<company_id>/<record_id>`, and DELIBERATELY NO FILE EXTENSION.
 *
 * That absence is what makes "uploading again replaces the last one" structural
 * rather than hopeful: an operator who uploads a JPEG on Monday and a PNG on
 * Tuesday writes over the same object, because the key never mentions the
 * format. With an extension, replacing would mean deleting the old object and
 * writing a new one -- two steps, and the first can fail, which is exactly the
 * accumulation this block was asked to prevent.
 *
 * The consequence is load-bearing and lives in the services that call this:
 * every upload must set `contentType` explicitly, because Storage serves what
 * it was told and an extensionless object with no type is served as
 * `application/octet-stream`, which Meta refuses.
 *
 * The Station is the SECOND segment because `storage.foldername` hands the
 * policy in 0143 the folders as an array, and it decides from that alone.
 */
export function artworkKey(slot: ArtworkSlot, companyId: string, recordId: string): string {
  return `${slot}/${companyId}/${recordId}`;
}

/**
 * The public address, with a version stamp.
 *
 * The stamp is not decoration. A key derived from the record means a STABLE
 * URL, which means the browser and Supabase's CDN go on serving the picture
 * that was just replaced. Storing the address with `?v=<epoch ms>` changes the
 * column on every upload, so every screen -- and Meta's fetcher -- sees the new
 * image at once. A query string does not disturb that fetch.
 *
 * `origin` is passed in rather than read from the environment so this stays
 * pure and testable; the one server-side caller reads it from
 * getUserSupabaseConfig().
 */
export function artworkPublicUrl(origin: string, key: string, version: number): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${ARTWORK_BUCKET}/${key}?v=${version}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/artwork-keys.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/artwork-keys.ts tests/unit/artwork-keys.test.ts
git commit -m "feat(images): the key an image is stored under, and why it has no extension"
```

---

### Task 3: The bucket and who may write to it

**Files:**
- Create: `supabase/migrations/0143_artwork_bucket.sql`
- Create: `supabase/tests/29_artwork_bucket.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: bucket `artwork`; `public.may_write_artwork(p_name text) returns boolean`; policies `artwork_insert` and `artwork_update` on `storage.objects`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0143_artwork_bucket.sql`:

```sql
-- supabase/migrations/0143_artwork_bucket.sql

-- Block 14, D4. Where a promotion's and a prize's pictures live.
--
-- THE THIRD BUCKET, AND THE FIRST PUBLIC ONE. 0086 chose private and said why:
-- a delivery receipt is a photograph of a real person, and a public bucket is a
-- URL anybody can guess their way around. That reasoning is untouched and that
-- bucket does not move. This one is different in the one way that decides it:
-- META FETCHES THE BANNER ITSELF, at send time, which may be days after the
-- operator uploaded it. A signed URL expires; a private bucket would mean a
-- banner that works on the day it is set and silently stops working later.
--
-- What is stored here is promotional material -- a banner drawn to be shown to
-- listeners, a product photograph, a picture that identifies a promotion on a
-- list. None of it is personal data. The line 0086 drew stays where it was.
--
-- Keys are UUIDs in both segments (src/lib/storage/artwork-keys.ts), so the
-- bucket cannot be walked even though it can be read.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artwork', 'artwork', true, 5242880, array['image/jpeg', 'image/png'])
-- Not `do nothing`: on a database where this bucket somehow already exists,
-- `do nothing` would leave it without the limits below, and a bucket with no
-- opinion is exactly the hole 0134 was written to close.
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Who may write, decided from the path alone.
--
-- A FUNCTION RATHER THAN THE PREDICATE INLINE, for two reasons. An upsert needs
-- an INSERT policy AND an UPDATE policy -- a bucket that accepts the first
-- upload and refuses the replacement is worse than one that refuses both -- and
-- the UPDATE policy needs the rule twice, in USING and in WITH CHECK. Written
-- inline that is the same twenty lines three times, which is three places for
-- them to drift.
--
-- WHERE THIS DEPARTS FROM 0086, AND WHY. That migration casts
-- (storage.foldername(name))[1] straight to uuid inside the policy. On a
-- malformed path that raises 22P02 -- an ERROR, not a refusal. It has never
-- fired because our own code builds every path, but a policy that errors where
-- it means to deny is not a shape to carry forward without noticing. The cast
-- here is guarded.
--
-- SECURITY INVOKER, and stated rather than left to the default: has_permission
-- answers about auth.uid(), so this must run as the caller. A definer here
-- would answer about the migration role and let anybody write anywhere.
create function public.may_write_artwork(p_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_parts   text[] := storage.foldername(p_name);
  v_slot    text   := v_parts[1];
  v_company text   := v_parts[2];
begin
  if v_company is null
     or v_company !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return false;
  end if;

  -- A promotion's two pictures take the same permission because they are two
  -- fields of one record: somebody who may edit a promotion may set both.
  if v_slot in ('promotion-thumbs', 'promotion-banners') then
    return public.has_permission('promotions.edit', v_company::uuid);
  end if;

  -- The prize's takes the catalogue permission rather than the promotions one.
  -- Somebody who runs promotions is not thereby somebody who edits the stock
  -- catalogue, and 0027 already draws that line for every other prize field.
  if v_slot = 'prize-photos' then
    return public.has_permission('inventory.catalogue', v_company::uuid);
  end if;

  -- An unknown prefix is refused rather than allowed. Adding a slot means
  -- adding it here, which is the point.
  return false;
end;
$$;

comment on function public.may_write_artwork(text) is
  'Whether the caller may write the named object in the artwork bucket, decided from the path alone. SECURITY INVOKER deliberately: has_permission answers about auth.uid(). Guards the uuid cast rather than attempting it, unlike 0086, whose policy raises 22P02 on a malformed path instead of refusing it. An unknown prefix is refused.';

revoke execute on function public.may_write_artwork(text) from public;
grant execute on function public.may_write_artwork(text) to authenticated;

create policy artwork_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'artwork' and public.may_write_artwork(name));

create policy artwork_update
  on storage.objects for update to authenticated
  using (bucket_id = 'artwork' and public.may_write_artwork(name))
  with check (bucket_id = 'artwork' and public.may_write_artwork(name));

-- No SELECT policy, and its absence is the feature: the bucket is public, so
-- reads go through the public endpoint and never reach RLS at all.
--
-- No DELETE policy for authenticated, deliberately -- the shape 0123 chose.
-- Clearing an image queues its object in storage_erasure_queue (0087) and the
-- worker deletes it through service_role. A client that could delete here could
-- take a Station's banner off the air without leaving a row saying so.
--
-- No `comment on policy` on either: COMMENT requires ownership of the relation,
-- and the migration role may only add policies to storage.objects. 0086 and
-- 0123 carry the same absence for the same reason, so the reasoning lives here.
```

- [ ] **Step 2: Apply it and watch the suite still pass**

Run: `npm run db:reset`
Expected: every migration applies, `0143` included, with no error.

- [ ] **Step 3: Write the pgTAP test**

Create `supabase/tests/29_artwork_bucket.test.sql`:

```sql
begin;
select plan(9);

-- Block 14. The bucket is the barrier no client goes around, and the policies
-- are the ones that decide who writes. Asserted because configuration nobody
-- asserts returns to its default on the next `db reset` -- invisibly, because
-- an upload simply starts succeeding again.

select is(
  (select public from storage.buckets where id = 'artwork'),
  true,
  'the artwork bucket is public, because Meta fetches the banner itself');

select is(
  (select file_size_limit from storage.buckets where id = 'artwork'),
  5242880::bigint,
  'an image may be five megabytes at most, which is Meta''s number');

select is(
  (select allowed_mime_types from storage.buckets where id = 'artwork'),
  array['image/jpeg', 'image/png'],
  'JPEG and PNG, which is the whole of what an image message accepts');

select ok(
  not ((select allowed_mime_types from storage.buckets where id = 'artwork')
    && array['text/html', 'image/svg+xml', 'application/octet-stream']),
  'and never anything a browser would run');

-- The delivery receipt does not move. Asserted here rather than trusted,
-- because "make the images public" is the kind of change that takes a
-- neighbouring bucket with it.
select is(
  (select public from storage.buckets where id = 'delivery-receipts'),
  false,
  'the delivery receipt stays private, for 0086''s reason');

-- may_write_artwork, without a session: has_permission answers false for every
-- Station when there is no caller, so every branch below is refused. What is
-- being proved here is the SHAPE -- that a malformed path is refused rather
-- than raising 22P02, and that an unknown prefix is refused rather than
-- allowed.
select is(
  public.may_write_artwork('promotion-banners/not-a-uuid/abc'),
  false,
  'a path whose Station segment is not a uuid is refused, not an error');

select is(
  public.may_write_artwork('somewhere-else/11111111-1111-1111-1111-111111111111/abc'),
  false,
  'an unknown prefix is refused rather than allowed by omission');

select is(
  public.may_write_artwork('abc'),
  false,
  'a path with no folders at all is refused');

select ok(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('artwork_insert', 'artwork_update')) = 2,
  'both write policies exist, because an upsert needs INSERT and UPDATE');

select * from finish();
rollback;
```

- [ ] **Step 4: Run the pgTAP suite**

Run: `npm run db:test`
Expected: `29_artwork_bucket` passes 9 assertions; every other file still passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0143_artwork_bucket.sql supabase/tests/29_artwork_bucket.test.sql
git commit -m "feat(images): the artwork bucket, public for the one reason that decides it"
```

---

### Task 4: The promotion's two pictures, in the database

**Files:**
- Create: `supabase/migrations/0144_promotion_images.sql`
- Create: `supabase/tests/30_promotion_images.test.sql`
- Read for reference: `supabase/migrations/0055_promotion_freeze.sql` (the live bodies of `create_promotion` and `update_promotion`)

**Interfaces:**
- Consumes: `public.may_write_artwork` (Task 3) is not called here; the erasure guard is.
- Produces:
  - column `public.promotions.thumb_url text`
  - `public.enqueue_artwork_erasure(p_url text, p_key text) returns void`
  - `public.set_promotion_thumb(p_promotion_id uuid, p_url text) returns void`
  - `public.set_promotion_art(p_promotion_id uuid, p_url text) returns void`
  - `create_promotion` and `update_promotion` **without** `p_use_art` and `p_art_url` — 15 arguments each.

- [ ] **Step 1: Write the column, the constraints and the erasure helper**

Create `supabase/migrations/0144_promotion_images.sql`, beginning:

```sql
-- supabase/migrations/0144_promotion_images.sql

-- Block 14, D2 and D5. A promotion gets a second picture, and both of them get
-- an owner.
--
-- THE CHANGE THAT MAKES THE REST SAFE is at the bottom of this file:
-- create_promotion and update_promotion stop taking p_use_art and p_art_url.
-- update_promotion replaces every field it is given on every call -- its own
-- comment in 0042 says so, and 0055's ceiling was added precisely because a
-- field missing from that list is a field written null. The banner's address
-- has just left the form, so leaving the parameter on the RPC would have meant
-- every Save silently deleting the banner. One field, one writer.
--
-- use_art STAYS IN THE TABLE and leaves the screen. promotions_art_shape (0040)
-- already forces `use_art = (art_url is not null)`, so it has never been a
-- second state; the tick that used to set it is now "does this promotion have a
-- banner". Keeping the column means the conversation engine, interactive.ts and
-- the context RPC are untouched by this block.

alter table public.promotions add column thumb_url text;

comment on column public.promotions.thumb_url is
  'A small picture identifying this promotion inside the system -- the list, the record. NEVER sent anywhere: the banner Meta fetches is art_url, and the two are different pictures with different limits. Server-generated (Block 14); no form posts it.';

-- A shape check rather than an https rule, because unlike art_url this value
-- never leaves the building and no client posts it.
alter table public.promotions
  add constraint promotions_thumb_shape
  check (thumb_url is null or thumb_url ~ '^https?://');

-- ---------------------------------------------------------------------------
-- promotions_art_https is relaxed to accept loopback.
--
-- NOT A WEAKENING, because of a change that did not exist when it was written:
-- THE ADDRESS IS NO LONGER TYPED. 0040's own comment says the constraint is
-- there so "the operator learns at the moment of typing" that Meta will not
-- fetch over http. There is no longer an operator typing -- the value is built
-- on the server from the upload's own result, so no form can post an address at
-- all, which is a stronger guarantee than this check ever gave.
--
-- What it buys: in development the Storage origin is http://127.0.0.1:54321,
-- and without this the feature cannot run on a developer's machine or in the
-- e2e suite. A loopback address is unreachable from Meta's fetchers, so it
-- cannot quietly degrade a production send either.
alter table public.promotions drop constraint promotions_art_https;

alter table public.promotions
  add constraint promotions_art_https
  check (
    art_url is null
    or art_url like 'https://%'
    or art_url like 'http://127.0.0.1:%'
    or art_url like 'http://localhost:%'
  );

-- ---------------------------------------------------------------------------
-- Deleting the bytes, which SQL cannot do.
--
-- The queue 0087 built, drained by the worker tick. Clearing a picture enqueues
-- its object in the SAME transaction that clears the column, so the intent
-- cannot survive without the instruction.
--
-- THE GUARD IS THE POINT. Promotions registered before this block carry
-- externally hosted addresses; a key derived from one of those names nothing in
-- our bucket, and 0087 deliberately has NO give-up threshold -- such a row would
-- retry for ever, and a queue full of permanent failures is a queue nobody
-- reads. So only our own objects are enqueued, proved by the address rather
-- than assumed from it.
--
-- Replacing a picture enqueues nothing, and that is correct: the key is derived
-- from the record, so the new upload overwrites the same object. There is
-- nothing left behind to delete.
create function public.enqueue_artwork_erasure(p_url text, p_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_url is null or p_key is null then
    return;
  end if;
  if position('/storage/v1/object/public/artwork/' || p_key in p_url) = 0 then
    return;
  end if;
  insert into public.storage_erasure_queue (bucket, path) values ('artwork', p_key);
end;
$$;

comment on function public.enqueue_artwork_erasure(text, text) is
  'Queues an artwork object for the worker to delete, in the transaction that clears the column naming it. Enqueues ONLY when the stored address is one of ours: a promotion registered before Block 14 carries an external address, and 0087 has no give-up threshold, so a key naming nothing would retry for ever. Replacing a picture enqueues nothing -- the key is derived from the record, so the new object overwrites the old.';

revoke execute on function public.enqueue_artwork_erasure(text, text) from public, authenticated, anon;
```

- [ ] **Step 2: Append the two setters to the same migration**

```sql
-- ---------------------------------------------------------------------------
-- One writer per picture, in the shape of attach_delivery_receipt (0086).
--
-- NEITHER IS SUBJECT TO THE FREEZE, and that is not a gap. 0055's own header
-- lists what stays open for the whole life of a promotion: "the name, the end
-- date, the call to action, THE ART, the two button labels and adding a
-- question". The thumb joins that list by the same argument -- nobody entered a
-- promotion because of the picture beside it on a list screen.

create function public.set_promotion_thumb(p_promotion_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_current text;
  v_url     text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, thumb_url into v_company, v_current
  from public.promotions
  where id = p_promotion_id
  for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'set_promotion_thumb denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'promotion-thumbs/' || v_company || '/' || p_promotion_id);
  end if;

  update public.promotions
     set thumb_url  = v_url,
         updated_at = now()
   where id = p_promotion_id;
end;
$$;

comment on function public.set_promotion_thumb(uuid, text) is
  'Sets or clears the picture that identifies a promotion inside the system. Gated on promotions.edit. Its own writer rather than a field of update_promotion, because that function replaces every field it takes and a picture uploaded before a Save would be deleted by it. Null clears and queues the object. Not subject to the freeze: 0055 keeps the art open for the whole life of a promotion, and a list thumbnail is not something anybody entered because of.';

revoke execute on function public.set_promotion_thumb(uuid, text) from public;
grant execute on function public.set_promotion_thumb(uuid, text) to authenticated;

create function public.set_promotion_art(p_promotion_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company  uuid;
  v_whatsapp boolean;
  v_current  text;
  v_url      text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, whatsapp_enabled, art_url
    into v_company, v_whatsapp, v_current
  from public.promotions
  where id = p_promotion_id
  for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'set_promotion_art denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  -- promotions_whatsapp_shape does not admit a banner on a promotion that does
  -- not use WhatsApp. Refused here with a sentence rather than left to the
  -- constraint, which would reach the operator as "could not save" with no
  -- field to point at.
  if v_url is not null and not v_whatsapp then
    raise exception 'turn WhatsApp on for this promotion before giving it a banner'
      using errcode = '22023';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'promotion-banners/' || v_company || '/' || p_promotion_id);
  end if;

  -- use_art is set from the presence of the address and never independently:
  -- promotions_art_shape has always required exactly that, so there is no state
  -- here for a caller to get wrong.
  update public.promotions
     set art_url    = v_url,
         use_art    = (v_url is not null),
         updated_at = now()
   where id = p_promotion_id;
end;
$$;

comment on function public.set_promotion_art(uuid, text) is
  'Sets or clears the banner Meta fetches. Gated on promotions.edit. Refuses a banner on a promotion with WhatsApp off, because promotions_whatsapp_shape does not admit one and a constraint failure reaches the operator with no field to point at. Sets use_art from the presence of the address rather than taking it -- promotions_art_shape has always required the two to agree. Null clears and queues the object. Not subject to the freeze; 0055 keeps the art open deliberately.';

revoke execute on function public.set_promotion_art(uuid, text) from public;
grant execute on function public.set_promotion_art(uuid, text) to authenticated;
```

- [ ] **Step 3: Take the art off `create_promotion` and `update_promotion`**

Append to the same migration. Copy each body **verbatim from `0055_promotion_freeze.sql`**
(`create_promotion` from its `create function` to its closing `$$;`, likewise
`update_promotion`) and apply exactly these deltas — nothing else in either body
changes:

**`create_promotion`:**
1. Drop with the 17-type list from 0055, then re-create with `p_use_art` and `p_art_url` **removed** from the parameter list (15 parameters remain).
2. Delete the `v_art` declaration.
3. In the INSERT column list, delete `use_art, art_url`.
4. In the VALUES list, delete `coalesce(p_use_art, false), v_art,`.
5. Restate `revoke` / `grant` / `comment` with the new 15-type list.

**`update_promotion`:**
1. Drop with the 17-type list from 0055, then re-create with the same two parameters removed.
2. Delete the `v_art` declaration.
3. Replace the two art assignments in the `update ... set` list with:

```sql
      -- NOT taken from a parameter any more (Block 14). set_promotion_art is
      -- this column's only writer; what is left here is the one thing that
      -- function cannot do -- honour promotions_whatsapp_shape when WhatsApp is
      -- switched off in the same statement that would otherwise leave a banner
      -- behind and fail the row's own check.
      use_art = case when coalesce(p_whatsapp_enabled, false) then use_art else false end,
      art_url = case when coalesce(p_whatsapp_enabled, false) then art_url else null end,
```

4. **Before** that `update`, and only when WhatsApp is being switched off, queue
   the object — the bytes outlive the column otherwise:

```sql
  if not coalesce(p_whatsapp_enabled, false) then
    perform public.enqueue_artwork_erasure(
      v_current_art, 'promotion-banners/' || v_company || '/' || p_promotion_id);
  end if;
```

   `v_current_art` is a new `declare` line, read in the same `select ... for update`
   the function already does to find the promotion's Station.

5. Restate `revoke` / `grant` / `comment` with the new 15-type list, and note in
   the comment that the art left this function in Block 14 and why.

Then drop the two dependent Drops' ACL default, exactly as 0055 does:

```sql
-- Dropping resets the ACL to Postgres's default of EXECUTE to PUBLIC, so the
-- revoke and grant are not restated out of tidiness: without them anon could
-- reach these functions, which is the hole 0050 closed for all six of Block
-- 4a's promotion RPCs.
```

- [ ] **Step 4: Apply and confirm nothing else broke**

Run: `npm run db:reset && npm run db:test`
Expected: every migration applies; every existing pgTAP file still passes.
If `20_promotions*.test.sql` calls either RPC with `p_use_art`, update those
calls — the argument genuinely no longer exists.

- [ ] **Step 5: Write the pgTAP test**

Create `supabase/tests/30_promotion_images.test.sql`, asserting:

1. `set_promotion_thumb` and `set_promotion_art` are `security definer` and
   granted to `authenticated`, not to `anon` — the 0050 hole, restated:

```sql
select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_name in ('set_promotion_thumb', 'set_promotion_art')
      and grantee = 'anon'),
  0::bigint,
  'neither setter is reachable by anon');
```

2. `create_promotion` and `update_promotion` no longer accept the art:

```sql
select is(
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_promotion', 'update_promotion')
     and 'p_art_url' = any(p.proargnames)),
  0::bigint,
  'the art left both promotion RPCs, so a Save cannot delete a banner');
```

3. The relaxed https constraint accepts loopback and still refuses a bare
   `http://` host — insert a promotion directly and assert with `throws_ok` /
   `lives_ok`, in the shape `supabase/tests/20_*.test.sql` already uses for
   promotions.

4. `enqueue_artwork_erasure` enqueues our own address and refuses an external
   one:

```sql
select lives_ok(
  $$select public.enqueue_artwork_erasure(
      'https://x.supabase.co/storage/v1/object/public/artwork/promotion-banners/'
        || '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222?v=1',
      'promotion-banners/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222')$$,
  'our own address is queued');

select is(
  (select count(*) from public.storage_erasure_queue where bucket = 'artwork'),
  1::bigint,
  'and exactly one row was written');

select lives_ok(
  $$select public.enqueue_artwork_erasure(
      'https://someone-elses-server.example/banner.jpg',
      'promotion-banners/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222')$$,
  'an external address is accepted quietly');

select is(
  (select count(*) from public.storage_erasure_queue where bucket = 'artwork'),
  1::bigint,
  'and queued nothing, because 0087 never gives up on a row that names nothing');
```

5. `set_promotion_art` refuses a banner while WhatsApp is off — `throws_ok`
   with sqlstate `22023`, against a promotion seeded in the same transaction.

- [ ] **Step 6: Run the pgTAP suite**

Run: `npm run db:test`
Expected: `30_promotion_images` passes; nothing else regresses.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0144_promotion_images.sql supabase/tests/30_promotion_images.test.sql
git commit -m "feat(images): a promotion's two pictures, each with one writer"
```

---

### Task 5: The prize's photograph, in the database

**Files:**
- Create: `supabase/migrations/0145_prize_photo.sql`
- Create: `supabase/tests/31_prize_photo.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: `public.enqueue_artwork_erasure` (Task 4).
- Produces: column `public.prizes.photo_url text`; `public.set_prize_photo(p_prize_id uuid, p_url text) returns void`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0145_prize_photo.sql`:

```sql
-- supabase/migrations/0145_prize_photo.sql

-- Block 14, D3. A prize gets a photograph.
--
-- Of the same kind as the promotion's thumb and for the same purpose: it
-- identifies the prize on the inventory list and on its own record. Nothing in
-- this block sends it anywhere. The column is here if that is ever wanted, and
-- until somebody asks it stays internal.
--
-- ITS OWN WRITER, for the reason 0144 gives at length: update_prize (0027) sets
-- every column it takes on every call, so a photograph uploaded before a Save
-- would be deleted by that Save.

alter table public.prizes add column photo_url text;

comment on column public.prizes.photo_url is
  'A picture identifying this prize on the inventory list and its record. Server-generated (Block 14); no form posts it. Written only by set_prize_photo -- update_prize replaces every field it takes, and a photograph on that list would be cleared by every ordinary save.';

alter table public.prizes
  add constraint prizes_photo_shape
  check (photo_url is null or photo_url ~ '^https?://');

create function public.set_prize_photo(p_prize_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_current text;
  v_url     text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, photo_url into v_company, v_current
  from public.prizes
  where id = p_prize_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'prize not found: %', p_prize_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'set_prize_photo denied: actor=% prize=%', auth.uid(), p_prize_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'prize-photos/' || v_company || '/' || p_prize_id);
  end if;

  update public.prizes
     set photo_url  = v_url,
         updated_at = now()
   where id = p_prize_id;
end;
$$;

comment on function public.set_prize_photo(uuid, text) is
  'Sets or clears the picture identifying a prize. Gated on inventory.catalogue, the same permission every other catalogue field takes (0027). Its own writer rather than a field of update_prize, which replaces every column it is given. Archived prizes are unreachable here, as they are everywhere else (0029). Null clears and queues the object.';

revoke execute on function public.set_prize_photo(uuid, text) from public;
grant execute on function public.set_prize_photo(uuid, text) to authenticated;
```

- [ ] **Step 2: Write the pgTAP test**

Create `supabase/tests/31_prize_photo.test.sql` with `plan(4)`:

1. `photo_url` exists on `prizes` and is nullable — `has_column`, `col_is_null`.
2. `set_prize_photo` is not granted to `anon`.
3. `update_prize` does not accept a `p_photo_url`, so an ordinary save cannot
   clear the photograph:

```sql
select is(
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_prize'
     and 'p_photo_url' = any(p.proargnames)),
  0::bigint,
  'update_prize does not touch the photograph, so a save cannot clear it');
```

4. `prizes_photo_shape` refuses a value that is not an address — `throws_ok`
   inserting `'not-a-url'`.

- [ ] **Step 3: Apply and run both suites**

Run: `npm run db:reset && npm run db:test`
Expected: `31_prize_photo` passes 4 assertions; nothing else regresses.

- [ ] **Step 4: Regenerate the database types**

Run: `npm run db:types`
Then: `npm run typecheck`
Expected: `database.types.ts` now carries `thumb_url`, `photo_url` and the three
setters, and no longer carries `p_art_url` on the two promotion RPCs.
`typecheck` will FAIL at `src/services/promotions.ts` — `promotionRpcArgs` still
sends `p_use_art` and `p_art_url`. That failure is Task 6's starting point;
leave it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0145_prize_photo.sql supabase/tests/31_prize_photo.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(images): a prize gets a photograph, written by nothing else"
```

---

### Task 6: The promotion service learns about pictures

**Files:**
- Modify: `src/services/promotions.ts`
- Modify: `src/schemas/promotions.ts`
- Test: `tests/unit/promotions-schema.test.ts` (extend; check the existing filename first with `ls tests/unit`)

**Interfaces:**
- Consumes: `artworkKey`, `artworkPublicUrl`, `ARTWORK_BUCKET` (Task 2); `describeArtworkRejection`, `readImageDimensions` (Task 1).
- Produces:
  - `PromotionSummary.thumbUrl: string | null`
  - `PromotionDetail.thumbUrl: string | null`
  - `uploadPromotionImage(accessToken: string, input: { kind: 'thumb' | 'banner'; companyId: string; promotionId: string; file: File }): Promise<string>` — returns the stored URL
  - `clearPromotionImage(accessToken: string, input: { kind: 'thumb' | 'banner'; promotionId: string }): Promise<void>`

- [ ] **Step 1: Take the art out of the form schema**

In `src/schemas/promotions.ts`, delete `useArt` and `artUrl` from
`promotionFormSchema`, and from `.superRefine`: the `artUrl` entry in the
`stray` list, the `if (v.useArt)` block, both `promotions_art_shape` issues and
the `promotions_art_https` issue. Replace them with one comment at the point
they were removed:

```ts
    // The banner and the thumb are NOT in this schema, and their absence is the
    // decision Block 14 turned on: set_promotion_art and set_promotion_thumb
    // are their only writers, and update_promotion no longer takes them. A
    // field validated here would be a field this form believes it is saving.
```

- [ ] **Step 2: Run the schema tests to see what the removal broke**

Run: `npm test -- tests/unit`
Expected: FAIL in whichever test asserts the art refusals. Delete those cases —
the rule they assert now lives in `set_promotion_art`, and `30_promotion_images`
proves it there.

- [ ] **Step 3: Update `promotionRpcArgs` and the reads**

In `src/services/promotions.ts`:
- delete `p_use_art` and `p_art_url` from `promotionRpcArgs`, leaving a comment saying where they went;
- add `thumbUrl` to `PromotionSummary` and to the `listPromotionsPage` select string (`...,site_integration_code,thumb_url,deleted_at`), mapped from `row.thumb_url`;
- add `thumbUrl` to `PromotionDetail` and its mapping beside the existing `artUrl` mapping.

- [ ] **Step 4: Write the upload and clear functions**

Append to `src/services/promotions.ts`:

```ts
/**
 * Uploads the object and then files it, IN THAT ORDER.
 *
 * The order is the same one attachDeliveryReceipt takes, for a different
 * reason: the row must never point at bytes that failed to arrive. If the RPC
 * below fails, what is left behind is an object at a key derived from this
 * promotion -- unreferenced, harmless, and overwritten by the next upload,
 * because the key never changes.
 *
 * The upload runs on the CALLER's token rather than the service key, so the
 * bucket policy written in 0143 is the boundary rather than a decoration.
 */
export async function uploadPromotionImage(
  accessToken: string,
  input: { kind: ArtworkKind; companyId: string; promotionId: string; file: File },
): Promise<string> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const rejection = describeArtworkRejection(
    input.kind,
    { type: input.file.type, size: input.file.size },
    readImageDimensions(bytes),
  );
  // The bucket refuses the type and the size as well (0143). This is here so
  // the failure is a sentence rather than a Storage error, so the pixel ceiling
  // -- which no bucket can express -- is enforced somewhere a client cannot
  // reach, and so nothing is uploaded first.
  if (rejection) throw new ValidationError(rejection);

  const slot: ArtworkSlot =
    input.kind === 'thumb' ? 'promotion-thumbs' : 'promotion-banners';
  const key = artworkKey(slot, input.companyId, input.promotionId);

  const uploaded = await asCaller(accessToken)
    .storage.from(ARTWORK_BUCKET)
    .upload(key, input.file, {
      // From the validated list, and NOT optional: the key carries no
      // extension, so an upload with no content type is served back as
      // application/octet-stream and Meta refuses the image.
      contentType: input.file.type,
      // The whole point of the derived key. Without this the second upload for
      // a promotion fails instead of replacing the first.
      upsert: true,
    });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the image: ${uploaded.error.message}`);
  }

  const url = artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now());
  const { error } = await asCaller(accessToken).rpc(
    input.kind === 'thumb' ? 'set_promotion_thumb' : 'set_promotion_art',
    { p_promotion_id: input.promotionId, p_url: url },
  );
  if (error) throw mapPromotionError(error.code, error.message);
  return url;
}

export async function clearPromotionImage(
  accessToken: string,
  input: { kind: ArtworkKind; promotionId: string },
): Promise<void> {
  // The RPC clears the column and queues the object in one transaction (0144).
  // Nothing here deletes anything: a client that could reach the bucket's
  // delete would be a client that could take a Station's banner off the air
  // without leaving a row saying so.
  const { error } = await asCaller(accessToken).rpc(
    input.kind === 'thumb' ? 'set_promotion_thumb' : 'set_promotion_art',
    { p_promotion_id: input.promotionId, p_url: null },
  );
  if (error) throw mapPromotionError(error.code, error.message);
}
```

Check whether `ValidationError` exists in `src/lib/errors.ts`; if the module's
vocabulary differs, use the error class this service already throws for a
refused input rather than inventing one.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck && npm test -- tests/unit`
Expected: PASS. Both must be clean before moving on — Task 5 deliberately left
`typecheck` failing and this is where that debt is paid.

- [ ] **Step 6: Commit**

```bash
git add src/services/promotions.ts src/schemas/promotions.ts tests/unit
git commit -m "feat(images): the promotion service uploads, files and clears both pictures"
```

---

### Task 7: The inventory service learns about the photograph

**Files:**
- Modify: `src/services/inventory.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2's modules.
- Produces:
  - `PrizeSummary.photoUrl: string | null`
  - `uploadPrizePhoto(accessToken: string, input: { companyId: string; prizeId: string; file: File }): Promise<string>`
  - `clearPrizePhoto(accessToken: string, prizeId: string): Promise<void>`

- [ ] **Step 1: Carry the column through the reads**

- Add `photo_url` to `PRIZE_COLUMNS`.
- Add `photoUrl: string | null` to `PrizeSummary`, mapped from `row.photo_url`
  wherever that interface is built (the list, the record read — grep for
  `allowsReturnToStock:` to find every mapping).

- [ ] **Step 2: Write the two functions**

```ts
/**
 * Uploads the object and then files it, IN THAT ORDER, so the row can never
 * point at bytes that failed to arrive. A failed RPC leaves an object at a key
 * derived from this prize — unreferenced, harmless, overwritten by the next
 * upload, because the key never changes.
 *
 * On the CALLER's token rather than the service key: the bucket policy in 0143
 * checks inventory.catalogue against the Station in the path, and the service
 * key would bypass the policy this block wrote and leave it proved by nothing.
 *
 * Validated as a `thumb` — a prize photograph identifies a row on a list and is
 * held to the tighter of the two ceilings. Nothing in this block sends it to
 * WhatsApp, so Meta's rules are not the ones that decide here.
 */
export async function uploadPrizePhoto(
  accessToken: string,
  input: { companyId: string; prizeId: string; file: File },
): Promise<string> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const rejection = describeArtworkRejection(
    'thumb',
    { type: input.file.type, size: input.file.size },
    readImageDimensions(bytes),
  );
  // The bucket refuses the type and the size as well (0143). This is here so
  // the failure is a sentence rather than a Storage error, so the pixel ceiling
  // — which no bucket can express — is enforced somewhere a client cannot
  // reach, and so nothing is uploaded first.
  if (rejection) throw new ValidationError(rejection);

  const key = artworkKey('prize-photos', input.companyId, input.prizeId);

  const uploaded = await asCaller(accessToken)
    .storage.from(ARTWORK_BUCKET)
    .upload(key, input.file, {
      // NOT optional: the key carries no extension, so an upload with no
      // content type is served back as application/octet-stream.
      contentType: input.file.type,
      // The whole point of the derived key. Without this the second upload for
      // a prize fails instead of replacing the first.
      upsert: true,
    });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the photograph: ${uploaded.error.message}`);
  }

  const url = artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now());
  const { error } = await asCaller(accessToken).rpc('set_prize_photo', {
    p_prize_id: input.prizeId,
    p_url: url,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  return url;
}

export async function clearPrizePhoto(accessToken: string, prizeId: string): Promise<void> {
  // The RPC clears the column and queues the object in one transaction (0145).
  // Nothing here deletes anything: the bucket has no delete policy for
  // authenticated, deliberately.
  const { error } = await asCaller(accessToken).rpc('set_prize_photo', {
    p_prize_id: prizeId,
    p_url: null,
  });
  if (error) throw mapInventoryError(error.code, error.message);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/inventory.ts
git commit -m "feat(images): the inventory service carries the prize photograph"
```

---

### Task 8: The thumbnail both lists show

**Files:**
- Create: `src/components/media/image-thumb.tsx`
- Modify: `src/app/(app)/promotions/promotions-grid.tsx`
- Modify: `src/app/(app)/inventory/inventory-grid.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: `PromotionSummary.thumbUrl` (Task 6), `PrizeSummary.photoUrl` (Task 7).
- Produces: `<ImageThumb url={string | null} icon={'promotion' | 'prize'} size?={'sm' | 'md'} />`

- [ ] **Step 1: Write the component**

```tsx
import { Gift, Megaphone } from 'lucide-react';

const PIXELS = { sm: 32, md: 48 } as const;

const ICONS = { promotion: Megaphone, prize: Gift } as const;

/**
 * A record's picture, or an honest gap.
 *
 * The shape SongThumb established in Block 13a, and a SEPARATE component rather
 * than a widening of it: that one speaks Deezer's cover hash and builds a CDN
 * address from it, this one is handed a URL. Folding them together would mean a
 * component that takes two mutually exclusive props and a comment explaining
 * which callers may pass which.
 *
 * A PLAIN <img>, NOT next/image, for SongThumb's reasons: the optimiser would
 * proxy an origin we already serve, need remotePatterns kept in step with the
 * CSP, and buy nothing for a 32-pixel square.
 *
 * `alt=""` is correct and not an oversight. Every caller renders the record's
 * name immediately beside this, and a screen reader announcing "Picture of X"
 * before reading "X" is noise.
 */
export function ImageThumb({
  url,
  icon,
  size = 'sm',
  className,
}: {
  url: string | null;
  icon: keyof typeof ICONS;
  size?: keyof typeof PIXELS;
  className?: string;
}) {
  const px = PIXELS[size];

  if (!url) {
    const Icon = ICONS[icon];
    return (
      <span
        aria-hidden="true"
        data-testid="image-thumb-empty"
        className={`flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}
        style={{ width: px, height: px }}
      >
        <Icon className="size-4" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate; see the component comment.
    <img
      src={url}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      data-testid="image-thumb"
      className={`shrink-0 rounded bg-muted object-cover ${className ?? ''}`}
    />
  );
}
```

- [ ] **Step 2: Add the column to the promotions grid**

In `src/app/(app)/promotions/promotions-grid.tsx`:
- `const COLUMN_COUNT = 7;` (was 6 — the empty-state `colSpan` reads it)
- a `<TableHead>` before the name column, with a screen-reader-only label from
  the message catalogue rather than an empty cell
- `<TableCell><ImageThumb url={promotion.thumbUrl} icon="promotion" /></TableCell>`
  as the first cell of each row

- [ ] **Step 3: Add the column to the inventory grid**

Same three changes, with `icon="prize"` and `prize.photoUrl`. Find that file's
own column-count constant and raise it by one.

- [ ] **Step 4: Add the new keys to all three catalogues**

`promotions.imageColumn` → `"Picture"` / `"Imagem"` / `"Imagen"`, and the same
under `inventory`. Whatever other sentence the two grids need goes in all three
files in the same commit.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test -- tests/unit/i18n`
Expected: PASS. The i18n test is what catches a key added to one catalogue and
forgotten in the other two.

- [ ] **Step 6: Commit**

```bash
git add src/components/media/image-thumb.tsx "src/app/(app)/promotions/promotions-grid.tsx" "src/app/(app)/inventory/inventory-grid.tsx" messages
git commit -m "feat(images): the thumbnail reaches both lists"
```

---

### Task 9: The upload control

**Files:**
- Create: `src/components/media/reduce-image.ts`
- Create: `src/components/media/image-upload-field.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: `ARTWORK_ACCEPT`, `ARTWORK_MAX_BYTES`, `ARTWORK_MAX_PIXELS`, `describeArtworkRejection` (Task 1).
- Produces:
  `<ImageUploadField name={string} kind={'thumb' | 'banner'} currentUrl={string | null} disabled={boolean} onDirty={() => void} label={string} hint={string} />`

The control posts two form fields: `<name>` (the chosen `File`) and
`<name>Cleared` (`'on'` when Remove was pressed). It never uploads by itself —
the Server Action does, so the whole record saves or fails together.

- [ ] **Step 1: Write the reduction, on its own, so it can be reasoned about**

Create `src/components/media/reduce-image.ts`:

```ts
import { ARTWORK_MAX_PIXELS } from '@/lib/security/artwork';

/**
 * A picked photograph, made small enough to be a thumbnail.
 *
 * ONLY for the `thumb` kind. A banner is never rewritten: it is promotional
 * artwork somebody drew at a size they chose, and silently re-encoding it would
 * be this system deciding it knows better. A 32-pixel identifier has no such
 * claim on anybody.
 *
 * Exports JPEG regardless of what came in, and renames to `.jpg` to match —
 * `canvas.toBlob('image/png')` on a photograph produces a file several times
 * larger than the original for no visible gain, and a name that disagrees with
 * the bytes is the confusion this whole block avoids by keying without an
 * extension.
 */
export async function reduceToThumb(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const ceiling = ARTWORK_MAX_PIXELS.thumb;
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > ceiling ? ceiling / longest : 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the picture.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85),
  );
  if (!blob) throw new Error('This browser could not prepare the picture.');

  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}
```

- [ ] **Step 2: Write the control**

Create `src/components/media/image-upload-field.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  ARTWORK_ACCEPT,
  ARTWORK_MAX_BYTES,
  describeArtworkRejection,
  type ArtworkKind,
} from '@/lib/security/artwork';
import { reduceToThumb } from './reduce-image';

/**
 * Picking a picture, and saying what is wrong with it before the operator
 * waits for an upload.
 *
 * EVERYTHING HERE IS FOR THE OPERATOR'S BENEFIT, not a boundary. This half runs
 * on a machine we do not control; the service validates the same file again
 * (src/services/promotions.ts) and the bucket refuses the type and the size
 * whatever either of them decides (0143).
 *
 * IT DOES NOT UPLOAD. The file travels with the form and the Server Action
 * settles it against the saved record, so the picture and the fields it belongs
 * to succeed or fail together — and so registering a promotion, which has no id
 * to key an upload against until it exists, works through the same control as
 * editing one.
 */
export function ImageUploadField({
  name,
  kind,
  currentUrl,
  disabled,
  onDirty,
  label,
  hint,
}: {
  name: string;
  kind: ArtworkKind;
  currentUrl: string | null;
  disabled: boolean;
  onDirty: () => void;
  label: string;
  hint?: string;
}) {
  const t = useTranslations('common');
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [picked, setPicked] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The blob: URL is the browser's to reclaim, and a dialog that opens fifty
  // promotions in a session leaks fifty pictures without this.
  useEffect(() => () => {
    if (picked) URL.revokeObjectURL(picked);
  }, [picked]);

  async function choose(file: File) {
    setProblem(null);

    // Checked BEFORE decoding, for both kinds. Reduction is not a reason to
    // hand an arbitrary number of bytes to a canvas: a file large enough to be
    // worth reducing is large enough to lock the tab while it decodes.
    if (file.size > ARTWORK_MAX_BYTES) {
      setProblem(describeArtworkRejection(kind, file, null));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    let chosen = file;
    if (kind === 'thumb') {
      try {
        chosen = await reduceToThumb(file);
      } catch {
        setProblem(t('thatPictureCouldNotBeRead'));
        if (inputRef.current) inputRef.current.value = '';
        return;
      }
      // The reduced file replaces what the picker holds, so the form posts the
      // small one. A DataTransfer is the only way to write an input's files.
      const carrier = new DataTransfer();
      carrier.items.add(chosen);
      if (inputRef.current) inputRef.current.files = carrier.files;
    } else {
      // A banner is measured and refused, never rewritten.
      const bitmap = await createImageBitmap(file).catch(() => null);
      const rejection = describeArtworkRejection(
        kind,
        file,
        bitmap ? { width: bitmap.width, height: bitmap.height } : null,
      );
      bitmap?.close();
      if (rejection) {
        setProblem(rejection);
        if (inputRef.current) inputRef.current.value = '';
        return;
      }
    }

    if (picked) URL.revokeObjectURL(picked);
    const url = URL.createObjectURL(chosen);
    setPicked(url);
    setPreview(url);
    setCleared(false);
    onDirty();
  }

  function remove() {
    if (picked) URL.revokeObjectURL(picked);
    setPicked(null);
    setPreview(null);
    setCleared(true);
    setProblem(null);
    if (inputRef.current) inputRef.current.value = '';
    onDirty();
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`${name}-upload`}>
      <span className="text-sm text-muted-foreground">{label}</span>

      <div className="flex items-start gap-4">
        {/* blob: and the Supabase origin are both already in the CSP's img-src
            (src/lib/security/csp.ts), so neither the pick nor the stored
            picture needs a change there. */}
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className={
              kind === 'banner'
                ? 'h-24 w-40 rounded-md border object-contain'
                : 'size-20 rounded-md border object-cover'
            }
            data-testid={`${name}-preview`}
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-20 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground"
          >
            {t('noPictureYet')}
          </span>
        )}

        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            name={name}
            accept={ARTWORK_ACCEPT}
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void choose(file);
            }}
            className="text-sm"
            data-testid={`${name}-input`}
          />
          {preview && !disabled && (
            <Button type="button" variant="outline" onClick={remove} data-testid={`${name}-remove`}>
              {t('removePicture')}
            </Button>
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
          {kind === 'thumb' && (
            <span className="text-xs text-muted-foreground">{t('largePicturesAreReduced')}</span>
          )}
        </div>
      </div>

      {/* Posted so the action can tell "left alone" from "taken away". Without
          it, an empty file input and a deliberate removal look identical. */}
      <input type="checkbox" name={`${name}Cleared`} checked={cleared} readOnly hidden />

      {problem && (
        <p className="text-sm text-destructive" data-testid={`${name}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add its four sentences to all three catalogues**

Under `common`, in `messages/en.json`, `messages/pt.json` and `messages/es.json`:

| Key | en | pt | es |
| --- | --- | --- | --- |
| `noPictureYet` | No picture | Sem imagem | Sin imagen |
| `removePicture` | Remove picture | Remover imagem | Quitar imagen |
| `largePicturesAreReduced` | Large pictures are reduced automatically. | Imagens grandes são reduzidas automaticamente. | Las imágenes grandes se reducen automáticamente. |
| `thatPictureCouldNotBeRead` | That picture could not be read. Save it again as a JPEG or a PNG. | Não foi possível ler essa imagem. Salve novamente como JPEG ou PNG. | No se pudo leer esa imagen. Guárdela de nuevo como JPEG o PNG. |

Check that `common` is the namespace this project uses for shared component
copy; if the shared strings live elsewhere, follow that and change
`useTranslations('common')` in the component to match.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test -- tests/unit/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/media messages
git commit -m "feat(images): the upload control, reducing a thumb and refusing a banner"
```

---

### Task 10: The promotion screens

**Files:**
- Modify: `src/app/(app)/promotions/promotion-fields.tsx`
- Modify: `src/app/(app)/promotions/whatsapp-fields.tsx`
- Modify: `src/app/(app)/promotions/actions.ts`
- Modify: `src/app/(app)/promotions/promotion-record-dialog.tsx`
- Modify: `src/app/(app)/promotions/register-promotion-form.tsx`
- Modify: `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `ImageUploadField` (Task 9), `uploadPromotionImage` / `clearPromotionImage` (Task 6).
- Produces: no new exports; `createPromotionAction` and `updatePromotionAction` gain image handling.

- [ ] **Step 1: Put the thumb on the Promotion tab**

In `promotion-fields.tsx`, above the name field:

```tsx
      <ImageUploadField
        name="thumb"
        kind="thumb"
        currentUrl={record?.thumbUrl ?? null}
        disabled={disabled}
        onDirty={onDirty}
        label={t('promotionPicture')}
        hint={t('shownOnTheListAndTheRecord')}
      />
```

`PromotionFields` takes `record: PromotionDetail | null` already, so the
registration dialog passes `null` and the control starts empty.

- [ ] **Step 2: Replace the banner's address input**

In `whatsapp-fields.tsx`, delete the `useArt` checkbox, the `artUrl` `<Input>`,
the preview `<img>` and the `useArt` / `artUrl` state. In their place, inside
the same bordered block:

```tsx
          <ImageUploadField
            name="art"
            kind="banner"
            currentUrl={record?.artUrl ?? null}
            disabled={disabled}
            onDirty={onDirty}
            label={t('bannerSentWithTheReply')}
            hint={t('whatsappFetchesThisImageItselfAnd')}
          />
```

Leave a comment where the tick was: having a banner is now the tick, because
`promotions_art_shape` has always forced `use_art` to agree with `art_url`.

- [ ] **Step 3: Handle the files in the actions**

In `promotions/actions.ts`, add one reader used by both actions:

```ts
/**
 * The two pictures do not travel with the rest of the form.
 *
 * update_promotion no longer takes them (0144) and create_promotion never has a
 * record to key an upload against, so both actions save the promotion first and
 * then settle each picture against the id. A picture that fails to upload
 * therefore leaves a promotion that saved — which is the right way round, and
 * the message below says so rather than implying the whole save was lost.
 */
async function settlePromotionImages(
  token: string,
  companyId: string,
  promotionId: string,
  formData: FormData,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<string | null> {
  for (const kind of ['thumb', 'banner'] as const) {
    const field = kind === 'thumb' ? 'thumb' : 'art';
    const file = formData.get(field);
    const cleared = formData.get(`${field}Cleared`) === 'on';

    try {
      if (file instanceof File && file.size > 0) {
        await uploadPromotionImage(token, { kind, companyId, promotionId, file });
      } else if (cleared) {
        await clearPromotionImage(token, { kind, promotionId });
      }
    } catch (cause) {
      logger.error({ err: cause, promotionId, kind }, 'promotion image failed');
      return describePromotionsWriteError(cause, t, 'actionEditThisPromotion');
    }
  }
  return null;
}
```

Call it from `createPromotionAction` after `createPromotion` returns the id, and
from `updatePromotionAction` after `updatePromotion` resolves. When it returns a
message, answer `{ status: 'error', message, promotionId }` — the id is carried
so the dialog still refreshes onto the promotion that did save.

`updatePromotionAction` needs the Station id for the key: it is already on the
form as the hidden `companyId` the dialog renders, and `parsed.data.companyId`
holds it.

- [ ] **Step 4: Check the two dialogs still submit one form**

`promotion-record-dialog.tsx` keeps the Promotion and WhatsApp tabs hidden
rather than unmounted — the file inputs must stay mounted for the same reason
every other field does. Confirm no `hidden` prop was traded for a conditional
render.

- [ ] **Step 5: Add the three labels to all three catalogues, and remove two**

Add under `promotions`:

| Key | en | pt | es |
| --- | --- | --- | --- |
| `promotionPicture` | Promotion picture | Imagem da promoção | Imagen de la promoción |
| `shownOnTheListAndTheRecord` | Shown on the list and the record. Never sent to anyone. | Aparece na lista e na ficha. Nunca é enviada a ninguém. | Aparece en la lista y en la ficha. Nunca se envía a nadie. |
| `bannerSentWithTheReply` | Banner sent with the reply | Banner enviado na resposta | Banner enviado en la respuesta |

Delete `sendABannerWithTheReply` and `bannerAddress` from all three — the tick
and the address input they labelled are gone, and a key with no caller is the
debt Block 12c spent a day clearing.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/promotions" messages
git commit -m "feat(images): the thumb on the Promotion tab and the banner uploaded from the WhatsApp tab"
```

---

### Task 11: The prize screens

**Files:**
- Modify: `src/app/(app)/inventory/prize-form.tsx`
- Modify: `src/app/(app)/inventory/prize-record-dialog.tsx`
- Modify: `src/app/(app)/inventory/actions.ts`
- Modify: `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `ImageUploadField` (Task 9), `uploadPrizePhoto` / `clearPrizePhoto` (Task 7).
- Produces: no new exports; `createPrizeAction` and `updatePrizeAction` gain photograph handling.

- [ ] **Step 1: Put the control on both prize forms**

In `prize-form.tsx`, above the name field:

```tsx
      <ImageUploadField
        name="photo"
        kind="thumb"
        currentUrl={null}
        disabled={pending}
        onDirty={() => undefined}
        label={t('prizePicture')}
        hint={t('shownOnTheStockList')}
      />
```

In `PrizeDataForm` inside `prize-record-dialog.tsx`, the same block with
`currentUrl={prize.photoUrl}` and `onDirty={() => onDirty(true)}`.

- [ ] **Step 2: Settle the photograph in the actions**

In `src/app/(app)/inventory/actions.ts`:

```ts
/**
 * The photograph does not travel with the rest of the form.
 *
 * update_prize does not take it (0145) and createPrize has no record to key an
 * upload against until it exists, so both actions save the prize first and then
 * settle the picture against the id. A photograph that fails to upload leaves a
 * prize that saved — which is the right way round, and the message says so
 * rather than implying the save was lost.
 */
async function settlePrizePhoto(
  token: string,
  companyId: string,
  prizeId: string,
  formData: FormData,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<string | null> {
  const file = formData.get('photo');
  const cleared = formData.get('photoCleared') === 'on';

  try {
    if (file instanceof File && file.size > 0) {
      await uploadPrizePhoto(token, { companyId, prizeId, file });
    } else if (cleared) {
      await clearPrizePhoto(token, prizeId);
    }
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'prize photograph failed');
    return describeInventoryWriteError(cause, t, 'actionEditThisPrize');
  }
  return null;
}
```

Use whichever error describer and subject key `inventory/errors.ts` actually
exports — read it rather than assuming the promotions spelling.

Call it from `createPrizeAction` after `createPrize` returns the id, and from
`updatePrizeAction` after `updatePrize` resolves.

- [ ] **Step 3: Give the dialog back a prize that knows its own picture**

`PrizeDataForm` feeds `onSaved(state.prize)` upward and the grid patches its row
from it, so an action that returns the pre-upload summary will show the old
picture until the record is reopened. After `settlePrizePhoto` succeeds, either
re-read the prize or fold the URL the upload returned into the summary the
action already returns — the second is one line and costs no round trip:

```ts
  const url = await uploadPrizePhoto(...);   // returns the stored address
  // ... and the action answers { status: 'saved', prize: { ...saved, photoUrl: url } }
```

- [ ] **Step 4: Add the two labels to all three catalogues**

Under `inventory`: `prizePicture` (Prize picture / Imagem do prêmio / Imagen del
premio) and `shownOnTheStockList` (Shown on the stock list. / Aparece na lista de
estoque. / Aparece en la lista de stock.).

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/inventory" messages
git commit -m "feat(images): the prize photograph, on registration and on the record"
```

---

### Task 12: The journey, measured

**Files:**
- Create: `tests/e2e/images.spec.ts`
- Read for reference: `tests/e2e/promotions-flow.spec.ts`, `tests/e2e/inventory-flow.spec.ts`, `tests/local-supabase.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the spec**

Four checks, in one journey per screen. Fixtures are generated in the test
rather than committed — a 40×40 PNG written with the same helper Task 1's unit
test uses, so no binary enters the repository.

1. **Promotion thumb.** Open a promotion, choose a file, save, and assert
   `[data-testid="image-thumb"]` appears on the promotions grid row.
2. **Banner.** Turn WhatsApp on, upload a banner, save, and assert the record
   shows it. Then upload a second one and assert **the bucket holds exactly one
   object** under `promotion-banners/<company>/<promotion>` — the guarantee this
   block was asked for:

```ts
const { data } = await serviceClient.storage
  .from('artwork')
  .list(`promotion-banners/${companyId}`);
expect(data?.filter((o) => o.name === promotionId)).toHaveLength(1);
```

3. **Removal.** Clear the banner, save, and assert the column is null and a row
   exists in `storage_erasure_queue` naming that key.
4. **Prize photograph.** Upload on the prize record and assert the thumbnail on
   the inventory grid.

Use Playwright's `setInputFiles` with a `{ name, mimeType, buffer }` literal.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- images.spec.ts`
Expected: PASS. If the run is flaky, check the worker count first — Block 13a
lost a day to a suite that passed only because two workers hid it
(`playwright.config.ts`).

- [ ] **Step 3: Run everything**

Run: `npm run typecheck && npm run lint && npm test && npm run db:test && npm run test:e2e`
Expected: all green. Report actual output; do not claim a pass without it.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/images.spec.ts
git commit -m "test(images): the upload journey, and the one object a second upload leaves behind"
```

---

## Verification before the PR

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run db:reset && npm run db:test`
- [ ] `npm run test:e2e`
- [ ] `npm run test:isolation` — the tenant-isolation suite, which the pgTAP suite structurally cannot see (Block 13a's own note)
- [ ] Read the diff for a comment that no longer matches its code. This project has shipped one twice.
