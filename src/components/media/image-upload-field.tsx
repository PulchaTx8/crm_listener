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
 * Picking a picture, and saying what is wrong with it before the operator waits
 * for an upload.
 *
 * EVERYTHING HERE IS FOR THE OPERATOR'S BENEFIT, not a boundary. This half runs
 * on a machine this product does not control; the service validates the same
 * file again (services/promotions.ts, services/inventory.ts) and the bucket
 * refuses the type and the size whatever either of them decides (0143).
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
  const t = useTranslations('shell');
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [picked, setPicked] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The blob: URL is the browser's to reclaim, and a dialog that opens fifty
  // promotions in a session leaks fifty pictures without this.
  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked);
    },
    [picked],
  );

  async function choose(file: File) {
    setProblem(null);

    // Checked BEFORE decoding, for both kinds. Reduction is not a reason to
    // hand an arbitrary number of bytes to a canvas: a file large enough to be
    // worth reducing is large enough to lock the operator's tab while the
    // browser decodes it.
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
      // small one rather than the original beside it. A DataTransfer is the
      // only way to write an input's files.
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
          // eslint-disable-next-line @next/next/no-img-element -- the same decision ImageThumb documents.
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
            className="flex size-20 items-center justify-center rounded-md border border-dashed p-1 text-center text-xs text-muted-foreground"
          >
            {t('noPictureYet')}
          </span>
        )}

        <div className="flex flex-col items-start gap-2">
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
          it an empty file input and a deliberate removal look identical, and
          every Save would clear the picture or none ever would. */}
      <input type="checkbox" name={`${name}Cleared`} checked={cleared} readOnly hidden />

      {problem && (
        <p className="text-sm text-destructive" data-testid={`${name}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}
