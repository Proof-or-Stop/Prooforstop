export default function validateCardNumber(input) {
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }

  if (!/^[0-9 -]*$/.test(input)) {
    throw new Error("input contains invalid characters");
  }

  const digits = input.replace(/[ -]/g, "");

  if (digits.length < 2 || digits.length > 19) {
    throw new Error("card number length must be between 2 and 19 digits");
  }

  let total = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;

    if (shouldDouble) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    total += value;
    shouldDouble = !shouldDouble;
  }

  return total % 10 === 0;
}
