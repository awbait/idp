// Lightweight semver comparison of chart versions (no ranges): needed to tell
// whether the blessed version is "newer" than the order's version. The "v"
// prefix and build metadata (+...) are ignored; the pre-release suffix
// (1.2.3-rc1) IS honored per semver precedence (a release outranks its
// pre-releases). Non-numeric core parts fall back to 0.

interface Version {
  core: number[];
  pre: string; // pre-release identifiers ("rc.1"), "" for a final release
}

function parse(v: string): Version {
  const s = v.trim().replace(/^v/i, "").split("+")[0]; // drop build metadata
  const dash = s.indexOf("-");
  const coreStr = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? "" : s.slice(dash + 1);
  const core = coreStr.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { core, pre };
}

// comparePre implements semver pre-release precedence: a final release (no
// pre-release) ranks higher than any pre-release; otherwise dot-separated
// identifiers compare numerically when both numeric, numeric below alphanumeric,
// else ASCII; a shorter identifier set ranks lower when all leading ones equal.
function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1; // 1.2.3 > 1.2.3-rc1
  if (b === "") return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// compareSemver: -1 if a<b, 0 if equal, 1 if a>b.
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return comparePre(pa.pre, pb.pre);
}

// isNewer reports whether candidate is strictly newer than current.
export function isNewer(candidate: string, current: string): boolean {
  return !!candidate && !!current && compareSemver(candidate, current) > 0;
}

// upgradeTargets returns the chart versions an order on version current is
// allowed to upgrade to: strictly newer than current and not above approved
// (the version the author approved the form for - beyond it the form is not
// guaranteed). The list is sorted newest to oldest; empty if no upgrade is
// available. This is the single source of allowed upgrade versions (both for the
// UI and for validating ?to= on the order page), so one cannot open an upgrade
// to a nonexistent/invalid version.
export function upgradeTargets(versions: string[], current: string, approved?: string): string[] {
  if (!approved || !isNewer(approved, current)) return [];
  return versions
    .filter((v) => isNewer(v, current) && !isNewer(v, approved))
    .sort((a, b) => compareSemver(b, a));
}
