import { z } from 'zod';

/**
 * Block 19a, Task 7. What `?open=`/`&id=` -- Task 6's door, carried through
 * its redirect -- may ask `page.tsx` to open, narrowed to the two shapes
 * `menu.tsx` understands.
 *
 * SHAPE ONLY. Whether a named promotion is one THIS listener may actually
 * see is not this function's question -- it is `EnterPromotionPanel`'s,
 * asked with the same `listPromotionsAction` call the panel already makes to
 * draw its own list. Answering it here would mean a second query for a
 * question one component already asks, and a page that 404s or 500s on a
 * bad `id` instead of falling back to the menu -- exactly what this block's
 * own rule forbids for a URL somebody may have edited by hand.
 *
 * LIVES OUTSIDE `page.tsx` TO BE TESTABLE. `page.tsx` is a Server Component
 * that reads cookies and calls a database door; this is neither, so a test
 * can call it directly, the same split `music-mapping.ts` and
 * `promotion-mapping.ts` make for their own `'use server'` files.
 */
export type WidgetOpenTarget =
  | { kind: 'menu' }
  | { kind: 'music' }
  | { kind: 'promotion'; id: string };

const promotionIdSchema = z.string().uuid();

/**
 * `open`/`id` from the query string, as `page.tsx` receives them from
 * `searchParams` -- `string | string[] | undefined`, since Next does not
 * promise a repeated key collapses to one value.
 *
 * A BAD VALUE IS NEVER AN ERROR. `open=music` opens the song panel;
 * `open=promotion` with an `id` that is the SHAPE of a UUID opens that
 * promotion's panel (subject to the visibility check above); anything else
 * -- no `open`, an `open` this page does not know, `promotion` with no `id`
 * or a malformed one -- is the menu. The route handler (`enter/route.ts`)
 * already drops everything outside these two destinations before it
 * redirects here; this reads the address bar directly, because a listener
 * can reach `/w/<publicKey>?open=…` without ever having passed through that
 * door at all.
 */
export function parseOpenTarget(
  open: string | string[] | undefined,
  id: string | string[] | undefined,
): WidgetOpenTarget {
  if (Array.isArray(open) || Array.isArray(id)) return { kind: 'menu' };

  if (open === 'music') return { kind: 'music' };

  if (open === 'promotion') {
    const parsed = promotionIdSchema.safeParse(id);
    if (parsed.success) return { kind: 'promotion', id: parsed.data };
  }

  return { kind: 'menu' };
}
