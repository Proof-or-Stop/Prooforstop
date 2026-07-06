const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export default function interpolate(template, context) {
  let output = '';

  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];

    if (char === '\\') {
      if (i + 1 >= template.length) {
        throw new Error('Invalid escape');
      }

      const escaped = template[i + 1];
      if (escaped !== '{' && escaped !== '}' && escaped !== '\\') {
        throw new Error('Invalid escape');
      }

      output += escaped;
      i += 1;
      continue;
    }

    if (char === '{') {
      const closeIndex = template.indexOf('}', i + 1);
      if (closeIndex === -1) {
        throw new Error('Unterminated placeholder');
      }

      const name = template.slice(i + 1, closeIndex);
      if (!NAME_PATTERN.test(name)) {
        throw new Error('Invalid placeholder');
      }

      if (!Object.prototype.hasOwnProperty.call(context, name)) {
        throw new Error('Missing variable');
      }

      output += String(context[name]);
      i = closeIndex;
      continue;
    }

    if (char === '}') {
      throw new Error('Stray closing brace');
    }

    output += char;
  }

  return output;
}
