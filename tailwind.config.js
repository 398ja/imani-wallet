/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      transitionTimingFunction: {
        // A critically damped spring (damping 1.0, apple-design §4) sampled as a CSS `linear()`
        // curve: x(t) = 1 - (1 + ωt)e^(-ωt), ω = 9 over the transition's duration. Used on
        // transitions (not keyframes), so a reversed toggle retargets from where it is.
        spring:
          'linear(0, 0.055, 0.173, 0.31, 0.442, 0.559, 0.657, 0.737, 0.801, 0.85, 0.888, 0.917, 0.939, 0.955, 0.967, 0.976, 0.983, 0.987, 0.991, 0.993, 0.995, 0.997, 0.998, 0.998, 1)',
      },
      colors: {
        // Mono-inspired palette
        mono: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a',
        },
      },
      fontFamily: {
        // The platform's own font, deliberately — not a fallback for a webfont
        // that failed. Inter was declared here and in an `@import` that PostCSS
        // dropped (an `@import` after `@tailwind` is invalid), with no <link> to
        // back it up, so every screen has always rendered in system-ui anyway.
        // It is also the better answer: the system face already ships optical
        // sizing, per-size tracking tables and legibility tuning that a webfont
        // does not, and it costs no render-blocking request to a third party on
        // a wallet that should open instantly and phone nobody.
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      /**
       * Tracking belongs to the SIZE, not to the call site.
       *
       * One letter-spacing cannot be right everywhere: letters read too far
       * apart as they grow, and too tight as they shrink. So it is defined here
       * with each size — negative for display type, through zero at body, and
       * slightly positive for the small print — and every existing `text-*`
       * inherits it without a single class changing.
       *
       * Line heights are Tailwind's own, restated because redefining a size
       * drops them. They already run inversely to size, which is the other half
       * of the same rule.
       */
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        sm: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '0.005em' }],
        base: ['1rem', { lineHeight: '1.5rem', letterSpacing: '0' }],
        lg: ['1.125rem', { lineHeight: '1.75rem', letterSpacing: '-0.005em' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em' }],
        // The two in-between sizes the flow screens reach for (Buy, its
        // return pages, the claim prompts), named so they stop being written as
        // `text-[22px]` / `text-[15px]`. A px literal ignores the reader's text
        // size setting, which is the one thing a rem exists to honour, and it
        // carries no tracking or leading, so each call site restated those too.
        // `title` is a screen's one heading (22px at the default root size);
        // `callout` is the sentence under it (15px), with paragraph leading.
        callout: ['0.9375rem', { lineHeight: '1.5rem', letterSpacing: '0' }],
        title: ['1.375rem', { lineHeight: '1.75rem', letterSpacing: '-0.02em' }],
        // A money figure: the largest type in the app, so it takes the most
        // tracking. Named `amount` and not `balance` for two reasons — most of
        // its uses are transaction amounts rather than balances, and `balance`
        // silently shadowed Tailwind's own `text-balance` (text-wrap), leaving
        // which one won down to the order the two happened to be emitted in.
        amount: ['3rem', { lineHeight: '1', letterSpacing: '-0.025em', fontWeight: '600' }],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
}
