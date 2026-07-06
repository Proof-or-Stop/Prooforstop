const DAYS_BEFORE_MONTH_COMMON = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DAYS_BEFORE_MONTH_LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const DAYS_IN_MONTH_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_IN_MONTH_LEAP = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseDate(value) {
  if (typeof value !== "string") {
    throw new Error("Date must be a string");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Date must have shape YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error("Month out of range");
  }

  const daysInMonth = isLeapYear(year) ? DAYS_IN_MONTH_LEAP : DAYS_IN_MONTH_COMMON;
  if (day < 1 || day > daysInMonth[month - 1]) {
    throw new Error("Day out of range");
  }

  return { year, month, day };
}

function daysBeforeYear(year) {
  return (
    365 * year +
    Math.floor((year + 3) / 4) -
    Math.floor((year + 99) / 100) +
    Math.floor((year + 399) / 400)
  );
}

function toDayNumber(date) {
  const daysBeforeMonth = isLeapYear(date.year)
    ? DAYS_BEFORE_MONTH_LEAP
    : DAYS_BEFORE_MONTH_COMMON;

  return daysBeforeYear(date.year) + daysBeforeMonth[date.month - 1] + date.day - 1;
}

export default function daysBetween(a, b) {
  return toDayNumber(parseDate(b)) - toDayNumber(parseDate(a));
}
