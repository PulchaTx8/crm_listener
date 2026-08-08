# Block 14 — Images for promotions and prizes

**Date:** 2026-08-07
**Status:** approved
**Delivery:** one block, one PR, branched from `main`

---

## 1. What this is for

Three screens name a thing and show no picture of it.

- A promotion's banner exists, but only as an address somebody typed. Nobody in
  this system has ever uploaded one; the operator has to host the file
  elsewhere first, and a typo in the address surfaces as a WhatsApp message
  that arrives without its image.
- A promotion has nothing at all to identify it by inside the CRM. The list is
  text.
- A prize has no photograph anywhere. The inventory list is text.

This block gives the operator a file picker in three places, uploads to
storage, and puts a thumbnail on the two lists — the same way Block 13a put the
album cover on every screen that names a song.

**Two images per promotion, and they are not the same image.** One identifies
the promotion inside this system; the other is fetched by Meta and shown to
listeners. They have different sizes, different rules and different owners, and
collapsing them into one field was rejected during design.

---

## 2. Decisions

Every one was decided by the owner on 2026-08-07.

| | |
| --- | --- |
| **D1** | The banner **stays on the WhatsApp tab**. It gains upload and nothing else moves. |
| **D2** | The Promotion tab gains a **thumb** — a smaller picture, for identifying the promotion inside the system: the list, the record. It is never sent anywhere. |
| **D3** | A prize gains **one photograph**, of the same kind as the thumb and for the same purpose. |
| **D4** | One **public** bucket, three prefixes. Public because Meta fetches the banner itself and a signed URL would expire before the send. |
| **D5** | **Upload only.** The typed-address field leaves the screen. |
| **D6** | One object per record per purpose, at a **deterministic key**, always overwritten. Uploading again replaces; nothing accumulates. |
| **D7** | Thumb and prize photo are **reduced in the browser** to fit; the banner is **refused** when it is too large. Rewriting somebody's promotional artwork without asking is not this system's business; resizing a 32-pixel identifier is. |
| **D8** | The banner's format and byte rules are **Meta's**; the pixel ceiling is **ours**, and the code says so. |

---

## 3. What Meta actually requires

Checked against the Cloud API reference on 2026-08-07 rather than assumed:

- **JPEG and PNG only.** Nothing else is accepted for an image message.
- **5 MB maximum.**
- **8-bit, RGB or RGBA.**
- **No published pixel limit.** The 1.91:1 / 1125×600 figure that circulates
  belongs to template and carousel media, not to the image header of an
  interactive message.

So the pixel ceiling below is a decision of this project's, taken to stop a
40-megapixel phone photograph being pushed through a message header, and it is
labelled as ours in the code. Anything asserting Meta requires it would be
false, and this project has already shipped one comment that outlived its own
truth.

---

## 4. The three slots

| Column | Screen | Purpose | Rules |
| --- | --- | --- | --- |
| `promotions.thumb_url` *(new)* | Promotion tab | identifies the promotion in this system | JPEG/PNG, ≤ 512 KB after reduction, reduced to fit 512×512 |
| `promotions.art_url` *(exists)* | WhatsApp tab | Meta fetches and sends it | JPEG/PNG, ≤ 5 MB, ≤ 1920 px on the longest side |
| `prizes.photo_url` *(new)* | prize registration and record | identifies the prize in this system | same as the thumb |

Two kinds, not three: **thumb** (internal, reduced in the browser) and **banner**
(outbound, refused when oversized). The prize photograph is a thumb.

---

## 5. Storage

### 5.1 The bucket

`artwork`, **public**, with three prefixes:

```
artwork/promotion-thumbs/<company_id>/<promotion_id>
artwork/promotion-banners/<company_id>/<promotion_id>
artwork/prize-photos/<company_id>/<prize_id>
```

