/**
 * How to get a local file in, spelled exactly once.
 *
 * This string has been wrong twice, and both times an agent improvised something
 * worse rather than give up:
 *
 *   1. It once suggested "re-encode the image to <=100KB and base64 it", so
 *      agents DEGRADED the user's photo (JPEG q70, 1024px) to fit a
 *      token-by-token channel.
 *   2. It then said `curl -H "Authorization: Bearer $UNIFICALLY_API_KEY" ...` —
 *      but that variable is not in the agent's shell. The key lives in the MCP
 *      client's config and never reaches it, so the curl 401s. Told to upload and
 *      unable to, one agent shipped a user's private photo to tmpfiles.org, an
 *      anonymous third-party host, because that endpoint needed no auth.
 *
 * The lesson both times: an instruction an agent CANNOT follow doesn't produce a
 * refusal, it produces improvisation. So this now points at a flow that needs
 * nothing the agent doesn't already have — upload_file mints a signed, one-time
 * URL (spending the MCP's key server-side) and the agent PUTs the raw bytes to it
 * with no credential at all.
 */
export const DIRECT_UPLOAD_HINT =
  "Call upload_file with the file's MIME type (e.g. { content_type: \"image/png\" }) to get a one-time upload_url, " +
  "then send the file with: curl -X PUT '<upload_url>' --data-binary @<path> — no api key needed, full quality, CDN upload limits apply, " +
  "zero tokens. The response's file_url is what you pass to the generation tool. " +
  "NEVER upload the user's file to any other host — that leaks their private file to a third party.";
