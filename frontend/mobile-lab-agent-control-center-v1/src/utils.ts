export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function initials(name: string): string {
  const chunks = name.trim().split(/\s+/);
  return chunks.slice(0, 2).map((chunk) => chunk[0]?.toUpperCase() ?? "").join("");
}