**Public, and the reason is not convenience.** Meta fetches the banner from our
URL at send time, which may be days after the operator uploaded it. A signed
URL expires; a private bucket would mean the banner works on the day it is set
and silently stops working later. The delivery receipt stays private, as it is
today — a receipt is a photograph of a real person handing over a prize, which
is personal data; a banner and a product photograph are promotional material.
That line is where it was drawn in 0086 and it does not move.

Keys are UUIDs in both segments, so the bucket cannot be walked.

### 5.2 No file extension in the key, deliberately

The key ends at the record's id. This is what makes D6 structural rather than
hopeful: the operator who uploads a JPEG on Monday and a PNG on Tuesday
overwrites the same object, because the key does not mention the format. With
an extension in the name, "replace the previous one" becomes "delete the old
object and write a new one" — two steps, and the first can fail.

The consequence, and it is load-bearing: **the upload must set `contentType`
explicitly** from the validated MIME type. Storage serves what it was told; an
extensionless object uploaded without a content type is served as
`application/octet-stream`, and Meta refuses that. The stored type comes from
the closed list, never from what the browser claimed — the same rule
`src/lib/security/uploads.ts` already states for receipts.

### 5.3 The version stamp

A deterministic key means a stable public URL, which means the browser and the
CDN keep showing the picture that was replaced. Every write therefore stores
the URL with a stamp:

```
https://<project>.supabase.co/storage/v1/object/public/artwork/promotion-banners/<c>/<p>?v=1754582400000
```

The column changes on every upload, so every screen and Meta's fetcher see the
new image immediately. Query strings do not disturb Meta's fetch.

### 5.4 Who may write

Reads are public. Writes are closed by policy on `storage.objects`, in the
shape 0086 established — decided from the path alone, without joining anything:

- `promotion-thumbs/` and `promotion-banners/` require `promotions.edit` at the
  Station named in the second segment.
- `prize-photos/` requires `inventory.catalogue` at that Station.

Both `INSERT` and `UPDATE`, because an upsert needs both and a bucket that
accepts the first upload and refuses the replacement is worse than one that
refuses both.

The second segment is checked against a UUID shape **before** the cast. 0086
casts `(storage.foldername(name))[1]::uuid` directly, which raises `22P02` on a
malformed path rather than denying it; the paths are built by our own code so
it has never fired, but a policy that errors where it means to refuse is not a
policy anyone should copy forward without noticing.

No `DELETE` policy for `authenticated`. Deletion is the erasure queue's, drained
by the worker through `service_role` — the shape 0123 chose, for its reason.

### 5.5 The wall, and what is only a courtesy

The bucket carries `file_size_limit = 5 MiB` and
`allowed_mime_types = {image/jpeg, image/png}`. That is the check no client can
go around, in the spirit of 0134.

The **thumb's tighter limit is not a wall**, and the code will say so. Bucket
limits are per bucket, not per prefix, so a hostile client holding
`promotions.edit` could place a 5 MB object at a thumb key. What that buys them
is a slow list at their own Station. It is not worth a second bucket, and
pretending the app-level check is a boundary would be worse than admitting it
is not.

---

## 6. Database

### 6.1 `0143_artwork_bucket.sql`

The bucket, its limits, and the two write policies.

### 6.2 `0144_promotion_images.sql`

**A new column.** `promotions.thumb_url text`, with a shape check only — the
value is generated on the server and never posted by a client.

**A new writer for each image.**

```
set_promotion_thumb(p_promotion_id uuid, p_url text)
set_promotion_art  (p_promotion_id uuid, p_url text)
```

Both `security definer`, both gated on `promotions.edit` resolved from the
promotion row itself, both in the shape of `attach_delivery_receipt` (0086).
`null` clears.

`set_promotion_art` additionally:

- **refuses when `whatsapp_enabled` is false**, with a sentence, because
  `promotions_whatsapp_shape` does not admit a banner on a promotion that does
  not use WhatsApp;
- sets `use_art = (p_url is not null)`, which is all `use_art` has ever meant —
  `promotions_art_shape` already forces `use_art ≡ art_url is not null`.

