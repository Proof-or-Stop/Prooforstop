const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const hasOwn = Object.prototype.hasOwnProperty;

export default function interpolate(template, context) {
  let output = "";

  for (let i = 0; i < template.length;) {
    const ch = template[i];

    if (ch === "\\") {
      if (i + 1 >= template.length) {
        throw new Error("Invalid escape");
      }

      const next = template[i + 1];
      if (next !== "{" && next !== "}" && next !== "\\") {
        throw new Error("Invalid escape");
      }

      output += next;
      i += 2;
      continue;
    }

    if (ch === "{") {
      const end = template.indexOf("}", i + 1);
      if (end === -1) {
        throw new Error("Unterminated placeholder");
      }

      const name = template.slice(i + 1, end);
      if (!NAME_PATTERN.test(name)) {
        throw new Error("Invalid placeholder");
      }

      if (!hasOwn.call(context, name)) {
        throw new Error("Missing value");
      }

      output += String(context[name]);
      i = end + 1;
      continue;
    }

    if (ch === "}") {
      throw new Error("Stray closing brace");
    }

    output += ch;
    i += 1;
  }

  return output;
}
