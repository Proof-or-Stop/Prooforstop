const CONSTANTS = { pi: Math.PI, e: Math.E };
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function checkArity(name, args, n) {
  if (args.length !== n) throw new Error(`${name} expects ${n} arg(s), got ${args.length}`);
}

const FUNCTIONS = {
  abs:   (a) => { checkArity('abs',   a, 1); return Math.abs(a[0]); },
  sqrt:  (a) => { checkArity('sqrt',  a, 1); return Math.sqrt(a[0]); },
  floor: (a) => { checkArity('floor', a, 1); return Math.floor(a[0]); },
  ceil:  (a) => { checkArity('ceil',  a, 1); return Math.ceil(a[0]); },
  round: (a) => { checkArity('round', a, 1); return Math.round(a[0]); },
  min:   (a) => { if (a.length < 1) throw new Error('min expects at least 1 arg'); return Math.min(...a); },
  max:   (a) => { if (a.length < 1) throw new Error('max expects at least 1 arg'); return Math.max(...a); },
  pow:   (a) => { checkArity('pow',   a, 2); return Math.pow(a[0], a[1]); },
  log:   (a) => { checkArity('log',   a, 1); return Math.log(a[0]); },
  exp:   (a) => { checkArity('exp',   a, 1); return Math.exp(a[0]); },
};

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }

    if (/[0-9]/.test(expr[i]) || (expr[i] === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let j = i;
      while (j < expr.length && /[0-9]/.test(expr[j])) j++;
      if (j < expr.length && expr[j] === '.') {
        j++;
        while (j < expr.length && /[0-9]/.test(expr[j])) j++;
      }
      tokens.push({ type: 'num', value: parseFloat(expr.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(expr[i])) {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      tokens.push({ type: 'name', value: expr.slice(i, j) });
      i = j;
      continue;
    }

    if ('+-*/%^'.includes(expr[i])) {
      tokens.push({ type: 'op', value: expr[i] });
      i++;
      continue;
    }

    if (expr[i] === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue; }
    if (expr[i] === ',') { tokens.push({ type: 'comma',  value: ',' }); i++; continue; }

    throw new Error(`Unexpected character: '${expr[i]}'`);
  }
  return tokens;
}

export default function evalExpr(expr) {
  if (typeof expr !== 'string') throw new TypeError('evalExpr expects a string expression, got ' + typeof expr);
  const tokens = tokenize(expr);
  let pos = 0;

  const peek  = () => pos < tokens.length ? tokens[pos] : null;
  const eat   = () => { if (pos >= tokens.length) throw new Error('Unexpected end of input'); return tokens[pos++]; };

  // Grammar (precedence low→high):
  //   add   → mul   (('+' | '-') mul)*
  //   mul   → unary (('*' | '/' | '%') unary)*
  //   unary → ('+' | '-') unary | power
  //   power → primary ('^' unary)?        ← right-associative via unary recursion
  //   primary → NUM | NAME | NAME '(' args ')' | '(' add ')'

  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const tok = peek();
      if (!tok || tok.type !== 'op' || (tok.value !== '+' && tok.value !== '-')) break;
      eat();
      const right = parseMul();
      left = tok.value === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.type !== 'op' || !['*', '/', '%'].includes(tok.value)) break;
      eat();
      const right = parseUnary();
      if      (tok.value === '*') left = left * right;
      else if (tok.value === '/') left = left / right;
      else                        left = left % right;
    }
    return left;
  }

  function parseUnary() {
    const tok = peek();
    if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      eat();
      const val = parseUnary();
      return tok.value === '-' ? -val : val;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    const tok = peek();
    if (tok && tok.type === 'op' && tok.value === '^') {
      eat();
      return Math.pow(base, parseUnary()); // right-assoc: unary recurses back into power
    }
    return base;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of input');

    if (tok.type === 'num') {
      eat();
      return tok.value;
    }

    if (tok.type === 'name') {
      eat();
      const name = tok.value;
      const next = peek();
      if (next && next.type === 'lparen') {
        eat(); // '('
        const args = [];
        if (peek() && peek().type !== 'rparen') {
          args.push(parseAdd());
          while (peek() && peek().type === 'comma') {
            eat();
            args.push(parseAdd());
          }
        }
        if (!peek() || peek().type !== 'rparen') throw new Error("Expected ')'");
        eat();
        if (!hasOwn(FUNCTIONS, name)) throw new Error(`Unknown function: '${name}'`);
        return FUNCTIONS[name](args);
      }
      if (hasOwn(CONSTANTS, name)) return CONSTANTS[name];
      throw new Error(`Unknown name: '${name}'`);
    }

    if (tok.type === 'lparen') {
      eat();
      const val = parseAdd();
      if (!peek() || peek().type !== 'rparen') throw new Error("Expected ')'");
      eat();
      return val;
    }

    throw new Error(`Unexpected token: '${tok.value}'`);
  }

  const result = parseAdd();
  if (pos < tokens.length) throw new Error(`Unexpected token: '${tokens[pos].value}'`);
  return result;
}
