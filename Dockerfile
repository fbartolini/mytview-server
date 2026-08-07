# syntax=docker/dockerfile:1

# ---- build stage: full toolchain (better-sqlite3 may compile a native addon) ----
FROM node:24-trixie AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime stage: slim image, production dependencies only ----
# Trixie (Debian 13), NOT bookworm: the bundled iHD VA driver must be recent enough to init
# the host's iGPU. bookworm ships iHD ~23.x, which fails to initialise newer/edge-kernel iGPUs
# (e.g. Alder Lake-N, which needs i915.force_probe) with an "Input/output error"; trixie ships
# iHD ~25.x — the same driver a working Plex LXC uses on the same hosts. The container carries
# its own VA driver, so this is independent of whatever the PVE host has installed.
FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8700
# ffmpeg for on-demand transcoding (idle unless a client requests a transcode). VAAPI HW
# drivers for TRANSCODE_HWACCEL=1 + /dev/dri: intel-media-va-driver (iHD) is what modern
# Intel iGPUs (Gen8+) need — mesa's VAAPI is AMD-only; i965 covers legacy Intel. iHD is in
# non-free, added by appending the component to the existing deb822 source (a separate .list
# clashes with its Signed-By keyring). All idle on the default CPU (libx264) path.
# vainfo is bundled so the container's *own* VA stack can be checked directly (the LXC/host
# driver is irrelevant — the container carries its own): `docker exec mytview vainfo`
# should show `va_openDriver() returns 0` and an iHD ~25.x, else HW transcode falls back to CPU.
#
# The Intel iGPU drivers (iHD/i965) are x86-only Debian packages, so they're installed on amd64
# and skipped on other arches (arm64 has no Intel VAAPI — it uses the CPU libx264 path). This
# keeps the image buildable as a multi-arch manifest (amd64 + arm64) without failing apt on ARM.
# TARGETARCH is set automatically by buildx per platform.
ARG TARGETARCH
RUN sed -i '/^Components:/ s/$/ non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg vainfo mesa-va-drivers \
 && if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; \
    fi \
 && rm -rf /var/lib/apt/lists/*
# Container path conventions (baked in so compose needn't repeat them; override via env if
# you must). /media = read-only media library (bind-mounted); /data = writable home for
# the disposable SQLite index; /transcodes = transcode output (bind a dir on your bulk array).
ENV MEDIA_ROOT=/media
ENV DB_PATH=/data/index.db
ENV TRANSCODE_DIR=/transcodes
RUN mkdir -p /media /data /transcodes

# adapter-node output + the pruned (prod-only) node_modules, incl. better-sqlite3.
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8700
CMD ["node", "build"]
