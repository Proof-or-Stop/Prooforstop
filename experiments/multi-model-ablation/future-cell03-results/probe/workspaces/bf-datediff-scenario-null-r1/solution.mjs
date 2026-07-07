const DAYS_BEFORE_MONTH = [
  0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334,
];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseDate(value) {
  if (typeof value !== "string") {
    throw new Error("Date must be a string");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error("Date must be in YYYY-MM-DD form");
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

function daysBeforeYear(year) {
  if (year === 0) {
    return 0;
  }

  const previousYear = year - 1;
  return (
    365 * year +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    1
  );
}

function toOrdinal(date) {
  return (
    daysBeforeYear(date.year) +
    DAYS_BEFORE_MONTH[date.month - 1] +
    (date.month > 2 && isLeapYear(date.year) ? 1 : 0) +
    date.day -
    1
  );
}

export default function daysBetween(a, b) {
  return toOrdinal(parseDate(b)) - toOrdinal(parseDate(a));
}
