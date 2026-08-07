# MytView Server

**A clean, fast, read-only viewer for a self-hosted video library** — video files plus their
metadata sidecars (`.info.json`, or Kodi/Emby-style `.nfo` for TV series) — with multi-user
accounts, per-user watch state, owner-controlled per-channel privacy, public share links, and
live HLS transcoding when a client can't play a file directly.

Run it on your own hardware (NAS, home server, mini-PC) and watch in any browser — or with the
native **iPhone / iPad / Apple TV**, **Google TV**, and **Samsung TV (Tizen)** apps, which talk to
this server over its [documented API](docs/api.md).

- 🔒 **Private by design** — no cloud, no analytics, no ads. Streams go straight from your server to your device.
- 📚 **Read-only** — your library is mounted `:ro`; MytView never writes to, moves, or deletes your files.
- 👥 **Multi-user** — per-person sign-in, watch state, and resume points. Invite-based signup; the owner can reset passwords, deactivate, or remove accounts. Per-device session management with server-side revocation.
- 🔦 **Per-channel privacy** — mark channels public or private and grant private ones to specific people, from a per-user × per-channel grid.
- 📺 **Channels and series** — one server handles both creator-channel libraries (`.info.json` sidecars) and TV-series libraries (`.nfo` + `S01E02` naming), with season/episode ordering and next-episode tracking. Libraries are configured in the UI, not env vars.
- 🎞️ **Direct-play first, live HLS fallback** — every client tries the original file first; when it can't decode it, the server live-transcodes an ephemeral HLS stream that starts in seconds (VAAPI hardware encode when available, CPU fallback). Nothing is pre-transcoded or stored long-term.
- 🔗 **Share links** — per-video public links with expiry and view caps, link-preview cards, and the same live-HLS fallback for recipients.

Website: **https://mytview.com** · Privacy: **https://link.mytview.com/privacy**

---

## Quick start (Docker)

```yaml
# docker-compose.yml
services:
  mytview:
    image: fbartolini/mytview:latest
    container_name: mytview
    restart: unless-stopped
    ports:
      - "8700:8700"
    environment:
      ALLOW_SIGNUP: invite            # first account becomes the owner
      # ORIGIN: https://mytview.example.com     # only behind a reverse proxy / TLS
      # ADDRESS_HEADER: x-forwarded-for         # only behind a reverse proxy / CDN
    volumes:
      - /path/to/your/library:/media:ro   # your video library — READ-ONLY
      - mytview-data:/data                # accounts + watch state + index (back this up)
      - /path/to/scratch:/transcodes      # writable scratch for live-HLS segments
volumes:
  mytview-data:
```

```bash
docker compose up -d
```

Open **http://your-host:8700** and **sign up** — the first account bootstraps the owner. After
that, signup requires a single-use invite (from `/invite`) unless `ALLOW_SIGNUP=all`.

## Configuration

### Volumes
| Container path | Purpose | Notes |
| --- | --- | --- |
| `/media` | Your video library | Mount **read-only** (`:ro`). MytView never modifies it. |
| `/data` | Accounts, sessions, watch state + the search index | **Durable — back this up.** The index rebuilds from disk; your users/progress do not. |
| `/transcodes` | Scratch space for live-HLS segments | Segments exist only while someone is watching and are cleaned up after. Keep it outside your library. |

### Environment
| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_SIGNUP` | `invite` | `invite` (first account = owner, then invite-only), `all`, or `off`. |
| `ALLOW_INVITES` | `owner` | Who may create invite links: `owner` or `all`. |
| `ORIGIN` | — | Your external URL — set **only** behind a reverse proxy / TLS. |
| `ADDRESS_HEADER` | — | Behind a proxy/CDN, the header carrying the real client IP (e.g. `x-forwarded-for`), so login rate limits see clients rather than the proxy. |
| `TRANSCODE_HWACCEL` | `0` | `1` = Intel VAAPI hardware encode for live HLS (needs `/dev/dri` passthrough; amd64). Falls back to CPU automatically. |
| `HLS_DIR` | `/transcodes/hls` | Where live-HLS session segments are written. `off` disables live transcoding (direct-play only). |
| `SCAN_INTERVAL` | `5` | Auto-rescan interval in minutes (`0` disables). Incremental and cheap. |

Baked into the image (override only if you must): `PORT=8700`, `HOST=0.0.0.0`,
`MEDIA_ROOT=/media`, `DB_PATH=/data/index.db`, `TRANSCODE_DIR=/transcodes`.

### Hardware transcoding (amd64 + Intel iGPU)
```yaml
    environment:
      TRANSCODE_HWACCEL: "1"
    devices:
      - /dev/dri:/dev/dri
```

## Library layout

Two library formats, configured by the owner in the UI (**Libraries** in the avatar menu) —
any subfolder of `/media` can be its own library:

- **Channels** — `Channel Name/…/Video Title.mp4` + a sibling `Video Title.info.json`
  (title, date, description, tags, thumbnail…). Channels are keyed by their top-level folder.
- **Series** — `Show Name/Season 1/Show - S01E02 - Title.mkv` with Kodi/Emby `.nfo` sidecars
  and local artwork (`poster.jpg`, `fanart.jpg`, `-thumb.jpg`), the layout media managers write.
  Falls back to `SxxExx` filename parsing when no `.nfo` exists.

With no libraries configured, the whole of `/media` is treated as one public channels library.

## Clients & API

The web UI ships with the server. The native apps (iPhone/iPad/Apple TV, Google TV,
Samsung TV) are separate, closed-source products by the same author — the Samsung app is free.

Third-party clients are welcome: the full client contract — auth and device pairing, the
video/playback descriptors, watch-state rules, and the capabilities negotiation — is documented
in [`docs/api.md`](docs/api.md). `GET /api/v1/status` advertises `serverVersion` and a
`capabilities` list to feature-gate against.

## Development

```bash
npm install
cp .env.example .env    # set MEDIA_ROOT to a local path
npm run dev             # Vite dev server
npm run check           # svelte-check — must stay clean
npm test                # vitest suite
npm run build && node build   # production build (adapter-node)
```

Runtime dependencies are deliberately minimal: SvelteKit + `better-sqlite3` (+ `hls.js` on the
web player). Transcoding shells out to `ffmpeg`/`ffprobe` (bundled in the Docker image). Two
SQLite databases live in `/data`: `index.db` (disposable cache, rebuilt by scanning) and
`state.db` (durable: users, sessions, watch state — the only thing worth backing up).

## License

GPL-3.0 — see [LICENSE](LICENSE). Contributions are welcome under the terms in
[CONTRIBUTING.md](CONTRIBUTING.md).
