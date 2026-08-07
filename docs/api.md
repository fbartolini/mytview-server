# `/api/v1` client contract

The spec a native client (**Google TV / Kotlin**, **Tizen / JS**, iOS/tvOS / Swift) mirrors. There is no
shared binary across languages, so THIS is the shared layer. Two parts:

1. **The HTTP contract** — endpoints + wire shapes.
2. **Client responsibilities** — the behavior each client re-implements identically (what `MytViewKit`'s
   stores do). Getting these right is what stops cross-platform drift.

> **Golden rule: the server decides, the client renders.** Never re-derive a decision the server already
> made — `watchedAt`, `resumePosition`, `isVertical`, `directPlay`, feed order, related order, visibility,
> `prefs`. The one deliberate exception is **playability**: the server is *fail-open* and hands you a
> signed original `url` you always try first; `playback.kind` is only an informational **hint** (badge /
> analytics), never a gate — you fall back to live HLS (`hlsUrl`) only on a real decode error, exactly
> like the web `<video>`. Branching on codec fields (`vcodec`/`acodec`) for playback is explicitly
> forbidden (they may not match the muxed file).

---

## Conventions

- **Base URL** is whatever server the user points the app at (persist it). All paths below are relative to it.
- **Auth:** `Authorization: Bearer <token>` on every request except the login-exempt auth endpoints
  (`/api/v1/auth/login`, `/api/v1/auth/device/start`, `/api/v1/auth/device/poll`). The web uses a session
  cookie; same token type. Also send **`X-Client-Name: <device name>`** (e.g. "Living Room Apple TV") on
  every request — the server records it as the session's **label** when a session is created (device
  pairing / login) so it's nameable in the manage-devices list; absent it, the server derives a label from
  the `User-Agent`.
- **401 means the session is gone.** Any **authenticated** request that returns `401` (token revoked from
  another device, or expired) must **drop the client back to login / pairing** and clear the stored token —
  don't retry, don't show stale screens. This is NOT triggered by the login/pairing calls themselves (they
  run unauthenticated), so a wrong password never masquerades as a revoked session. (`MytViewKit`:
  `APIClient.onUnauthorized` → `Session.sessionInvalidated()`; web: `hooks.server.ts` bounces to `/login`.)
- **JSON key casing is MIXED** — this is the #1 gotcha for a fresh client. Fields sourced from the library
  rows are **snake_case** (`channel_id`, `thumb_path`, `view_count`, `upload_date`, `like_count`,
  `webpage_url`, `follower_count`, `video_count`, `yt_channel_id`); server-computed annotations are
  **camelCase** (`directPlay`, `isVertical`, `playback`, `watchedAt`, `resumePosition`, `canTranscode`,
  `compatUrl`, `mimeType`, `nextOffset`, `baseUrl`, `isHidden`, `autoplayNext`, `stillWatchingAfter`,
  `everScanned`, `isOwner`, `canInvite`, `createdAt`, `lastSeen`). Map keys exactly as listed per endpoint —
  don't assume one style.
- **Signed URLs:** `thumb` / `poster` / `fanart` / `playback.url` come back as **ready-to-use signed
  relative URLs** (`/thumb/ID?k=…&exp=…`). Resolve against the base URL and fetch directly — **no auth
  header needed** on those. Do NOT construct or sign them client-side. For images, append `&w=<pixels>` to
  get a downscaled JPEG (server resizes + caches). `playback.url` supports HTTP Range / 206.
- **Errors:** `401` unauthenticated, `404` for a video/channel this user can't see (visibility is enforced
  server-side — the client inherits access control for free), `4xx/5xx` otherwise.

---

## Auth & pairing

### Base-URL authority — **the client keeps the address it reached the server by; it never adopts the server's self-report** {#base-url-authority}
Several responses below carry an optional `baseUrl` (and `device/start` a `verification_url`). Those are the
server's **`url.origin`**, which behind a reverse proxy is the container's *internal* name, not the public
host the user typed — and `ORIGIN` env drift (e.g. a Dockhand "redeploy" that reuses the container and never
reloads env) makes it stale silently. **A client must therefore treat the address it already knows as
authoritative and IGNORE the server-reported `baseUrl`:**
- **Direct login / device-code pairing:** store the **URL the user typed**, not `resp.baseUrl` / `poll.baseUrl`.
  (iOS `Session.login` → `apply(baseURL: server)`; Android `PairingScreen` → `adopt(serverUrl ?: …)`;
  tvOS `TVManualLogin` → `adopt(baseURL: server)`; Tizen → `adopt(server, …)`.)
