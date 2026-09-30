/**
 * CodePit's own settings from the environment. Each is read as CODEPIT_<NAME>, falling back
 * to ACP_<NAME>, its name before the rename, so existing scripts and shells keep working.
 */
export function appEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`CODEPIT_${name}`] ?? env[`ACP_${name}`];
}
