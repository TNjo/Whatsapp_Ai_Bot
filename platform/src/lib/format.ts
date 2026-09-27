/** Money is stored in minor units (cents). */
export function formatMoney(minor: number, currency = "LKR"): string {
  const major = minor / 100;
  const whole = Number.isInteger(major);
  const digits = whole ? 0 : 2;
  const number = major.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  if (currency === "LKR") return `Rs. ${number}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits }).format(major);
  } catch {
    return `${currency} ${number}`;
  }
}

/** "2,500" / "2500.50" → 250000 / 250050. Returns null for invalid input. */
export function parseMoney(value: string | number): number | null {
  const text = String(value).replace(/[^0-9.]/g, "");
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100);
}

export function toMajor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  return String(minor / 100);
}

export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return value;
  if (digits.startsWith("94") && digits.length === 11) {
    return `+94 ${digits.slice(2, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : ([...words[0]][1] ?? "");
  return (first + second).toUpperCase();
}

function dayKey(date: Date, timeZone?: string) {
  return date.toLocaleDateString("en-CA", { timeZone });
}

/** "Today, 8:25 PM" / "Yesterday, …" / "Sep 3, …" — evaluated in the business timezone. */
export function formatDateTime(value: Date | string | number, timeZone?: string): string {
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  if (dayKey(date, timeZone) === dayKey(now, timeZone)) return `Today, ${time}`;
  if (dayKey(date, timeZone) === dayKey(new Date(now.getTime() - 86400000), timeZone)) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}, ${time}`;
}

export function relativeTime(value: Date | string | number): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function variantLabel(optionValues: Record<string, string> | null | undefined): string {
  return Object.entries(optionValues ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}
