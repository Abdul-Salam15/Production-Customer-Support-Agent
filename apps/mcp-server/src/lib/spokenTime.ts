// Turns a stored callback time ("Thu 8 Oct, 14:00 WAT", the contact form's
// format) into the words the agent should say ("Thursday the eighth of
// October at two in the afternoon, West Africa Time").
//
// Left to the model, the conversion kept going wrong — "14:00" was read back
// as "two thirty-five", "13:30" as "one thirty-five" — so the caller heard a
// different time from the one stored for the specialist. Returns null for
// anything it can't parse; the agent then reads the written time itself.

const DAYS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", oct: "October", nov: "November", dec: "December",
};
const ZONES: Record<string, string> = {
  wat: "West Africa Time",
  eat: "East Africa Time",
  cat: "Central Africa Time",
  sast: "South Africa Standard Time",
  gmt: "Greenwich Mean Time",
  "uk time": "UK time",
  et: "Eastern Time",
};

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth",
  "nineteenth", "twentieth"];

function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens}-${ONES[n % 10]}` : tens;
}

function ordinalWords(n: number): string {
  if (n <= 20) return ORDINALS[n];
  if (n === 30) return "thirtieth";
  const tens = TENS[Math.floor(n / 10)];
  return `${tens}-${ORDINALS[n % 10]}`;
}

function timeWords(hours: number, minutes: number): string {
  if (hours === 0 && minutes === 0) return "midnight";
  if (hours === 12 && minutes === 0) return "noon";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const mins = minutes === 0 ? "" : minutes < 10 ? ` oh-${ONES[minutes]}` : ` ${numberWords(minutes)}`;
  const period = hours < 12 ? "in the morning" : hours < 17 ? "in the afternoon" : "in the evening";
  return `${numberWords(hour12)}${mins} ${period}`;
}

export function spokenCallbackTime(written: string | null | undefined): string | null {
  if (!written) return null;
  const m = written.trim().match(/^([A-Za-z]{3})\w*,?\s+(\d{1,2})\s+([A-Za-z]{3})\w*,?\s+(\d{1,2}):(\d{2})\s*(.*)$/);
  if (!m) return null;
  const [, day, date, month, hh, mm, zone] = m;
  const dayName = DAYS[day.toLowerCase()];
  const monthName = MONTHS[month.toLowerCase()];
  const d = Number(date), h = Number(hh), min = Number(mm);
  if (!dayName || !monthName || d < 1 || d > 31 || h > 23 || min > 59) return null;
  const zoneName = zone ? ZONES[zone.trim().toLowerCase()] ?? zone.trim() : "";
  return `${dayName} the ${ordinalWords(d)} of ${monthName} at ${timeWords(h, min)}${zoneName ? `, ${zoneName}` : ""}`;
}

// IANA zones for the abbreviations the contact form offers; UK time and ET
// shift with daylight saving, so they're resolved through Intl, not a fixed offset.
const ZONE_IDS: Record<string, string> = {
  wat: "Africa/Lagos",
  eat: "Africa/Nairobi",
  cat: "Africa/Maputo",
  sast: "Africa/Johannesburg",
  gmt: "Etc/GMT",
  "uk time": "Europe/London",
  et: "America/New_York",
};
const MONTH_INDEX = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Minutes the zone is ahead of UTC at that instant.
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

// The same written time as an instant, for escalations.callback_at. It has no
// year, so it's the first occurrence that isn't more than a day before
// `reference` (when the case was created): callbacks are booked ahead.
// Returns null for anything it can't parse, including an unknown zone.
export function callbackInstant(written: string | null | undefined, reference: Date = new Date()): Date | null {
  if (!written) return null;
  const m = written.trim().match(/^[A-Za-z]{3}\w*,?\s+(\d{1,2})\s+([A-Za-z]{3})\w*,?\s+(\d{1,2}):(\d{2})\s*(.*)$/);
  if (!m) return null;
  const [, date, month, hh, mm, zone] = m;
  const monthIndex = MONTH_INDEX.indexOf(month.toLowerCase());
  const timeZone = ZONE_IDS[(zone || "wat").trim().toLowerCase()];
  if (monthIndex < 0 || !timeZone) return null;

  const toInstant = (year: number): Date => {
    const wallAsUtc = Date.UTC(year, monthIndex, Number(date), Number(hh), Number(mm));
    return new Date(wallAsUtc - zoneOffsetMinutes(timeZone, new Date(wallAsUtc)) * 60000);
  };
  const year = reference.getUTCFullYear();
  const candidate = toInstant(year);
  return candidate.getTime() < reference.getTime() - 24 * 60 * 60 * 1000 ? toInstant(year + 1) : candidate;
}

// Callbacks run Monday to Friday, 9am to 5pm in the caller's own timezone:
// the written time is wall-clock time in its zone, so the day and time are
// checked as written. The same rule is in the contact form (app.js) and the
// contact endpoint (apps/agent contactRoutes.ts). Unparseable text passes.
export function outsideBusinessHours(written: string | null | undefined): boolean {
  const m = written?.trim().match(/^([A-Za-z]{3})\w*,?\s+\d{1,2}\s+[A-Za-z]{3}\w*,?\s+(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const day = m[1].toLowerCase();
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return day === "sat" || day === "sun" || minutes < 9 * 60 || minutes > 17 * 60;
}
