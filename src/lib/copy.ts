/**
 * Copy text to the clipboard in BOTH secure and insecure contexts. The async Clipboard API exists
 * only on HTTPS/localhost — but this app is routinely reached over plain-HTTP LAN by IP, where
 * Chromium hides `navigator.clipboard` entirely (a copy button that "does nothing"). So: try the
 * real API, then fall back to the deprecated-but-working execCommand('copy') textarea trick.
 * Returns whether anything actually copied — callers show a last-resort prompt() when false.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* secure-context API refused → try the legacy path */
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.top = '-1000px';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
