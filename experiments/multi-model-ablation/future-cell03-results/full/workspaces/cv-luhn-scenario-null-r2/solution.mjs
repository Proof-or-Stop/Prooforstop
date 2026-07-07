export default function validateCardNumber(input) {
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }

  if (!/^[0-9 -]*$/.test(input)) {
    throw new Error("input contains invalid characters");
  }

  const digits = input.replace(/[ -]/g, "");

  if (digits.length < 2 || digits.length > 19) {
    throw new Error("card number must contain 2 to 19 digits");
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
