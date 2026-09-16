/**
 * Input hardening for untrusted data.
 *
 * Scope note, because the previous version of this file promised something it
 * could not deliver: it exported a regex-based `sanitizeHTML` tag whitelist.
 * Regex HTML sanitizers are bypassable as a class (nested/broken tags, entity
 * and unicode escapes, attribute splitting), so shipping one buys a false
 * sense of safety rather than safety. It is gone. This app renders NO untrusted
 * HTML — there is not a single `dangerouslySetInnerHTML` in the live tree and
 * React escapes text by default — so what it actually needs is the other half:
 *
 *   - `safeParseJSON`  — localStorage is attacker-writable (any script on the
 *                        origin, any devtools paste, any half-written value
 *                        from a crashed tab). `JSON.parse` on it throws, and
 *                        an uncaught throw during rehydration takes the whole
 *                        app to the ErrorBoundary — permanently, because the
 *                        bad value stays on disk and the next load repeats it.
 *   - `sanitizeText` / `sanitizeObject` — strip control characters and cap
 *                        length on strings that arrive from storage or an API
 *                        and end up in the UI or back in storage.
 *   - `sanitizeURL`    — reject `javascript:` / `data:` before anything is put
 *                        in an href/src.
 *   - `escapeHTML`     — ENCODE (sound) rather than filter (unsound), for the
 *                        rare case a string must be embedded in markup.
 */

/** Strings longer than this are truncated — a storage value is not a document. */
const MAX_STRING_LENGTH = 10_000;
/** Depth guard against a hand-crafted deeply nested object. */
const MAX_OBJECT_DEPTH = 12;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

