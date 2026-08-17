'use client';

import { useEffect, useRef, useState } from 'react';
import type { GeographyPlace } from '@/schemas/geography';
import { circleRadius, mapScriptUrl, MAPS_READY_CALLBACK } from './place-map-geometry';

/**
 * Block 28. The Google map, and the only client component in this block.
 *
 * IT INJECTS ITS OWN <script> AND NEEDS NO NONCE, which is the part worth
 * explaining. src/lib/security/csp.ts puts `'strict-dynamic'` in script-src;
 * under that keyword a script the browser already trusted — every bundle Next
 * serves, because Next stamps its own nonce on them — may load further scripts,
 * PROVIDED it creates them with `document.createElement`. The propagation does
 * NOT extend to markup written through `innerHTML`, which is why the element is
 * built here rather than assembled as a string.
 *
 * The same clause is why maps.googleapis.com is deliberately absent from
 * script-src: 'strict-dynamic' makes a browser ignore host allowlists in that
 * directive entirely, so naming it there would be inert. It IS in img-src and
 * connect-src, which strict-dynamic does not touch.
 */

const SCRIPT_ID = 'google-maps-js';

interface MapsGlobal {
  maps?: {
    Map: new (element: HTMLElement, options: Record<string, unknown>) => unknown;
    Circle: new (options: Record<string, unknown>) => unknown;
    LatLngBounds: new () => { extend(point: { lat: number; lng: number }): void };
  };
}

/**
 * ONE LOAD PER PAGE, remembered here.
 *
 * This module-level promise replaced a lookup for an existing <script id>, which
 * was wrong in a way that produced NO message at all: if the tag was already in
 * the DOM and had already finished, attaching a fresh `load` listener waited for
 * an event that had come and gone, the promise never settled, and the panel
 * rendered an empty box forever. That is the ordinary path when an operator
 * moves between the Audience and Music dashboards, because a client-side
 * navigation leaves the tag in `document.head`.
 *
 * A promise is the right memory precisely because it holds the RESULT of an
 * event rather than the chance to hear it: a second caller arriving after the
 * library is ready resolves immediately.
 */
let loading: Promise<void> | null = null;

function loadMaps(apiKey: string): Promise<void> {
  const google = (window as unknown as { google?: MapsGlobal }).google;
  if (google?.maps?.Map) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    // GOOGLE CALLS THIS, and waiting on the script's own `load` event instead is
    // what broke the map in production. Under `loading=async` the bootstrap
    // finishes downloading — firing `load` — BEFORE `google.maps` is populated,
    // so a caller that trusted `load` found no library and reported it could not
    // be loaded. `callback` is the event that actually means "ready".
    (window as unknown as Record<string, unknown>)[MAPS_READY_CALLBACK] = () => resolve();

    // createElement, not innerHTML: see this file's header. The one is allowed
    // by 'strict-dynamic' and the other is not.
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = mapScriptUrl(apiKey);
    script.addEventListener('error', () => {
      // Cleared so a later mount can try again. A network blip must not leave
      // every subsequent render resolving a promise that is permanently
      // rejected.
      loading = null;
      script.remove();
      reject(new Error('maps script failed'));
    });
    document.head.appendChild(script);
  });

  return loading;
}

export function PlaceMap({
  apiKey,
  places,
  label,
  unavailableLabel,
  refusedLabel,
}: {
  apiKey: string;
  places: GeographyPlace[];
  label: string;
  /** Shown when the library will not load at all — a blocked request, an offline browser, an ad blocker. */
  unavailableLabel: string;
  /** Shown when the library loaded and Google REFUSED the key — a different fix, in a different console. */
  refusedLabel: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // THE ONLY HOOK GOOGLE GIVES FOR A REJECTED KEY, and without it this
    // component cannot tell a refusal from a success. The script loads, the
    // `load` event fires, `google.maps` exists, `new Map()` returns — and then
    // the library paints its own grey "Oops! Something went wrong" card INSIDE
    // our container. So every promise here resolves and the panel renders a
    // Google-branded English error where our own message belongs, with nothing
    // to tell the operator whether the fault is the data, the code, or their
    // key. It is a global by Google's design, not by ours.
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      if (!cancelled) setRefused(true);
    };

    loadMaps(apiKey)
      .then(() => {
        if (cancelled || !container.current) return;
        // `.Map` and not merely `.maps`: the namespace can exist while the
        // constructor this component needs does not, and `new undefined()` is a
        // TypeError the user would meet as a blank panel rather than as our
        // sentence.
        const google = (window as unknown as { google?: MapsGlobal }).google;
        if (!google?.maps?.Map) return setFailed(true);

        const bounds = new google.maps.LatLngBounds();
        for (const place of places) bounds.extend({ lat: place.latitude, lng: place.longitude });

        const map = new google.maps.Map(container.current, {
          // Fitted to the places rather than centred on a guess. With none —
          // which the panel above already refuses to render — there would be
          // nothing to fit, so this component is never mounted empty.
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        }) as { fitBounds(b: unknown): void };
        map.fitBounds(bounds);

        // ONE CIRCLE PER PLACE, SIZED BY COUNT, rather than one marker each. A
        // marker says "something is here"; a radio wants to see WHERE ITS
        // AUDIENCE IS CONCENTRATED, and a pin gives every neighbourhood the
        // same visual weight whether it holds three listeners or three hundred.
        // `circleRadius` (./place-map-geometry) is why the sizing does not lie.
        const largest = Math.max(...places.map((place) => place.count), 1);
        for (const place of places) {
          new google.maps.Circle({
            map,
            center: { lat: place.latitude, lng: place.longitude },
            radius: circleRadius(place.count, largest),
            strokeColor: '#2563eb',
            strokeOpacity: 0.8,
            strokeWeight: 1,
            fillColor: '#2563eb',
            fillOpacity: 0.25,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      delete (window as unknown as { gm_authFailure?: () => void }).gm_authFailure;
      // MAPS_READY_CALLBACK is deliberately NOT deleted. Google calls it once,
      // by name, whenever the library finishes — and a component that unmounted
      // while the script was still in flight would otherwise remove the function
      // Google is about to call, leaving `loading` pending forever and every
      // later mount waiting on it. The resolve it triggers is harmless after
      // unmount; the promise is what the next mount reuses.
    };
  }, [apiKey, places]);

  // A REFUSED KEY IS ITS OWN MESSAGE, separate from "could not load". They are
  // different jobs for whoever reads them: one is fixed in the Google Cloud
  // console, the other is a blocked request or an offline browser. Telling an
  // operator "the map could not be loaded" when the real answer is "your key is
  // restricted to the wrong host" sends them to look at us instead of at it.
  if (refused) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="place-map-refused">
        {refusedLabel}
      </p>
    );
  }

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="place-map-unavailable">
        {unavailableLabel}
      </p>
    );
  }

  return (
    <div
      ref={container}
      role="img"
      aria-label={label}
      data-testid="place-map"
      className="h-72 w-full rounded-md border"
    />
  );
}
