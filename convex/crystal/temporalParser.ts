const millisecondsPerDay = 24 * 60 * 60 * 1000;

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const monthAliases: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const weekdayAliases: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const quantityWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const startOfUtcDay = (timestamp: number) => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
};

const endOfUtcDay = (timestamp: number) => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999);
};

const buildDayRange = (year: number, monthIndex: number, day: number) => ({
  startMs: Date.UTC(year, monthIndex, day, 0, 0, 0, 0),
  endMs: Date.UTC(year, monthIndex, day, 23, 59, 59, 999),
});

const buildMonthRange = (year: number, monthIndex: number) => ({
  startMs: Date.UTC(year, monthIndex, 1, 0, 0, 0, 0),
  endMs: Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999),
});

const parseQuantity = (value: string) => {
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return quantityWords[value] ?? null;
};

const resolveAmbiguousYear = (monthIndex: number, day: number, now: Date) => {
  const currentYear = now.getUTCFullYear();
  const candidate = Date.UTC(currentYear, monthIndex, day, 0, 0, 0, 0);
  return candidate > now.getTime() ? currentYear - 1 : currentYear;
};

const findPreviousWeekday = (targetWeekday: number, now: Date, allowToday = false) => {
  const todayStart = startOfUtcDay(now.getTime());
  const todayWeekday = new Date(todayStart).getUTCDay();
  const delta = allowToday ? (todayWeekday - targetWeekday + 7) % 7 : (todayWeekday - targetWeekday + 7) % 7 || 7;
  return todayStart - delta * millisecondsPerDay;
};

const startOfUtcWeek = (timestamp: number) => {
  const dayStart = startOfUtcDay(timestamp);
  const weekday = new Date(dayStart).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return dayStart - mondayOffset * millisecondsPerDay;
};

const endOfUtcWeek = (timestamp: number) => startOfUtcWeek(timestamp) + 7 * millisecondsPerDay - 1;

const parseWrittenDate = (query: string, now: Date) => {
  const monthDayYear = query.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s+(\d{4}))?\b/
  );
  if (monthDayYear) {
    const monthIndex = monthAliases[monthDayYear[1]];
    const day = Number.parseInt(monthDayYear[2], 10);
    const year = monthDayYear[3] ? Number.parseInt(monthDayYear[3], 10) : resolveAmbiguousYear(monthIndex, day, now);
    return buildDayRange(year, monthIndex, day);
  }

  const dayMonthYear = query.match(
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/
  );
  if (dayMonthYear) {
    const day = Number.parseInt(dayMonthYear[1], 10);
    const monthIndex = monthAliases[dayMonthYear[2]];
    const year = dayMonthYear[3] ? Number.parseInt(dayMonthYear[3], 10) : resolveAmbiguousYear(monthIndex, day, now);
    return buildDayRange(year, monthIndex, day);
  }

  return null;
};

export function parseTemporalReference(query: string, now = Date.now()): { startMs: number; endMs: number } | null {
  const normalized = normalizeText(query);
  if (!normalized) {
    return null;
  }

  const nowDate = new Date(now);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return buildDayRange(
      Number.parseInt(isoMatch[1], 10),
      Number.parseInt(isoMatch[2], 10) - 1,
      Number.parseInt(isoMatch[3], 10)
    );
  }

  if (normalized.includes("today")) {
    return { startMs: startOfUtcDay(now), endMs: endOfUtcDay(now) };
  }

  if (normalized.includes("yesterday")) {
    const timestamp = now - millisecondsPerDay;
    return { startMs: startOfUtcDay(timestamp), endMs: endOfUtcDay(timestamp) };
  }

  const relativeDayMatch = normalized.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago\b/);
  if (relativeDayMatch) {
    const quantity = parseQuantity(relativeDayMatch[1]);
    if (quantity) {
      const timestamp = now - quantity * millisecondsPerDay;
      return { startMs: startOfUtcDay(timestamp), endMs: endOfUtcDay(timestamp) };
    }
  }

  if (normalized.includes("last week")) {
    const previousWeekAnchor = startOfUtcWeek(now) - millisecondsPerDay;
    return {
      startMs: startOfUtcWeek(previousWeekAnchor),
      endMs: endOfUtcWeek(previousWeekAnchor),
    };
  }

  const relativeWeekMatch = normalized.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+weeks?\s+ago\b/);
  if (relativeWeekMatch) {
    const quantity = parseQuantity(relativeWeekMatch[1]);
    if (quantity) {
      const previousWeekAnchor = startOfUtcWeek(now) - quantity * 7 * millisecondsPerDay;
      return {
        startMs: startOfUtcWeek(previousWeekAnchor),
        endMs: endOfUtcWeek(previousWeekAnchor),
      };
    }
  }

  if (normalized.includes("last month")) {
    const currentYear = nowDate.getUTCFullYear();
    const currentMonth = nowDate.getUTCMonth();
    const targetMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const targetYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    return buildMonthRange(targetYear, targetMonth);
  }

  const monthReference = normalized.match(
    /\b(?:in|last)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/
  );
  if (monthReference) {
    const monthIndex = monthAliases[monthReference[1]];
    const currentYear = nowDate.getUTCFullYear();
    let targetYear = currentYear;

    if (normalized.includes(`last ${monthReference[1]}`)) {
      targetYear -= 1;
    } else if (monthIndex > nowDate.getUTCMonth()) {
      targetYear -= 1;
    }

    return buildMonthRange(targetYear, monthIndex);
  }

  const explicitDate = parseWrittenDate(normalized, nowDate);
  if (explicitDate) {
    return explicitDate;
  }

  const weekdayReference = normalized.match(
    /\b(?:on|last)\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/
  );
  if (weekdayReference) {
    const weekday = weekdayAliases[weekdayReference[1]];
    const allowToday = weekdayReference[0].startsWith("on ");
    const timestamp = findPreviousWeekday(weekday, nowDate, allowToday);
    return { startMs: startOfUtcDay(timestamp), endMs: endOfUtcDay(timestamp) };
  }

  return null;
}

export { monthNames };
