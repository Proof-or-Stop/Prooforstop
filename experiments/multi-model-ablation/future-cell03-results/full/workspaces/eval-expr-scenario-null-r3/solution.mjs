const CONSTANTS = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
]);

const FUNCTIONS = new Map([
  ["abs", { minArgs: 1, maxArgs: 1, call: Math.abs }],
  ["sqrt", { minArgs: 1, maxArgs: 1, call: Math.sqrt }],
  ["floor", { minArgs: 1, maxArgs: 1, call: Math.floor }],
  ["ceil", { minArgs: 1, maxArgs: 1, call: Math.ceil }],
  ["round", { minArgs: 1, maxArgs: 1, call: Math.round }],
  ["min", { minArgs: 2, maxArgs: Infinity, call: Math.min }],
  ["max", { minArgs: 2, maxArgs: Infinity, call: Math.max }],
  ["pow", { minArgs: 2, maxArgs: 2, call: Math.pow }],
  ["log", { minArgs: 1, maxArgs: 1, call: Math.log }],
  ["exp", { minArgs: 1, maxArgs: 1, call: Math.exp }],
]);

export default function evalExpr(expr) {
  if (typeof expr !== "string") {
    throw new Error("Expression must be a string");
  }

  const parser = new Parser(expr);
  const value = parser.parseExpression();
  parser.skipWhitespace();

  if (!parser.isAtEnd()) {
    throw parser.error("Unexpected token");
  }

  return value;
}

class Parser {
  constructor(input) {
    this.input = input;
    this.index = 0;
  }

  parseExpression() {
    return this.parseAdditive();
  }

  parseAdditive() {
    let value = this.parseMultiplicative();

    while (true) {
      this.skipWhitespace();

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
      this.skipWhitespace();

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
    this.skipWhitespace();

    if (this.match("+")) {
      return +this.parseUnary();
    }

    if (this.match("-")) {
      return -this.parseUnary();
    }

    return this.parsePower();
  }

  parsePower() {
    let value = this.parsePrimary();
    this.skipWhitespace();

    if (this.match("^")) {
      value = Math.pow(value, this.parseUnary());
    }

    return value;
  }

  parsePrimary() {
    this.skipWhitespace();

    if (this.match("(")) {
      const value = this.parseExpression();
      this.skipWhitespace();

      if (!this.match(")")) {
        throw this.error("Expected closing parenthesis");
      }

      return value;
    }

    const char = this.peek();

    if (isDigit(char) || char === ".") {
      return this.parseNumber();
    }

    if (isNameStart(char)) {
      return this.parseName();
    }

    if (this.isAtEnd()) {
      throw this.error("Unexpected end of expression");
    }

    throw this.error("Unexpected token");
  }

  parseNumber() {
    const start = this.index;
    let sawDigit = false;

    while (isDigit(this.peek())) {
      sawDigit = true;
      this.index += 1;
    }

    if (this.peek() === ".") {
      this.index += 1;

      while (isDigit(this.peek())) {
        sawDigit = true;
        this.index += 1;
      }
    }

    if (!sawDigit) {
      throw this.error("Invalid number");
    }

    const next = this.peek();
    if (next === "." || isNameStart(next)) {
      throw this.error("Invalid number");
    }

    return Number(this.input.slice(start, this.index));
  }

  parseName() {
    const name = this.readIdentifier();
    this.skipWhitespace();

    if (this.match("(")) {
      const fn = FUNCTIONS.get(name);
      if (!fn) {
        throw this.error(`Unknown function "${name}"`);
      }

      const args = [];
      this.skipWhitespace();

      if (!this.match(")")) {
        while (true) {
          args.push(this.parseExpression());
          this.skipWhitespace();

          if (this.match(")")) {
            break;
          }

          if (!this.match(",")) {
            throw this.error("Expected comma or closing parenthesis");
          }

          this.skipWhitespace();
          if (this.peek() === ")") {
            throw this.error("Expected function argument");
          }
        }
      }

      if (args.length < fn.minArgs || args.length > fn.maxArgs) {
        throw this.error(`Invalid argument count for "${name}"`);
      }

      return fn.call(...args);
    }

    if (CONSTANTS.has(name)) {
      return CONSTANTS.get(name);
    }

    throw this.error(`Unknown name "${name}"`);
  }

  readIdentifier() {
    const start = this.index;
    this.index += 1;

    while (isNamePart(this.peek())) {
      this.index += 1;
    }

    return this.input.slice(start, this.index);
  }

  skipWhitespace() {
    while (/\s/.test(this.peek())) {
      this.index += 1;
    }
  }

  match(token) {
    if (this.input.startsWith(token, this.index)) {
      this.index += token.length;
      return true;
    }

    return false;
  }

  peek() {
    return this.input[this.index] ?? "";
  }

  isAtEnd() {
    return this.index >= this.input.length;
  }

  error(message) {
    return new Error(`${message} at position ${this.index}`);
  }
}

function isDigit(char) {
  return char >= "0" && char <= "9";
}

function isNameStart(char) {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isNamePart(char) {
  return isNameStart(char) || isDigit(char);
}