**`create_promotion` and `update_promotion` stop taking `p_use_art` and
`p_art_url`.** This is the change that makes the rest safe. `update_promotion`
replaces every field it takes on every call; if the address leaves the form
while the parameter stays on the RPC, every Save silently deletes the banner.
One field, one writer.

Two consequences that must be written, not assumed:

- **`use_art` disappears from the screen.** Having a banner is now the tick.
  The owner accepted this during design; a promotion that wants to keep a
  banner without sending it no longer has a way to say so.
- **`update_promotion` clears the art when WhatsApp is switched off**, and
  queues the object for erasure in the same transaction. It has to: the
  constraint refuses the row otherwise, and an update that failed on a
  constraint would read to the operator as "could not save" with no field to
  point at.

**`promotions_art_https` is relaxed to accept loopback.** In development the
Storage origin is `http://127.0.0.1:54321`, so without this the feature cannot
run on the developer's machine or in the e2e suite. It is defensible for a
reason that did not exist before this block: **the address is no longer typed.**
The constraint was written to catch an operator's `http://` typo, and there is
no longer an operator typing. What replaces that protection is stronger — the
value is server-generated from the upload result, so no form can post an
address at all.

**Neither setter is subject to the freeze**, and this is not a gap. 0055's own
header lists what stays open for the whole life of a promotion: "the name, the
end date, the call to action, **the art**, the two button labels and adding a
question". The thumb joins that list by the same argument: nobody entered a
promotion because of the picture on the list screen.

### 6.3 `0145_prize_photo.sql`

`prizes.photo_url text`, and `set_prize_photo(p_prize_id uuid, p_url text)`
gated on `inventory.catalogue` resolved from the prize row. `update_prize` does
**not** touch it, for the reason given in §6.2.

### 6.4 Clearing, and the queue that never gives up

Clearing an image enqueues its object in `storage_erasure_queue` in the same
transaction that clears the column — the mechanism 0087 built and the worker
tick already drains.

With a guard: **enqueue only when the stored address is one of ours.**
Promotions registered before this block carry externally hosted addresses. An
object path derived from one of those names nothing, and 0087 deliberately has
no give-up threshold — a row that keeps failing stays queued for ever. The
guard is a `like` against this bucket's public prefix.

---

## 7. Application

| File | What |
| --- | --- |
| `src/lib/security/artwork.ts` *(new)* | the two kinds, their limits, the accept string, and the refusal sentences |
| `src/lib/security/image-dimensions.ts` *(new)* | width and height from the file's own bytes, server-side |
| `src/lib/storage/artwork.ts` *(new)* | key builders, public-URL builder, version stamp |
| `src/components/media/image-thumb.tsx` *(new)* | the thumbnail both lists render |
| `src/components/media/image-upload-field.tsx` *(new)* | picker, preview, Remove, and the browser-side reduction |
| `src/services/promotions.ts` | upload and clear for both images; `thumbUrl` on the summary and the detail |
| `src/services/inventory.ts` | upload and clear for the photograph; `photoUrl` in `PRIZE_COLUMNS` and `PrizeSummary` |
| `src/app/(app)/promotions/actions.ts` | the file rides with the form; new clear actions |
| `src/app/(app)/promotions/promotion-fields.tsx` | the thumb control |
| `src/app/(app)/promotions/whatsapp-fields.tsx` | the address input becomes the upload control |
| `src/app/(app)/promotions/promotions-grid.tsx` | thumbnail column |
| `src/app/(app)/inventory/prize-form.tsx`, `prize-record-dialog.tsx` | the photograph control |
| `src/app/(app)/inventory/inventory-grid.tsx` | thumbnail column |
| `src/schemas/promotions.ts` | `useArt` and `artUrl` leave the form schema, and the refinements that referred to them |
| `messages/{en,pt,es}.json` | the new sentences, in all three |

### 7.1 Reading dimensions on the server

The browser check is for the operator's benefit; the server's is the decision.
Because the bucket accepts exactly two formats, reading the size costs a small,
dependency-free reader: PNG carries width and height at a fixed offset inside
`IHDR`, and JPEG carries them in the `SOFn` marker, found by walking the
segment lengths. No image library, no native build.

