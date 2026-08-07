# Contributing

Thanks for wanting to improve MytView! A few ground rules keep the project healthy.

## Ground rules

- **`npm run check` must stay clean** (0 errors, 0 warnings) and **`npm test` must pass**.
  CI enforces both on every PR.
- **Runtime dependencies are deliberately minimal** (SvelteKit + `better-sqlite3` + `hls.js`).
  PRs adding runtime dependencies need a strong justification and will usually be asked to
  find a dependency-free shape first.
- **The library is read-only.** Nothing may ever create, move, rename, or delete anything
  under `MEDIA_ROOT`.
- **Server decides, clients render.** Anything that is a *decision* (playback selection,
  watch thresholds, ordering, visibility) belongs server-side in the API, not in a client.
  New API fields are additive-only; removed behavior keeps a compatible response shape.
  See [`docs/api.md`](docs/api.md).
- Schema changes must migrate an existing database in place without crashing on startup
  (additive `ALTER TABLE` guarded by column checks; indexes over migrated columns created
  after the ALTERs). There are tests for this pattern — add one for yours.

## Licensing of contributions

MytView's server is licensed under **GPL-3.0**. By submitting a contribution you agree that:

1. You have the right to submit it (your own work, or compatibly licensed), and you certify
   the [Developer Certificate of Origin](https://developercertificate.org/) — please
   sign-off your commits (`git commit -s`).
2. You additionally grant the project maintainer a perpetual, worldwide, non-exclusive,
   royalty-free license to use, modify, sublicense, and **relicense** your contribution as
   part of MytView. (This keeps future licensing decisions — e.g. moving to AGPL — possible
   without tracking down every past contributor. Your contribution always also remains
   available under GPL-3.0.)

If you're not comfortable with clause 2, open an issue to discuss before writing code.

## Development setup

```bash
npm install
cp .env.example .env   # point MEDIA_ROOT at a local folder with a few test videos
npm run dev
```

`npm test` runs the vitest suite (no media required — tests build their own fixtures).
