// safeHref returns the URL only when it is an http(s) link, otherwise undefined.
// React does not block javascript:/data: URLs in production, so server-provided
// links (MR / ArgoCD / integration URLs) are filtered before being rendered as
// an <a href>. Use rel="noopener noreferrer" on target="_blank" alongside this.
export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}
