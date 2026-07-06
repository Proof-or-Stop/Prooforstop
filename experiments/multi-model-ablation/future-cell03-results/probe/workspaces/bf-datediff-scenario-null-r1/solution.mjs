const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseDate(value) {
  if (typeof value !== 'string') {
    throw new Error('Date must be a string in YYYY-MM-DD form');
  }

  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new Error('Date must be in YYYY-MM-DD form');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error('Month must be in the range 01..12');
  }

  const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
  if (day < 1 || day > maxDay) {
    throw new Error('Day is out of range for the month');
  }

  return { year, month, day };
}

function daysBeforeYear(year) {
  return (
    365 * year
    + Math.floor((year + 3) / 4)
    - Math.floor((year + 99) / 100)
    + Math.floor((year + 399) / 400)
  );
}

function ordinalDay(date) {
  let ordinal = daysBeforeYear(date.year) + DAYS_BEFORE_MONTH[date.month - 1] + date.day - 1;
  if (date.month > 2 && isLeapYear(date.year)) {
    ordinal += 1;
  }
  return ordinal;
}

export default function daysBetween(a, b) {
  return ordinalDay(parseDate(b)) - ordinalDay(parseDate(a));
}
