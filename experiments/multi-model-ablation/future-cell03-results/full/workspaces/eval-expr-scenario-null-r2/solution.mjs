const CONSTANTS = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
]);

const FUNCTIONS = new Map([
  ["abs", { min: 1, max: 1, fn: Math.abs }],
  ["sqrt", { min: 1, max: 1, fn: Math.sqrt }],
  ["floor", { min: 1, max: 1, fn: Math.floor }],
  ["ceil", { min: 1, max: 1, fn: Math.ceil }],
  ["round", { min: 1, max: 1, fn: Math.round }],
  ["min", { min: 1, max: Infinity, fn: Math.min }],
  ["max", { min: 1, max: Infinity, fn: Math.max }],
  ["pow", { min: 2, max: 2, fn: Math.pow }],
  ["log", { min: 1, max: 1, fn: Math.log }],
  ["exp", { min: 1, max: 1, fn: Math.exp }],
]);

class Parser {
  constructor(input) {
    this.input = input;
    this.pos = 0;
  }

  parse() {
    const value = this.parseAdditive();
    this.skipWhitespace();
    if (!this.isAtEnd()) {
      this.fail(`Unexpected token ${JSON.stringify(this.peek())}`);
    }
    return value;
  }

  parseAdditive() {
    let value = this.parseMultiplicative();

    while (true) {
      if (this.match("+")) {
        value += this.parseMultiplicative();
      } else if (this.match("-")) {
        value -= this.parseMultiplicative();
      } else {
        return value;
      }
    }
  }

  parseMultiplicative() {
    let value = this.parseUnary();

    while (true) {
      if (this.match("*")) {
        value *= this.parseUnary();
      } else if (this.match("/")) {
        value /= this.parseUnary();
      } else if (this.match("%")) {
        value %= this.parseUnary();
      } else {
        return value;
      }
    }
  }

  parseUnary() {
    if (this.match("+")) {
      return this.parseUnary();
    }
    if (this.match("-")) {
      return -this.parseUnary();
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    if (this.match("^")) {
      return base ** this.parseUnary();
    }
    return base;
  }

  parsePrimary() {
    this.skipWhitespace();

    if (this.match("(")) {
      const value = this.parseAdditive();
      this.expect(")");
      return value;
    }

    const char = this.peek();
    if (this.isDigit(char) || (char === "." && this.isDigit(this.peek(1)))) {
      return this.parseNumber();
    }

    if (this.isIdentifierStart(char)) {
      return this.parseName();
    }

    if (this.isAtEnd()) {
      this.fail("Expected expression");
    }
    this.fail(`Unexpected token ${JSON.stringify(char)}`);
  }

  parseNumber() {
    this.skipWhitespace();
    const start = this.pos;

    if (this.peek() === ".") {
      this.pos += 1;
      this.consumeDigits();
    } else {
      this.consumeDigits();
      if (this.peek() === ".") {
        this.pos += 1;
        if (!this.isDigit(this.peek())) {
          this.fail("Expected digit after decimal point");
        }
        this.consumeDigits();
      }
    }

    return Number(this.input.slice(start, this.pos));
  }

  parseName() {
    const name = this.parseIdentifier();

    this.skipWhitespace();
    if (this.match("(")) {
      return this.parseFunctionCall(name);
    }

    if (CONSTANTS.has(name)) {
      return CONSTANTS.get(name);
    }

    this.fail(`Unknown name ${JSON.stringify(name)}`);
  }

  parseFunctionCall(name) {
    const entry = FUNCTIONS.get(name);
    if (!entry) {
      this.fail(`Unknown function ${JSON.stringify(name)}`);
    }

    const args = [];
    this.skipWhitespace();
    if (!this.match(")")) {
      while (true) {
        args.push(this.parseAdditive());
        this.skipWhitespace();
        if (this.match(")")) {
          break;
        }
        this.expect(",");
      }
    }

    if (args.length < entry.min || args.length > entry.max) {
      this.fail(`Invalid argument count for ${name}`);
    }

    return entry.fn(...args);
  }

  parseIdentifier() {
    const start = this.pos;
    this.pos += 1;
    while (this.isIdentifierPart(this.peek())) {
      this.pos += 1;
    }
    return this.input.slice(start, this.pos);
  }

  consumeDigits() {
    while (this.isDigit(this.peek())) {
      this.pos += 1;
    }
  }

  expect(char) {
    if (!this.match(char)) {
      this.fail(`Expected ${JSON.stringify(char)}`);
    }
  }

  match(char) {
    this.skipWhitespace();
    if (this.input[this.pos] === char) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  skipWhitespace() {
    while (!this.isAtEnd() && /\s/u.test(this.input[this.pos])) {
      this.pos += 1;
    }
  }

  peek(offset = 0) {
    return this.input[this.pos + offset];
  }

  isAtEnd() {
    return this.pos >= this.input.length;
  }

  isDigit(char) {
    return char >= "0" && char <= "9";
  }

  isIdentifierStart(char) {
    return (
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      char === "_"
    );
  }

  isIdentifierPart(char) {
    return this.isIdentifierStart(char) || this.isDigit(char);
  }

  fail(message) {
    throw new Error(`${message} at position ${this.pos}`);
  }
}

export default function evalExpr(expr) {
  if (typeof expr !== "string") {
    throw new Error("Expression must be a string");
  }
  return new Parser(expr).parse();
}
