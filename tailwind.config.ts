import type { Config } from 'tailwindcss';
// Imported rather than require()d: Tailwind's config loader pulls this file in
// through loadESMFromCJS, where `require` is undefined, and the dev server dies
// on the first CSS compile.
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  // Block 25, D1. TWO TRIGGERS, because the theme has three states and only two
  // of them are a class.
  //
  // `['class']` would leave every `dark:` utility responding to an explicit
  // choice alone — so somebody on System with a dark machine would get the dark
  // TOKENS (globals.css handles them through its own media query) and the light
  // `dark:` utilities, on the same page. A theme half-applied is worse than one
  // not applied at all, because only half of it is legible.
  //
  // `:not(.light *)` on the second is what lets an explicit Light choice win
  // over a dark machine, matching the guard on the media-query block in
  // globals.css. The two have to say the same thing, and they do.
  //
  // Almost nothing consumes this today — the sweep in this block converts the
  // three hand-written `dark:` utilities to tokens — so it may well end with no
  // consumers at all. Kept correct anyway: the next person to write one will not
  // read this file first.
  darkMode: [
    'variant',
    ['&:is(.dark *)', '@media (prefers-color-scheme: dark) { &:not(.light *) }'],
  ],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      // Maps the CSS variables from `src/app/globals.css` to the semantic
      // tokens shadcn/ui generates (`cssVariables: true`).
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Block 25, D9. The third and fourth semantic colours, beside
        // `destructive` and used exactly as it is: solid for text and icons,
        // `/10` for the tinted badge behind them.
        //
        // The `hsl(var(--x))` form is not stylistic — it is what keeps the
        // opacity modifier working. Tailwind rewrites this to
        // `hsl(var(--success) / 0.1)` for `bg-success/10`; a token holding a
        // finished colour instead of a triple would make `/10` silently do
        // nothing, and `bg-destructive/10` in SITUATION_CLASSES is the proof
        // that the modifier is load-bearing here.
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        // The sidebar is a separate surface with its own scale — see the
        // comment beside these tokens in globals.css.
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          muted: 'hsl(var(--sidebar-muted))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
