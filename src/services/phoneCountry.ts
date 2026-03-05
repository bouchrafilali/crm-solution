export function normalizePhoneE164(raw: string | null | undefined): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

export function inferIsoCountryFromPhone(rawPhone: string | null | undefined): string | null {
  const e164 = normalizePhoneE164(rawPhone);
  if (!e164) return null;
  const digits = e164.slice(1);
  const map: Array<{ prefix: string; iso2: string }> = [
    { prefix: "212", iso2: "MA" },
    { prefix: "33", iso2: "FR" },
    { prefix: "971", iso2: "AE" },
    { prefix: "966", iso2: "SA" },
    { prefix: "965", iso2: "KW" },
    { prefix: "974", iso2: "QA" },
    { prefix: "973", iso2: "BH" },
    { prefix: "968", iso2: "OM" },
    { prefix: "44", iso2: "GB" },
    { prefix: "1", iso2: "US" }
  ];
  const found = map.find((item) => digits.startsWith(item.prefix));
  return found ? found.iso2 : null;
}