class ContentSanitizer {
  /** Encodes the five characters that change meaning inside markup. Encoding
   *  cannot be bypassed the way a tag whitelist can. */
  escapeHTML(content: string): string {
    if (typeof content !== 'string' || !content) return '';
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Removes tags and entities to leave readable plain text. For DISPLAY of
   *  text that may contain markup — never to make markup "safe". */
  stripAllHTML(content: string): string {
    if (typeof content !== 'string' || !content) return '';
    return content
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-zA-Z0-9#]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_STRING_LENGTH);
  }

  /** Normalizes a string arriving from storage or an API: no control
   *  characters, no runaway length, trimmed. */
  sanitizeText(text: unknown): string {
    if (typeof text !== 'string' || !text) return '';
    return text.replace(CONTROL_CHARS, '').trim().slice(0, MAX_STRING_LENGTH);
  }

  /** A trading symbol, as used in storage keys, URLs and API calls. */
  sanitizeSymbol(symbol: unknown): string {
    if (typeof symbol !== 'string') return '';
    return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  }

  /** A finite number, or the fallback. Guards against `NaN`/`Infinity`/`null`
   *  reaching arithmetic from a rehydrated object. */
  sanitizeNumber(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  sanitizeClassName(className: unknown): string {
    if (typeof className !== 'string' || !className) return '';
    return className.replace(/[^a-zA-Z0-9\-_\s:/[\].]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Returns '' for anything that is not an http(s) or same-origin relative
   *  URL — so a `javascript:` or `data:` value can never reach an href/src. */
  sanitizeURL(url: unknown): string {
    if (typeof url !== 'string' || !url) return '';
    const trimmed = url.trim();
    if (/^(javascript|data|vbscript|file|blob|mhtml):/i.test(trimmed)) return '';
    if (!/^(https?:\/\/|\/|\.\/|#)/.test(trimmed)) return '';
    return trimmed.slice(0, 2048);
  }

  /** Deep-cleans a parsed structure: strings sanitized, non-finite numbers
   *  dropped to 0, prototype-polluting keys removed, depth capped. */
  sanitizeObject<T = unknown>(obj: unknown, depth = 0): T {
    if (depth > MAX_OBJECT_DEPTH) return null as T;
    if (obj === null || obj === undefined) return obj as T;

    if (typeof obj === 'string') return this.sanitizeText(obj) as T;
    if (typeof obj === 'number') return (Number.isFinite(obj) ? obj : 0) as T;
    if (typeof obj === 'boolean') return obj as T;
    if (Array.isArray(obj)) return obj.map(item => this.sanitizeObject(item, depth + 1)) as T;

    if (typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        // __proto__ / constructor / prototype in a parsed payload is never
        // legitimate data — it is a prototype-pollution attempt.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const safeKey = this.sanitizeText(key);
        if (safeKey) out[safeKey] = this.sanitizeObject(value, depth + 1);
      }
      return out as T;
    }

    return undefined as T;
  }

  /** Whitelisted inline styles, for the rare computed-style case. */
  createSafeStyles(styleConfig: Record<string, unknown>): React.CSSProperties {
    const safeStyles: React.CSSProperties = {};
    if (!styleConfig || typeof styleConfig !== 'object') return safeStyles;

    const allowedProperties = [
      'color', 'backgroundColor', 'fontSize', 'fontWeight', 'textAlign',
      'padding', 'margin', 'border', 'borderRadius', 'width', 'height',
      'display', 'position', 'top', 'left', 'right', 'bottom',
      'transform', 'opacity', 'zIndex'
    ];

    for (const property of Object.keys(styleConfig)) {
      if (!allowedProperties.includes(property)) continue;
      const value = styleConfig[property];
      if (typeof value === 'number') {
        (safeStyles as Record<string, string | number>)[property] = value;
      } else if (typeof value === 'string' && this.isValidCSSValue(value)) {
        (safeStyles as Record<string, string | number>)[property] = value;
      }
    }
    return safeStyles;
  }

  private isValidCSSValue(value: string): boolean {
    const dangerousPatterns = [
      /javascript:/i, /expression\s*\(/i, /url\s*\(/i, /@import/i, /<.*>/, /&[a-zA-Z]+;/
    ];
    return !dangerousPatterns.some(pattern => pattern.test(value));
  }
}

export const contentSanitizer = new ContentSanitizer();

export interface SafeParseResult<T> {
  ok: boolean;
  value: T;
  /** Set when the stored value was missing, malformed or rejected by `guard`. */
  reason?: string;
}

/**
 * Parses untrusted JSON (localStorage, sessionStorage, a query param) and
 * NEVER throws — the caller always gets a usable value.
 *
 * `guard` runs on the sanitized structure: return false and the fallback is
 * used, so a syntactically valid but structurally wrong payload (an array
 * where an object belongs, a missing `items`) is caught here rather than three
 * frames deeper inside a render.
 */
export function safeParseJSON<T>(
  raw: string | null | undefined,
  fallback: T,
  guard?: (value: unknown) => boolean
): SafeParseResult<T> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, value: fallback, reason: 'empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, value: fallback, reason: 'malformed-json' };
  }

  const sanitized = contentSanitizer.sanitizeObject(parsed);
  if (guard && !guard(sanitized)) {
    return { ok: false, value: fallback, reason: 'failed-guard' };
  }

  return { ok: true, value: sanitized as T };
}

/** Reads and parses a localStorage key without throwing, even when storage
 *  itself is unavailable (private mode, blocked site data). */
export function readStoredJSON<T>(
  key: string,
  fallback: T,
  guard?: (value: unknown) => boolean
): SafeParseResult<T> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { ok: false, value: fallback, reason: 'storage-unavailable' };
  }
  return safeParseJSON(raw, fallback, guard);
}

/** Writes JSON to localStorage without throwing (quota, private mode). */
export function writeStoredJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`[sanitizer] failed to persist "${key}":`, error);
    return false;
  }
}

export const escapeHTML = (content: string) => contentSanitizer.escapeHTML(content);
export const sanitizeText = (text: unknown) => contentSanitizer.sanitizeText(text);
export const sanitizeURL = (url: unknown) => contentSanitizer.sanitizeURL(url);
export const sanitizeSymbol = (symbol: unknown) => contentSanitizer.sanitizeSymbol(symbol);
export const sanitizeNumber = (value: unknown, fallback = 0) => contentSanitizer.sanitizeNumber(value, fallback);
