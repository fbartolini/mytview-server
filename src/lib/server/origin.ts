// The externally-reachable origin for a request — the address the *user* actually reached the server
// by, as opposed to adapter-node's `url.origin`. In the documented deployment ORIGIN + HOST_HEADER are
// unset, so `url.origin` collapses to the raw `Host` header (forced to https), which behind a reverse
// proxy is the container's INTERNAL name, not the public one the user typed. That mismatch is what let a
// stale base URL strand the native clients (see docs/api-client-contract.md → base-URL authority).
//
// Single source of truth for every place the server hands a client/peer an ABSOLUTE server address —
// share links, the device-pairing verification URL/QR, and the `baseUrl` handbacks older clients still
// trust. Prefer the reverse proxy's `x-forwarded-host` (+ `x-forwarded-proto`); when no proxy is in
// front (header absent) fall back to `url.origin`, which honours ORIGIN when set and the connecting
// Host otherwise — so this is never worse than the old behaviour and strictly better when proxied.
//
// Trust model: `x-forwarded-host` is client-settable only when NOT behind a proxy (a real proxy
// overwrites it); even then the sole effect of a spoofed value is a wrong URL echoed back to the same
// caller (their own share link / their own pairing QR), never a cross-user issue. This mirrors the trust
// the public-share OG-image builder has always placed in the forwarded host.
export function externalOrigin(event: { request: Request; url: URL }): string {
	const { request, url } = event;
	const fwdHost = request.headers.get('x-forwarded-host');
	if (!fwdHost) return url.origin;
	const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
	return `${proto}://${fwdHost.split(',')[0].trim()}`;
}
