// Lightweight semver comparison of chart versions (no ranges): needed to tell
// whether the blessed version is "newer" than the order's version. The "v"
// prefix is ignored, the pre-release suffix (1.2.3-rc1) is dropped - for a Helm
// chart catalog a major.minor.patch comparison is enough.

function parse(v: string): number[] {
  const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
  return core.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

// compareSemver: -1 if a<b, 0 if equal, 1 if a>b.
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
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
