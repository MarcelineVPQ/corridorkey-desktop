// A path as the app shows it (UI pass 2026-10-25, Marcy): the home folder as ~, and a long middle cut to "…" so the
// start (where it is) and the end (the file or folder itself) stay readable. The full path is always one hover or
// one Copy away (PathText.tsx). Pure, unit-tested (tests/unit/paths.test.ts).

/** `path` with `home` as ~ and, past `max` characters, its middle folders as "…" (Linux, macOS and Windows paths). */
export function shortenPath(path: string, home: string, max = 56): string {
  // a Windows path uses \ (and compares without case); everything else /
  const win = /^[A-Za-z]:\\/.test(path) || (path.includes("\\") && !path.includes("/"));
  const sep = win ? "\\" : "/";
  const fold = (s: string) => (win ? s.toLowerCase() : s);
  const h = home.replace(/[\\/]+$/, "");
  let p = path;
  if (h && (fold(p) === fold(h) || fold(p).startsWith(fold(h) + sep))) p = `~${p.slice(h.length)}`;
  if (p.length <= max) return p;
  const parts = p.split(sep);
  const head = parts[0]; // "~", "C:", or "" for a path from the root
  const tail: string[] = [];
  // loop: NOT-WORTH — a path's folders, per path shown (a few per render)
  for (let i = parts.length - 1; i > 0; i--) {
    const next = [parts[i], ...tail].join(sep);
    if (`${head}${sep}…${sep}${next}`.length > max) break;
    tail.unshift(parts[i]);
  }
  if (tail.length === parts.length - 1) return p;
  if (tail.length) return `${head}${sep}…${sep}${tail.join(sep)}`;
  // the last name alone is too long: keep its start and its end (the extension)
  const last = parts[parts.length - 1];
  const keep = Math.max(4, Math.floor((max - head.length - 4) / 2));
  return `${head}${sep}…${sep}${last.slice(0, keep)}…${last.slice(-keep)}`;
}
