import { describe, expect, it } from 'vitest';
import {
  buildConsentInteractive,
  buildInteractivePayload,
  InteractiveLimitError,
  type Interactive,
} from '@/lib/integrations/whatsapp/interactive';

// Cloud API's documented shape for `type: 'interactive'`:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#interactive-object
interface CloudApiInteractivePayload {
  type: 'interactive';
  interactive: {
    type: 'button' | 'list';
    header?: { type: 'image'; image: { link: string } };
    body: { text: string };
    action: {
      buttons?: { type: 'reply'; reply: { id: string; title: string } }[];
      button?: string;
      sections?: { title: string; rows: { id: string; title: string }[] }[];
    };
  };
}

const buttons = (n: number, title = 'Yes'): { id: string; title: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, title: `${title}-${i}` }));

describe('buildInteractivePayload — buttons', () => {
  it('builds the documented Cloud API shape with no header when imageUrl is null', () => {
    const interactive: Interactive = {
      kind: 'buttons',
      body: 'Want to enter?',
      imageUrl: null,
      buttons: [
        { id: 'yes', title: 'Quero!' },
        { id: 'no', title: 'Agora não' },
      ],
    };
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;

    expect(payload.type).toBe('interactive');
    expect(payload.interactive.type).toBe('button');
    expect(payload.interactive.body).toEqual({ text: 'Want to enter?' });
    expect(payload.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'yes', title: 'Quero!' } },
      { type: 'reply', reply: { id: 'no', title: 'Agora não' } },
    ]);
    // No art configured means no header key at all -- not a header with a
    // missing link, which Meta itself would 400 on.
    expect(payload.interactive.header).toBeUndefined();
    expect('header' in payload.interactive).toBe(false);
  });

  it('adds an image header only when imageUrl is set', () => {
    const interactive: Interactive = {
      kind: 'buttons',
      body: 'Want to enter?',
      imageUrl: 'https://cdn.example.com/banner.png',
      buttons: [{ id: 'yes', title: 'Quero!' }],
    };
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;

    expect(payload.interactive.header).toEqual({
      type: 'image',
      image: { link: 'https://cdn.example.com/banner.png' },
    });
  });

  it('accepts exactly three buttons', () => {
    const interactive: Interactive = { kind: 'buttons', body: 'b', imageUrl: null, buttons: buttons(3) };
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;
    expect(payload.interactive.action.buttons).toHaveLength(3);
  });

  it('refuses more than three buttons', () => {
    const interactive: Interactive = { kind: 'buttons', body: 'b', imageUrl: null, buttons: buttons(4) };
    expect(() => buildInteractivePayload(interactive)).toThrow(InteractiveLimitError);
  });

  it('accepts a button title of exactly twenty characters', () => {
    const title = 'x'.repeat(20);
    const interactive: Interactive = {
      kind: 'buttons',
      body: 'b',
      imageUrl: null,
      buttons: [{ id: 'a', title }],
    };
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;
    expect(payload.interactive.action.buttons?.[0]?.reply.title).toBe(title);
  });

  it('refuses a button title over twenty characters', () => {
    const title = 'x'.repeat(21);
    const interactive: Interactive = {
      kind: 'buttons',
      body: 'b',
      imageUrl: null,
      buttons: [{ id: 'a', title }],
    };
    expect(() => buildInteractivePayload(interactive)).toThrow(InteractiveLimitError);
  });
});

describe('buildInteractivePayload — list', () => {
  it('builds the documented Cloud API shape', () => {
    const interactive: Interactive = {
      kind: 'list',
      body: 'Pick one',
      menuTitle: 'Options',
      buttonLabel: 'Choose',
      rows: [
        { id: 'a', title: 'Option A' },
        { id: 'b', title: 'Option B' },
      ],
    };
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;

    expect(payload.type).toBe('interactive');
    expect(payload.interactive.type).toBe('list');
    expect(payload.interactive.body).toEqual({ text: 'Pick one' });
    expect(payload.interactive.action.button).toBe('Choose');
    expect(payload.interactive.action.sections).toEqual([
      {
        title: 'Options',
        rows: [
          { id: 'a', title: 'Option A' },
          { id: 'b', title: 'Option B' },
        ],
      },
    ]);
  });
});

describe('buildConsentInteractive', () => {
  it('puts the promotion name before the call to action, separated by a blank line', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: 'Answer three questions to enter.',
      useArt: false,
      artUrl: null,
      buttons: [
        { id: 'yes', title: 'Quero!' },
        { id: 'no', title: 'Agora não' },
      ],
    });
    expect(interactive.kind).toBe('buttons');
    expect(interactive.body).toBe('Summer Giveaway\n\nAnswer three questions to enter.');
  });

  it('uses the name alone when the call to action is empty', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: '',
      useArt: false,
      artUrl: null,
      buttons: [{ id: 'yes', title: 'Quero!' }],
    });
    expect(interactive.body).toBe('Summer Giveaway');
  });

  it('uses the name alone when the call to action is null', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: null,
      useArt: false,
      artUrl: null,
      buttons: [{ id: 'yes', title: 'Quero!' }],
    });
    expect(interactive.body).toBe('Summer Giveaway');
  });

  it('carries the art url as the header image when use_art is set', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: null,
      useArt: true,
      artUrl: 'https://cdn.example.com/banner.png',
      buttons: [{ id: 'yes', title: 'Quero!' }],
    });
    expect(interactive.kind).toBe('buttons');
    if (interactive.kind === 'buttons') {
      expect(interactive.imageUrl).toBe('https://cdn.example.com/banner.png');
    }
  });

  it('has no header when use_art is false, even if an art url is present', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: null,
      useArt: false,
      artUrl: 'https://cdn.example.com/banner.png',
      buttons: [{ id: 'yes', title: 'Quero!' }],
    });
    expect(interactive.kind).toBe('buttons');
    if (interactive.kind === 'buttons') {
      expect(interactive.imageUrl).toBeNull();
    }
  });

  it('does not invent button labels — it passes through whatever the caller supplies', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: null,
      useArt: false,
      artUrl: null,
      buttons: [
        { id: 'yes', title: '' },
        { id: 'no', title: '' },
      ],
    });
    expect(interactive.kind).toBe('buttons');
    if (interactive.kind === 'buttons') {
      expect(interactive.buttons).toEqual([
        { id: 'yes', title: '' },
        { id: 'no', title: '' },
      ]);
    }
  });

  it('composes a consent message that builds into a valid Cloud API payload', () => {
    const interactive = buildConsentInteractive({
      name: 'Summer Giveaway',
      callToAction: 'Answer three questions to enter.',
      useArt: true,
      artUrl: 'https://cdn.example.com/banner.png',
      buttons: [
        { id: 'yes', title: 'Quero!' },
        { id: 'no', title: 'Agora não' },
      ],
    });
    const payload = buildInteractivePayload(interactive) as CloudApiInteractivePayload;
    expect(payload.interactive.header).toEqual({
      type: 'image',
      image: { link: 'https://cdn.example.com/banner.png' },
    });
    expect(payload.interactive.body.text).toBe(
      'Summer Giveaway\n\nAnswer three questions to enter.',
    );
    expect(payload.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'yes', title: 'Quero!' } },
      { type: 'reply', reply: { id: 'no', title: 'Agora não' } },
    ]);
  });
});
