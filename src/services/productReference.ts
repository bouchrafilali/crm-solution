function cleanUrl(raw: string): string {
  let url = String(raw || "").trim();
  while (/[),.;!?]$/.test(url)) url = url.slice(0, -1);
  return url;
}

export function extractShopifyProductUrl(text: string | null | undefined): string {
  const src = String(text || "");
  const re = /https?:\/\/[^\s"'<>]+/gi;
  let match = re.exec(src);
  while (match) {
    const url = cleanUrl(String(match[0] || ""));
    if (url.toLowerCase().includes("/products/")) return url;
    match = re.exec(src);
  }
  return "";
}

export function extractProductHandleFromUrl(url: string | null | undefined): string {
  try {
    const u = new URL(String(url || ""));
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((part) => part === "products");
    if (idx === -1 || !parts[idx + 1]) return "";
    return decodeURIComponent(String(parts[idx + 1]).split("?")[0] || "").trim();
  } catch {
    return "";
  }
}

function humanizeHandle(handle: string): string {
  return String(handle || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitleHint(text: string): string {
  const src = String(text || "");
  const patterns = [
    /interested in this article:\s*\*?([^\n*]+)\*?/i,
    /article\s*:\s*\*?([^\n*]+)\*?/i,
    /produit\s*:\s*\*?([^\n*]+)\*?/i,
    /i(?:'|’)m interested in\s*\*?([^\n*]+)\*?/i
  ];
  for (const p of patterns) {
    const m = src.match(p);
    if (m && m[1]) {
      const title = String(m[1]).trim();
      if (title) return title;
    }
  }
  return "";
}

export function inferProductReference(input: {
  explicit?: string | null;
  text?: string | null;
}): string | null {
  const explicit = String(input.explicit || "").trim();
  if (explicit) return explicit;

  const text = String(input.text || "");
  const url = extractShopifyProductUrl(text);
  const hint = extractTitleHint(text);
  const handle = extractProductHandleFromUrl(url);
  const handleTitle = humanizeHandle(handle);

  if (hint && url) return `${hint} (${url})`;
  if (hint) return hint;
  if (url) return url;
  if (handleTitle) return handleTitle;
  return null;
}
