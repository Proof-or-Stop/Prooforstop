const DAYS_BEFORE_MONTH_COMMON = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DAYS_IN_MONTH_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return DAYS_IN_MONTH_COMMON[month - 1];
}

function parseDate(value) {
  if (typeof value !== "string") {
    throw new Error("Date must be a string");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Date must be in YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error("Month out of range");
  }

  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new Error("Day out of range");
  }

  return { year, month, day };
}

function leapYearsBefore(year) {
  if (year === 0) {
    return 0;
  }

  const previousYear = year - 1;
  return Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400)
    + 1;
}

function toOrdinal({ year, month, day }) {
  const years = year * 365 + leapYearsBefore(year);
  const months = DAYS_BEFORE_MONTH_COMMON[month - 1] + (month > 2 && isLeapYear(year) ? 1 : 0);
  return years + months + day - 1;
}

export default function daysBetween(a, b) {
  return toOrdinal(parseDate(b)) - toOrdinal(parseDate(a));
}
