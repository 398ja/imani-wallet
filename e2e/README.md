# End-to-end checks

These drive the **real app in a real browser** against the live `imani-test`
stack. Everything else in this repo mounts components in jsdom, which proves
the component and not the product: jsdom cannot catch a broken route, a page
that throws on mount, an import only the bundler resolves, or CSS that does
not apply.

## Running

```sh
docker compose -f ../imani-deploy/docker-compose.test.yml up -d   # the stack
npm run dev -- --port 5177                                        # NOT preview
npm run e2e
```

The **dev server, not `vite preview`**: the API proxy that registration needs
is defined in `vite.config.ts` and preview does not apply it. Hitting preview
gets you a redirect to `/onboarding` and nothing else.

## What it covers

A merchant registers for real against the gateway, then the terminals screens
are driven by clicking. Notably it checks things unit tests structurally
cannot:

- clicking a `<label>` focuses its input (the `htmlFor` fix)
- `prefers-reduced-motion` actually suppresses the confirmation animation,
  **and** that it animates without the preference — so the check cannot pass
  by the class never being applied
- no uncaught page errors at any point

## What this found

Running it for the first time immediately surfaced a real defect that every
unit test had missed: registration failed with HTTP 500 because
`application.yml` in imani-gateway-core spelled the password fallback
`MERCHANT_IDENTITY_BOTTIN_PASS` instead of `..._PASSWORD`. The username
resolved and the password did not, and a Bottin client with one and not the
other disables itself. That is the class of bug only the real path finds.
