// Destination resolution for the `navigate` step.
//
// A TakePlan is static JSON authored BEFORE the capture runs, which is why a
// demo that spans two pages used to be two takes: the second page's URL often
// does not exist yet when the plan is written (a deploy's generated domain, a
// created record's permalink, a share link). So a navigate destination is
// LATE-BOUND — the plan says *where to read it from*, and this resolves it
// against what the page actually shows at that moment.
//
// Pure on purpose: the browser supplies `current`/`href` as strings, so every
// precedence and merge rule below is unit-testable without launching Chrome.

export type NavigateTarget = {
  /** the page's URL right now — the base for a relative `url`, and the
   *  destination itself when the step only carries `query` */
  current: string;
  /** explicit destination from the plan; absolute, or relative to `current` */
  url?: string;
  /** destination read off the page at capture time (already absolute) */
  href?: string | null;
  /** params merged onto whichever destination won. The reason this exists
   *  separately from `url`: the page links to the bare thing, but the demo
   *  needs it parameterised (`?speed=3` to compress a long animation into the
   *  shot). Clicking the link could never produce that. */
  query?: Record<string, string>;
};

/**
 * Resolve a navigate step to one absolute URL, or null when it cannot be.
 *
 * Precedence is `href` > `url` > `current`: a destination READ FROM THE PAGE
 * beats one written in the plan, because it is the one that reflects what the
 * app just did. `current` last means `{ query }` on its own is "reload this
 * same page with these params" rather than an error.
 */
export function resolveNavigateUrl(t: NavigateTarget): string | null {
  const base = safeUrl(t.current);
  const raw = t.href || t.url || t.current;
  if (!raw) return null;
  // A relative `url` ("/pricing") needs the current page as its base; an
  // absolute one ignores the base. `href` is already absolute (the DOM
  // resolves it), so this is a no-op for that path.
  const dest = safeUrl(raw, base);
  if (!dest) return null;
  for (const [k, v] of Object.entries(t.query ?? {})) dest.searchParams.set(k, v);
  return dest.toString();
}

function safeUrl(raw: string, base?: URL): URL | undefined {
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
}