### 7.2 Order of operations

**Upload the object, then write the row.** If the write fails, the object is
orphaned at a deterministic key — harmless, unreferenced, and overwritten by
the next upload. The other order would point a row at bytes that never arrived,
which is a broken image on every screen.

**Registering** has no id to build a key from, so the action creates the record,
uploads, then calls the setter. If the upload fails the record exists without a
picture and the message says exactly that.

### 7.3 The reduction

For thumb and prize photograph, the browser draws the chosen file to a canvas
at no more than 512×512, preserving aspect ratio, and exports JPEG. The
operator picks any photograph and it works. What is uploaded is generated by
the client, which changes nothing about who is trusted: the bucket and the
server validate it exactly as they validate anything else.

The **chosen** file is still bounded before any of that, at the same 5 MB the
bucket enforces. Reduction is not a reason to hand an arbitrary number of bytes
to a canvas: a file large enough to be worth reducing is also large enough to
lock the operator's tab while the browser decodes it.

The banner is never rewritten. Over 5 MB, over 1920 px, or not a JPEG/PNG, it
is refused with a sentence naming what was found and what is allowed — HEIC
included, because that is what an iPhone hands over and "unsupported file" is
not an answer anybody can act on.

---

## 8. Screens

**Promotion tab** gains a thumb block: picker, preview, Remove.

**WhatsApp tab** keeps the banner exactly where it is; the address input becomes
the same upload control, and the "send a banner with the reply" tick goes (§6.2).

**Prize** gains the same block on registration and on the record's data tab.

**Both lists** gain a first column in the shape `SongThumb` established in Block
13a: a plain `<img>`, lazily loaded, square with `object-cover`, and an honest
icon in the gap where there is no picture. A new component rather than reuse —
`SongThumb` speaks Deezer's `coverMd5`, not a URL.

`img-src` in the CSP already carries the Supabase origin and `blob:`, so the
stored images and the pre-upload previews both render with no change there.

---

## 9. Traps

Each of these has cost somebody a day somewhere, and each is closed above.

1. `update_promotion` replaces every field it takes — hence one writer per image.
2. A deterministic key means a stable URL means a stale cache — hence §5.3.
3. Storage local to a developer is `http://` — hence §6.2.
4. The erasure queue never gives up — hence the guard in §6.4.
5. An extensionless object with no `contentType` is served as
   `application/octet-stream`, and Meta refuses it — hence §5.2.
6. An upsert needs `INSERT` **and** `UPDATE` policies.
7. `promotions_whatsapp_shape` refuses a banner without WhatsApp, so switching
   WhatsApp off must clear it rather than fail the save.
8. Casting a path segment to `uuid` inside a policy errors on a malformed path
   instead of denying it — hence the shape check in §5.4.

---

## 10. Proof

**Unit.** The dimension reader against real PNG and JPEG bytes, including a
JPEG whose `SOFn` sits behind several segments. The refusal sentences. The key
and URL builders. The schema that lost two fields.

**pgTAP.** The bucket's limits and MIME list. Both policies: a caller without
`inventory.catalogue` cannot write to `prize-photos/`, nobody can write into
another Station's folder, and an unknown prefix is refused. All three setters:
permission, the WhatsApp refusal, the clear-and-enqueue, and the guard that
keeps a legacy external address out of the queue.

**e2e.** Upload a thumb and see it on the list. Upload a banner, upload a second
one, and confirm the bucket holds one object for that promotion — the guarantee
this block was asked for, measured rather than asserted.

---

## 11. Out of scope

- Cropping or an aspect-ratio editor. The banner is refused or accepted as it is.
- Any image on a listener, a member, a song or an artist.
- Sending the prize photograph in a WhatsApp message. The column is there if
  that is ever wanted; nothing in this block sends it.
- Making the delivery receipt public. It stays private, for 0086's reason.
