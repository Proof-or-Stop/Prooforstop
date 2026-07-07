export default function interpolate(template, context) {
  let output = "";

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];

    if (char === "\\") {
      const next = template[index + 1];

      if (next === "{" || next === "}" || next === "\\") {
        output += next;
        index += 1;
        continue;
      }

      throw new Error("Invalid escape sequence");
    }

    if (char === "{") {
      const closeIndex = template.indexOf("}", index + 1);

      if (closeIndex === -1) {
        throw new Error("Unterminated placeholder");
      }

      const name = template.slice(index + 1, closeIndex);

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error("Invalid placeholder");
      }

      if (!Object.prototype.hasOwnProperty.call(context, name)) {
        throw new Error("Missing context value");
      }

      output += String(context[name]);
      index = closeIndex;
      continue;
    }

    if (char === "}") {
      throw new Error("Stray closing brace");
    }

    output += char;
  }

  return output;
}
