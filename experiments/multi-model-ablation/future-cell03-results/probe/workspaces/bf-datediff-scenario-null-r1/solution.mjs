const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeapYear(year) {
  return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parseDate(value) {
  if (typeof value !== "string") {
    throw new Error("Date must be a string");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Date must be in YYYY-MM-DD form");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error("Month out of range");
  }

  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error("Day out of range");
  }

  return { year, month, day };
}

function daysBeforeYear(year) {
  return year * 365
    + Math.floor((year + 3) / 4)
    - Math.floor((year + 99) / 100)
    + Math.floor((year + 399) / 400);
}

function toOrdinal({ year, month, day }) {
  let ordinal = daysBeforeYear(year) + DAYS_BEFORE_MONTH[month - 1] + day - 1;

  if (month > 2 && isLeapYear(year)) {
    ordinal += 1;
  }

  return ordinal;
}

export default function daysBetween(a, b) {
  return toOrdinal(parseDate(b)) - toOrdinal(parseDate(a));
}
