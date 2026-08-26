import fs from 'node:fs';

/**
 * Read a configuration value directly from the environment or from Docker's
 * conventional NAME_FILE secret path. A non-empty direct value always wins.
 */
export function readEnvOrFile(name, { env = process.env, required = false } = {}) {
  const direct = typeof env[name] === 'string' ? env[name] : '';
  if (direct !== '') return direct;

  const fileName = `${name}_FILE`;
  const filePath = typeof env[fileName] === 'string' ? env[fileName].trim() : '';
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/, '');
    } catch (err) {
      throw new Error(`config: cannot read ${fileName}: ${err.message}`);
    }
  }

  if (required) throw new Error(`config: ${name} or ${fileName} is required`);
  return '';
}
