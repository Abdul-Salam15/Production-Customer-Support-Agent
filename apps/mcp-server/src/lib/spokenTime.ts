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
