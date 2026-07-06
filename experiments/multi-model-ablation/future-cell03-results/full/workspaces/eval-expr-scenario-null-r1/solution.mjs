const FUNCTIONS = new Map([
  ["abs", { arity: 1, fn: Math.abs }],
  ["sqrt", { arity: 1, fn: Math.sqrt }],
  ["floor", { arity: 1, fn: Math.floor }],
  ["ceil", { arity: 1, fn: Math.ceil }],
  ["round", { arity: 1, fn: Math.round }],
  ["pow", { arity: 2, fn: Math.pow }],
  ["log", { arity: 1, fn: Math.log }],
  ["exp", { arity: 1, fn: Math.exp }],
  ["min", { minArity: 1, fn: Math.min }],
  ["max", { minArity: 1, fn: Math.max }],
]);

const CONSTANTS = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
]);

class Parser {
  constructor(input) {
    if (typeof input !== "string") {
      throw new Error("Expression must be a string");
    }

    this.input = input;
    this.pos = 0;
  }

  parse() {
    const value = this.parseAdditive();
    this.skipWhitespace();

    if (!this.isEnd()) {
      this.fail(`Unexpected token '${this.input[this.pos]}'`);
    }

    return value;
  }

  parseAdditive() {
    let value = this.parseMultiplicative();

    while (true) {
      this.skipWhitespace();

      if (this.consume("+")) {
        value += this.parseMultiplicative();
      } else if (this.consume("-")) {
        value -= this.parseMultiplicative();
      } else {
        return value;
      }
    }
  }

  parseMultiplicative() {
    let value = this.parseUnary();

    while (true) {
      this.skipWhitespace();

      if (this.consume("*")) {
        value *= this.parseUnary();
      } else if (this.consume("/")) {
        value /= this.parseUnary();
      } else if (this.consume("%")) {
        value %= this.parseUnary();
      } else {
        return value;
      }
    }
  }

  parseUnary() {
    this.skipWhitespace();

    if (this.consume("+")) {
      return +this.parseUnary();
    }

    if (this.consume("-")) {
      return -this.parseUnary();
    }

    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    this.skipWhitespace();

    if (this.consume("^")) {
      return Math.pow(base, this.parseUnary());
    }

    return base;
  }

  parsePrimary() {
    this.skipWhitespace();

    if (this.isEnd()) {
      this.fail("Expected expression");
    }

    if (this.consume("(")) {
      const value = this.parseAdditive();
      this.skipWhitespace();

      if (!this.consume(")")) {
        this.fail("Expected ')'");
      }

      return value;
    }

    const char = this.input[this.pos];

    if (this.isDigit(char) || char === ".") {
      return this.parseNumber();
    }

    if (this.isIdentifierStart(char)) {
      return this.parseName();
    }

    this.fail(`Unexpected token '${char}'`);
  }

  parseNumber() {
    const start = this.pos;
    let sawDigit = false;

    while (this.isDigit(this.input[this.pos])) {
      sawDigit = true;
      this.pos += 1;
    }

    if (this.input[this.pos] === ".") {
      this.pos += 1;

      while (this.isDigit(this.input[this.pos])) {
        sawDigit = true;
        this.pos += 1;
      }
    }

    if (!sawDigit) {
      this.fail("Expected number");
    }

    return Number(this.input.slice(start, this.pos));
  }

  parseName() {
    const start = this.pos;
    this.pos += 1;

    while (this.isIdentifierPart(this.input[this.pos])) {
      this.pos += 1;
    }

    const name = this.input.slice(start, this.pos);
    this.skipWhitespace();

    if (this.consume("(")) {
      return this.parseFunctionCall(name);
    }

    if (CONSTANTS.has(name)) {
      return CONSTANTS.get(name);
    }

    this.fail(`Unknown name '${name}'`);
  }

  parseFunctionCall(name) {
    const fnSpec = FUNCTIONS.get(name);

    if (!fnSpec) {
      this.fail(`Unknown function '${name}'`);
    }

    const args = [];
    this.skipWhitespace();

    if (this.consume(")")) {
      this.fail(`Function '${name}' requires arguments`);
    }

    while (true) {
      args.push(this.parseAdditive());
      this.skipWhitespace();

      if (this.consume(",")) {
        continue;
      }

      if (!this.consume(")")) {
        this.fail("Expected ',' or ')'");
      }

      break;
    }

    if (typeof fnSpec.arity === "number" && args.length !== fnSpec.arity) {
      this.fail(`Function '${name}' expects ${fnSpec.arity} argument(s)`);
    }

    if (typeof fnSpec.minArity === "number" && args.length < fnSpec.minArity) {
      this.fail(`Function '${name}' requires at least ${fnSpec.minArity} argument(s)`);
    }

    return fnSpec.fn(...args);
  }

  skipWhitespace() {
    while (/\s/.test(this.input[this.pos] ?? "")) {
      this.pos += 1;
    }
  }

  consume(char) {
    if (this.input[this.pos] === char) {
      this.pos += 1;
      return true;
    }

    return false;
  }

  isEnd() {
    return this.pos >= this.input.length;
  }

  isDigit(char) {
    return char >= "0" && char <= "9";
  }

  isIdentifierStart(char) {
    return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
  }

  isIdentifierPart(char) {
    return this.isIdentifierStart(char) || this.isDigit(char);
  }

  fail(message) {
    throw new Error(`${message} at position ${this.pos}`);
  }
}

export default function evalExpr(expr) {
  return new Parser(expr).parse();
}