- **Broker pairing:** the **phone seals its OWN `session.baseURLString`** into the payload (iOS
  `LinkTVView`), *not* the `baseUrl` from `device-token`. The TV then adopts the sealed value verbatim —
  which is correct, because it's the address a peer genuinely reaches the server by. `device-token.baseUrl`
  must not be sealed (it's `url.origin`).

The **server** still emits `baseUrl`/`verification_url` for already-shipped clients, but builds them with the
proxy-aware external origin (`$lib/server/origin.ts` `externalOrigin()` — prefers `x-forwarded-host`/`-proto`,
falls back to `url.origin`), so an old client and every server-rooted link (**share links**, the pairing QR)
resolve to the externally reachable host. New clients don't depend on it. This closes the whole `url.origin`
drift class — see `DESIGN.md` and the platform matrix `base-url-authority` row.

### Direct login (web + handhelds; **TV clients skip this** — typing on a remote is bad UX)
`POST /api/v1/auth/login` · login-exempt · body `{ username, password }`
→ `{ token, user: { id, username }, baseUrl? }`

### Device-code pairing (**the TV path** — the whole flow all TV clients use)
1. `POST /api/v1/auth/device/start` · login-exempt → (**snake_case response**)
   `{ device_code, user_code, verification_url, verification_url_complete, interval, expires_in }`
2. Show the user `user_code` and a QR of `verification_url_complete`. They open `verification_url` (`/link`)
   in a browser, sign in, and enter `user_code`.
3. `POST /api/v1/auth/device/poll` · login-exempt · body `{ device_code }` (**snake_case**) →
   `{ status, token?, user?, baseUrl? }` where `status` ∈ `pending | approved | expired`. `pending`/`approved`
   come back `200`; `expired` comes back **HTTP 410** (still a JSON body). Poll every `interval` seconds
   until `approved` (store `token` + `baseUrl`, then send `X-Client-Name` on all subsequent calls) or
   `expired` (restart the flow).

### Broker pairing (**zero-config scan-to-pair** — the primary TV path on tvOS / Android TV / Tizen)
The TV shows a QR the phone scans; the signed-in phone hands over `{baseUrl, token}` so the TV needs **no
server address typed and no code entered**. A tiny Cloudflare Worker (`link.mytview.com`, `pair-broker/`) is a
**blind rendezvous** — it only ever relays ciphertext and holds it ≤5 min, single-use. It is NOT the
self-hosted server and never sees media.

1. TV → `POST https://link.mytview.com/pair/new` → `{ pairingId, pollToken, expiresIn }` (camelCase).
2. TV renders a QR of `https://link.mytview.com/pair?i=<pairingId>&k=<pairKeyB64url>` and polls
   `GET /pair/poll?pairingId=&pollToken=` → `{ status, payload? }`, `status` ∈ `pending | claimed | expired`.
3. Phone scans, parses `i`+`k`, mints an independent token (`POST /api/v1/auth/device-token`), **seals**
   `{baseUrl, token}` to `k`, and `POST /pair/claim` `{ pairingId, payload }`.
4. TV receives `payload` once, **opens** it with the key it generated, and adopts `{baseUrl, token}`.

**Pairing crypto — the shared contract every client mirrors** (Swift `PairCrypto`, Kotlin
`com.mytview.core.pair.PairCrypto`; Tizen: Web Crypto). Symmetric key in the QR, so the broker stays blind:
- **`k`** = the TV's fresh random **32-byte AES key**, base64url (no padding).
- **`payload`** = `base64url( nonce(12) ‖ ciphertext ‖ tag(16) )` — **AES-256-GCM**, 96-bit random nonce,
  128-bit tag. This is exactly CryptoKit's `AES.GCM.SealedBox.combined`; on Java/Kotlin, `Cipher("AES/GCM/
  NoPadding")` `doFinal` yields `ciphertext‖tag`, so prepend the nonce. Plaintext is the JSON `{baseUrl, token}`.
- One native primitive per platform (CryptoKit / `javax.crypto` / Web Crypto) — **no X25519, no HKDF**. The key
  rides only the QR (never the broker), so a leak needs both a photo of the screen AND broker access at once.
  Interop is pinned by a vector in `android/core/.../pair/PairCryptoTest.kt` (a CryptoKit-sealed blob the Kotlin
  code must decrypt).

The **phone scanner** exists on iOS today ("Link a TV"); it recognizes both this broker QR and a device-code
`…/link?code=…` QR. An Android phone scanner is TBD — until then, an Android TV is paired by an **iPhone**, or
via the device-code fallback below.

### Other (not needed to build a TV client)
- `POST /api/v1/auth/device-token` (authed) → `{ token, user, baseUrl? }` — mints an independent token (the phone seals this for broker pairing).
- `POST /api/v1/auth/web-code` (authed) → `{ code }` — single-use code to open the web admin signed-in (owner punch-out).
- `POST /api/v1/auth/device/approve` (authed) · body `{ user_code }` → `{ status }` (`ok|not_found|expired|already`)
  — the `/api/v1` equivalent of the web `/link` approve form. A signed-in **phone** app approves a device-code
  TV by scanning its `…/link?code=…` QR (how the iOS "Link a TV" pairs a Google TV). The **TV** client never
  calls this — it just displays the QR + polls `device/poll`.

---

## Read endpoints

### `GET /api/v1/me`
`{ id, username, isOwner, canInvite, prefs: { autoplayNext, stillWatchingAfter } }`
`prefs` may be absent on an old server — fall back to `{ autoplayNext: true, stillWatchingAfter: 3 }`.

### `PATCH /api/v1/me`  (update prefs; partial)
body `{ autoplayNext?, stillWatchingAfter? }` → `{ prefs: { … } }`. Server-owned, so the change syncs to the user's other devices.

### `GET /api/v1/status`
`{ scanning, everScanned, error, videos, channels, transcoding, serverVersion, capabilities }` — counts
are **visibility-filtered**. Use `everScanned=false || scanning` to show an "indexing" state vs "empty";
poll (~30s) to auto-refresh the feed when a background scan finishes. `transcoding` is legacy (always 0).
**`capabilities`** (added 0.4.0) is the version-negotiation surface: an additive-only string list —
currently `libraries | series | sessions | prefs | shares` (+ `hls` when live transcode is enabled).
Feature-gate on membership (absent field = pre-0.4.0 server: assume all of the above except judge `hls`
by `playback.hlsUrl != null`); never probe endpoints and guess from 404s. `serverVersion` is for
diagnostics display, not gating.

### `GET /api/v1/videos?offset=&limit=&watched=&q=&tag=`
`{ items: [VideoSummary], page: { limit, offset, nextOffset } }` — `nextOffset` null = end.
`watched=1` includes watched videos (incremental; default hides them). `q` = title search, `tag` = tag filter.
**VideoSummary:** `{ id, title, channel_id, channel_name, upload_date, timestamp, duration, view_count,
thumb_path, season_number, episode_number, watched, position, directPlay, isVertical, thumb }` (`thumb` =
signed). `season_number`/`episode_number` are null except for **series episodes** — render them as the
`fmtEpisode` label (see Client responsibilities), e.g. `S1·E2`.

### `GET /api/v1/videos/[id]`  — one round-trip for the player screen
`VideoSummary` fields **plus**: `description, like_count, width, height, fps, vcodec, acodec, tags[],
chapters: [{ start_time, end_time, title }], webpage_url`, and the server-owned:
- `isVertical` — portrait? (letterbox on a 16:9 screen)
- `playback: { kind, url, compatUrl, hlsUrl, mimeType, poster, canTranscode }` — the **fail-open** play descriptor
  (below). `url` (signed original) is **always** present; you always try it first.
- `watch: { position, watched }` — this user's state
- `watchedAt` — seconds at which to auto-mark-watched (null = only at end-of-item)
- `resumePosition` — seconds to seek to on open (null = start from the beginning; already gated server-side)

### `GET /api/v1/channels?library=`
`{ items: [Channel] }`. **Channel:** `{ id, name, kind, library_id, yt_channel_id, url, follower_count,
poster_path, fanart_path, video_count, unwatched, poster, fanart, isHidden }` (`poster`/`fanart` = signed;
`isHidden` = this user unsubscribed). **`kind`** ∈ `channel | series`. **`unwatched`** = per-user count of
not-watched items → render as an unread-style **badge**. **`library_id`** = the owning library (null = the
implicit default). Optional **`?library=<id>`** scopes the list to one library (mirrors the web nav tabs).

### `GET /api/v1/channels/[id]?watched=`
`{ channel: Channel, videos: [VideoSummary], nextEpisode: VideoSummary | null }`. A **series**
(`channel.kind === "series"`) returns **all** its episodes in season/episode order (watched ones included),
and `nextEpisode` is the server-owned "continue" pointer (first unwatched episode, or null when the show is
finished). A flat channel returns newest-first with `nextEpisode: null`.

### `GET /api/v1/libraries`
`{ items: [{ id, name, format }] }` — the libraries **this user can see media in** (`format` ∈
`channels | series`), for per-library nav/tabs. A library with no channel visible to the user, or no media
at all (regardless of watched state), is **omitted**. **Empty array** when none are configured or none are
visible → show a single "Channels" tab. Not access control — the channels within each library are
visibility-filtered by the reads above; this just hides an empty/all-private library from the nav.

### `GET /api/v1/related/[id]`
`{ items: [VideoSummary] }` — up to 12 neighbours ranked by shared tags, unwatched, visibility-filtered.
**Fallback:** when a video has too few shared-tag neighbours, the server tops the list up with **recent
unwatched videos in feed order**, so the list is never empty and autoplay-next never dead-ends. Each item
carries a signed `thumb` plus `directPlay`/`isVertical`. Drives the detail "Related" rail + autoplay-next.

### `GET /api/v1/transcode/[id]` — LEGACY STUB (whole-file tier removed 2026-08-07)
Always `{ enabled: false, status: "none" }`. The whole-file transcoder no longer exists — live HLS
(`playback.hlsUrl`) is the one transcode path. The route is kept only so shipped clients that still
probe it get the disabled shape they already handle (identical to a server that never enabled it).
**New clients must not call this.**

## Write endpoints

### `GET/POST /api/v1/watch/[id]`
GET → `{ position, watched }`. POST body `{ position?, watched? }` → merged `{ position, watched }`.
**Server rule:** when the result is `watched`, the server forces `position = 0` — so to mark watched you
send `{ watched: true }` and DON'T send `position: 0` yourself.

### `POST /api/v1/channels/[id]/hidden`
body `{ hidden: bool }` → `{ hidden }`. Per-user feed hide (not access control). Refresh Recent after.

### `POST /api/v1/channels/[id]/watched`
body `{ watched: bool }` → `{ affected, watched }`. **Bulk** mark every video/episode in this channel/series
watched (`true`) or unwatched (`false`) for this user — powers "Mark whole show watched" (e.g. a new account
clearing a series it's already seen). Sets resume position to 0. Refresh the channel + Recent + the
`unwatched` badge after. **`watched` must be an explicit boolean — a missing/mangled body is a `400`**
(2026-08-07; it used to default to `false`, which silently bulk-reset every resume point in the channel on
a client-side JSON bug).

### `POST /api/v1/transcode/[id]` — LEGACY STUB (whole-file tier removed 2026-08-07)
Always `503` (after the usual `401`/visibility-`404`). Kept only so shipped clients that still call it on
a decode failure get the same "transcoding disabled" answer they already handle, then fall over to
`playback.hlsUrl`. **New clients must not call this.**

### Session management (manage this user's logged-in devices)
All scoped to the caller's own `user_id` — you can only ever see/kill your **own** sessions.

- `GET /api/v1/auth/sessions` → `{ sessions: [{ id, label, createdAt, lastSeen, current }] }`, most-recently-
  seen first. `id` is a **non-secret hash** of the token (safe to display/revoke with; never the raw token).
  `label` is the device name (from `X-Client-Name` or the User-Agent), `lastSeen` may be null, `current:true`
  flags the session making this request.
- `DELETE /api/v1/auth/sessions` → `{ revoked: <count> }` — sign out **every other** device, keep this one.
- `DELETE /api/v1/auth/sessions/[id]` → `{ ok: true }` — revoke one session by its public `id`. The special
  id **`current`** revokes THIS request's own token — that's a real **server-side sign-out** (not just a
  local token drop), so a signed-out session can't be replayed. `404` if the `id` isn't one of yours.

> Sign-out flow: `DELETE …/sessions/current` (best-effort) **then** clear the local token. Revoking another
> device makes that device's next authenticated call return `401`, which drops it to login (see the 401
> contract in Conventions).

---

## The `playback` descriptor — **fail-open** (attempt off THIS, never off codec fields)

```jsonc
"playback": {
  "kind": "direct" | "unavailable",            // INFORMATIONAL hint only — NOT a gate (see legacy note)
  "url":  "/media/ID?k=…&exp=…",               // signed ORIGINAL — ALWAYS present; always try this first
  "compatUrl": null,                           // LEGACY — always null since 2026-08-07 (whole-file tier removed)
  "hlsUrl": "/hls/v/ID/index.m3u8?k=…&exp=…",  // signed ON-THE-FLY HLS — PRESENT FOR EVERY id when HLS is enabled (universal fail-open, decoupled from the codec gate 2026-07-28); THE fallback on a decode error
  "mimeType": "video/mp4",
  "poster":   "/thumb/ID?k=…&exp=…",
  "canTranscode": false                        // LEGACY — always false since 2026-07-08 (no on-demand whole-file bakes)
}
```

The server no longer decides *whether* you can play a file — it hands you the original and lets your
decoder try. Capable TV decoders (ExoPlayer/AVPlay handle VP9/AV1/Opus; AVPlayer often plays a file whose
codec fields don't match the muxed reality) **direct-play the residue** instead of wastefully transcoding.

**`kind`** is a hint for a badge or analytics only: `direct` = expected to direct-play; `unavailable` =
not everything decodes it natively (HLS covers it at play time). Treat an unknown `kind` as `unavailable`.
**Do not gate playback on it.** (`transcoded`/`pending` were the removed whole-file tier's values — a
shipped client may still map them, a new client will never see them.)

**Player algorithm (every client implements this identically):**

1. **Attempt `url`** (the signed original). If it plays, you're done — even when `kind != "direct"`.
2. On a **real decode / media error** (not a network blip you'd retry):
   - if `hlsUrl != null`, **switch to `hlsUrl`** — an **on-the-fly HLS** stream that starts in ~a second and
     seeks anywhere (native HLS on Apple/Android/Tizen; `hls.js` on web). Segments are ephemeral
     (server-side). This is the ONLY fallback tier.
   - else surface a fail-soft "can't play" badge. (`compatUrl`/`canTranscode` are pinned null/false —
     shipped clients' whole-file branches are simply dead code now.)
3. Never pre-empt step 1 by inspecting `vcodec`/`acodec` or `kind`. The decision belongs at the player, on
   the real error — mirroring the web `<video>` fallback and the CLAUDE.md "codec fields are informational"
   rule.

---

## Client responsibilities (mirror these — this is where clients drift)

- **Session:** persist base URL + token in secure storage (Keychain / Keystore / equivalent); attach the
  bearer + `X-Client-Name` to every request. On any **authenticated** `401`, clear the token and return to
  login/pairing (don't retry). Sign-out = `DELETE /api/v1/auth/sessions/current` then clear locally.
- **Playback (fail-open):** always try `playback.url` first; fall back to live HLS (`hlsUrl`)
  **only on a real decode error** (see the algorithm above). Never gate on `kind` or codec fields.
- **Watch reporting:** throttle position writes to **one canonical 15s** while playing + flush on pause/exit.
  Auto-mark-watched when playback reaches **`watchedAt`** (don't invent a threshold; null = mark at
  end-of-item). To mark watched, POST `{ watched: true }` — the server clears the resume point and you must
  NOT also send `position: 0`.
- **Resume:** on open, seek to **`resumePosition`** if non-null (it's already gated for watched / too-near-
  start / too-near-end). Add **no** local gates.
- **Feed:** paginate with `offset`/`limit`/`nextOffset`. Default hides watched; a "Show watched" toggle passes
  `watched=1` (incremental — watched are **added** to the unwatched, not shown alone). Live-hide a card when
  it's marked watched (default view only). Reload Recent after a subscribe/unsubscribe.
- **Series & libraries:** `GET /api/v1/libraries` drives per-library **nav tabs** (one per library; fall back
  to a single "Channels" tab when the list is empty); `?library=<id>` scopes `GET /api/v1/channels`. A
  **series** channel (`kind === "series"`) renders its detail as episodes in season/episode order (the server
  pre-sorts) with the **S·E label** on each cell and in the Related rail, and uses `nextEpisode` for a
  "Continue"/play-next affordance. Render the per-channel **`unwatched`** count as an unread-style **badge** on
  channel/series cards. "Mark whole show watched/unwatched" → `POST /api/v1/channels/[id]/watched`.
  - **`fmtEpisode(season, episode)` — pinned format, mirror EXACTLY** (web canonical `server/src/lib/format.ts`):
    both present → `S{season}·E{episode}` (e.g. `S1·E2`; the separator is a middle dot `·`, U+00B7); episode
    only → `E{episode}`; season only → `S{season}`; neither → nothing (not a series episode). No per-client variants.
- **Prefs:** read `prefs` from `GET /api/v1/me` (fall back to `{ autoplayNext: true, stillWatchingAfter: 3 }`
  on an old server); write via `PATCH /api/v1/me`. Prefs are server-owned, so re-pull them when the
  authenticated UI appears — the value syncs across the user's devices; don't hard-code per-device literals.
- **Autoplay + still-watching:** if `prefs.autoplayNext`, on end advance to the first unwatched item from
  `/related` (never empty — it top-ups with recent unwatched). Resolve that next item **before** deciding
  what to show: with nothing to play, just exit. Then show the **up-next card** — it shows the next video's
  **thumbnail, title and channel** (the poster is more useful on a 10-foot screen, not less — the title
  alone is thin when you're deciding whether to let it roll) and counts down **8s** (`UP_NEXT_SECS`, canonical across every client).
  **TV card structure (pinned — same on tvOS/Google TV/Tizen, don't let it drift):** the countdown lives in
  the HEADER (*"Up next in Ns"* / *"Are you still watching?"*), and below the thumbnail is a **two-button row —
  primary (Play now / Continue) + Stop** — with the primary focused by default, D-pad Left/Right between them,
  and OK activating the focused one. System Back also stops. (Do NOT use a text-only "Back to stop" hint — it
  reads as a button but can't take focus.) Web is the deliberate exception: a centered overlay + Replay (it
  ends in a page with no other end-state affordance). Count consecutive **unattended** advances (i.e. the countdown expired untouched); when the count has
  already reached `prefs.stillWatchingAfter` (0 = never), the same card asks "Are you still watching?"
  instead of counting down, and waits.
  **Reset the count on any manual interaction** — pressing OK on the card, and any transport input
  (play/pause, seek); on web, arriving at a video by manual navigation. Mind the platform trap: if your
  player reports programmatic transport calls the same way it reports the user's (ExoPlayer's
  `PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST`, fired by your own `setPlayWhenReady` and by a resume-seek),
  guard them — a self-inflicted reset zeroes the very count the advance just incremented and
  still-watching can never fire.
- **Sessions UI (optional but recommended):** a Settings "devices" screen backed by `GET/DELETE
  /api/v1/auth/sessions` so the user can name-check and revoke lost devices.
- **Search:** debounce ~280 ms; query `?q=`.
- **Dates:** pin the locale to **en-US**; don't inherit the device's. The UI is English-only, so a
  device-locale date makes the same video read "Jul 16, 2026" on one client and "16 jul 2026" on another
  (and a non-Gregorian region setting reformats it entirely). Native/TV clients render the medium form
  ("Jul 16, 2026"); the web's spec table deliberately uses ISO (`2026-07-16`) + relative ("3d ago").
  Parse `upload_date`'s `yyyyMMdd` with a **POSIX** locale — that one is fixed-format parsing, not display.
- **Images:** request `thumb`/`poster`/`fanart` at the render size via `&w=<px>`.
- **Portrait:** honor `isVertical` for card shape + player fit (letterbox on 16:9).

### Out of scope for a TV client (deliberately)
Sharing, owner-admin (channel visibility / invites — web punch-out), offline downloads, and **direct
username/password login** (TV uses device-code pairing). See `docs/feature-platform-matrix.md`.
