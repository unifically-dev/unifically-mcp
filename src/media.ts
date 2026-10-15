import { getConfig } from "./config.js";
import { DIRECT_UPLOAD_HINT } from "./uploadHint.js";
import { assertSafeRemoteUrl } from "./urlSafety.js";

/**
 * Validate a caller-supplied media reference. The generation models accept
 * only public URLs, so anything else — a local file path, raw base64, a
 * `data:` URI — fails fast here with an error that tells the caller exactly
 * what to do (upload_file first, then pass the CDN URL). Failing early keeps
 * the fix obvious to an agent instead of surfacing later as a confusing
 * upstream 400.
 */
export function resolveMediaRef(value: string): string {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    // Validate + SSRF-screen (scheme, credentials, private/loopback/link-local
    // IPs). Returns the original string byte-for-byte so signed URLs survive.
    return assertSafeRemoteUrl(v, "Media URL");
  }

  // "example.com/a.jpg" / "www.site.com/a.jpg" — a URL missing its scheme,
  // not a file path; telling the caller to upload_file would dead-end them.
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+[/?#]/i.test(v)) {
    throw new Error(
      `"${truncate(v)}" looks like a URL missing its scheme. Pass the full form: https://${v}`,
    );
  }

  if (/^data:/i.test(v) || looksLikeBase64(v)) {
    throw new Error(
      "Inline base64 / data: URIs are not accepted. Upload the real file and pass its URL instead: " +
        `${DIRECT_UPLOAD_HINT} Then pass the returned file_url here. ` +
        "Do not re-encode or shrink the file to make it smaller — upload it at full quality.",
    );
  }
  if (looksLikePath(v)) {
    throw new Error(
      `"${truncate(v)}" is a file path, not a URL. ` +
        `Upload the file and pass the returned file_url: ${DIRECT_UPLOAD_HINT}` +
        // Only offer file_path where it can actually work. On the hosted server it
        // does not exist, and dangling it in front of an agent just sends it
        // improvising toward something worse.
        (getConfig().transport === "stdio"
          ? " This server runs on your machine, so upload_file { file_path } also works."
          : " This server is remote and cannot read files on your machine — the direct upload is the way."),
    );
  }
  throw new Error(
    `"${truncate(v)}" is not a public URL. Media inputs must be https URLs. ` +
      `For a local file: ${DIRECT_UPLOAD_HINT} Then pass the returned file_url here.`,
  );
}

/** Validate an array of media refs, preserving order. */
export function resolveMediaRefs(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return values;
  return values.map((v) => resolveMediaRef(v));
}

// A long run of base64 alphabet with no spaces is inline file data, not a URL.
/**
 * A long unbroken run of the base64 alphabet is inline file data, not a value.
 * 200+ chars keeps this off ids, seeds, and tokens.
 *
 * Exported because the named media params are not the only way in: provider_options
 * and dry_run_cost's input are passthrough bags, and raw base64 under any key
 * there sailed straight to the API until this screened it.
 */
export function looksLikeBase64(v: string): boolean {
  return v.length >= 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(v);
}

// Windows drive / UNC, absolute or relative POSIX path, home dir, file: URI,
// or a bare filename with a media extension.
function looksLikePath(v: string): boolean {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/]|file:\/\/)/i.test(v)) return true;
  if (/[\\/]/.test(v) && !/\s/.test(v)) return true;
  return /^[^\s]+\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|avi|mkv|mp3|wav|m4a|aac|ogg|flac)$/i.test(v);
}

function truncate(v: string): string {
  return v.length > 120 ? `${v.slice(0, 117)}...` : v;
}
