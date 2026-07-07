const COMMON_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH_COMMON = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DAYS_BEFORE_MONTH_LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseDate(value) {
  if (typeof value !== 'string') {
    throw new Error('date must be a string');
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('date must match YYYY-MM-DD');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error('month out of range');
  }

  const leap = isLeapYear(year);
  const maxDay = month === 2 && leap ? 29 : COMMON_MONTH_DAYS[month - 1];
  if (day < 1 || day > maxDay) {
    throw new Error('day out of range');
  }

  return { year, month, day, leap };
}

function leapYearsBefore(year) {
  if (year === 0) {
    return 0;
  }

  return (
    Math.floor((year + 3) / 4) -
    Math.floor((year + 99) / 100) +
    Math.floor((year + 399) / 400)
  );
}

function dayNumber(date) {
  const daysBeforeYear = date.year * 365 + leapYearsBefore(date.year);
  const daysBeforeMonth = (date.leap ? DAYS_BEFORE_MONTH_LEAP : DAYS_BEFORE_MONTH_COMMON)[date.month - 1];
  return daysBeforeYear + daysBeforeMonth + date.day - 1;
}

export default function daysBetween(a, b) {
  return dayNumber(parseDate(b)) - dayNumber(parseDate(a));
}
