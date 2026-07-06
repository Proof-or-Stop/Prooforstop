// daysBetween — whole calendar days between two ISO dates, proleptic Gregorian.
//
// Strategy: convert each (year, month, day) to a serial day number (days elapsed since the
// fixed origin 0000-01-01), then subtract. The serial-day conversion accumulates whole years
// and whole months, applying the 4/100/400 leap rule, so it handles variable month lengths
// and leap years exactly.

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2 && isLeap(year)) return 29;
  return MONTH_DAYS[month - 1];
}

function parse(s, label) {
  if (typeof s !== 'string') {
    throw new Error(`daysBetween: ${label} must be a string, got ${typeof s}`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new Error(`daysBetween: ${label} is not a valid YYYY-MM-DD date: ${JSON.stringify(s)}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`daysBetween: ${label} has non-integer fields: ${JSON.stringify(s)}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`daysBetween: ${label} month out of range (1..12): ${month}`);
  }
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    throw new Error(`daysBetween: ${label} day out of range (1..${dim}) for ${year}-${month}: ${day}`);
  }
  return { year, month, day };
}

// Number of leap days in calendar years [0, year) — i.e. strictly before `year`.
function leapDaysBefore(year) {
  const y = year - 1;
  if (y < 0) return 0;
  return Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + 1;
}

// Serial day number: days elapsed from 0000-01-01 to year-month-day.
function toSerial(year, month, day) {
  let days = year * 365 + leapDaysBefore(year);
  for (let mo = 1; mo < month; mo++) {
    days += daysInMonth(year, mo);
  }
  days += day - 1;
  return days;
}

export default function daysBetween(a, b) {
  const da = parse(a, 'first argument');
  const db = parse(b, 'second argument');
  const sa = toSerial(da.year, da.month, da.day);
  const sb = toSerial(db.year, db.month, db.day);
  return sb - sa;
}
