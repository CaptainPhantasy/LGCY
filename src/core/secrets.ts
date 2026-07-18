/**
 * Shared secret-shape detection and redaction primitives. Single source of
 * truth used by the gateway relay (error-body redaction), the session store
 * (persistence-boundary scrubbing), and the settings store (credential
 * warnings). Lives in core so every layer can import it without crossing
 * architecture boundaries.
 */

/**
 * Key names that ALWAYS hold credentials — the value is redacted regardless
 * of its shape (a password of "x" is still a password).
 */
export const ALWAYS_SECRET_KEY_RE =
  /^(password|passwd|authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|cookie|set-cookie|session[_-]?token|auth[_-]?token|signing[_-]?key|secret[_-]?key)$/i;

/**
 * Generic key names that are redacted ONLY when the value also looks
 * credential-like. A field named `{ key: "ctrl-c" }` is a keyboard shortcut,
 * not a secret; `{ key: "sk-..." }` is.
 */
export const GENERIC_SECRET_KEY_RE = /^(key|token|secret|credentials?|pwd)$/i;

/** JWT: three base64url segments; the header segment always starts "eyJ". */
const JWT_RE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;

/** Well-known provider key prefixes (OpenAI, Anthropic, Slack, GitHub, Google…). */
const PREFIXED_KEY_RE =
  /^(sk|pk|rk|ak|xox[baprs]?|gh[pousr]|github_pat|AIza|ya29|glpat|npm)[-_][A-Za-z0-9_-]{6,}$/i;

/** Long opaque token: ≥32 chars of hex/base64url with no spaces or word chars. */
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,}$/;

/** Heuristic: does this string value look like a credential? */
export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 8) return false;
  return JWT_RE.test(v) || PREFIXED_KEY_RE.test(v) || OPAQUE_TOKEN_RE.test(v);
}

/**
 * Scrub credential-shaped substrings from free text. Bearer tokens are
 * matched after any whitespace class (space, tab, newline) — a header dump
 * like "Authorization:\nBearer abc" is still redacted.
 */
export function scrubString(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]");
}

/**
 * Deep-scrub arbitrary data before persistence. Objects keyed by known
 * credential names are always redacted; generically-named keys are redacted
 * only when the value is credential-shaped; free strings are pattern-scrubbed.
 * Buffers/typed arrays/Dates are stringified; circular references collapse to
 * a marker instead of recursing forever.
 */
export function scrubSecrets(data: unknown): unknown {
  return scrubValue(data, new WeakSet());
}

function scrubValue(data: unknown, seen: WeakSet<object>): unknown {
  if (typeof data === "string") return scrubString(data);
  if (typeof data !== "object" || data === null) return data;
  if (seen.has(data)) return "[circular]";
  seen.add(data);
  if (data instanceof Date) return data.toISOString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return `[buffer ${data.byteLength} bytes]`;
  }
  if (ArrayBuffer.isView(data)) return `[${data.constructor.name} ${data.byteLength} bytes]`;
  if (data instanceof ArrayBuffer) return `[ArrayBuffer ${data.byteLength} bytes]`;
  if (Array.isArray(data)) return data.map((v) => scrubValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (ALWAYS_SECRET_KEY_RE.test(k)) out[k] = "[redacted]";
    else if (GENERIC_SECRET_KEY_RE.test(k) && looksLikeSecret(v)) out[k] = "[redacted]";
    else out[k] = scrubValue(v, seen);
  }
  return out;
}
