// Reading the token out of `~/.npmrc` is what makes this server work with zero
// configuration: anyone who has run `npm login` already has one there. It is
// the last layer of the merge, so an explicit NPM_TOKEN or a config file always
// wins.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where npm keeps the per-user config. `NPM_CONFIG_USERCONFIG` is npm's own
 * override and is honoured here for the same reason npm honours it: a project
 * that redirects it would otherwise have this server reading a different file
 * than every `npm` command run beside it.
 */
export const resolveNpmrcPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = env.NPM_CONFIG_USERCONFIG?.trim();
  return explicit ? expandTilde(explicit) : join(homedir(), ".npmrc");
};

/**
 * The `//host/path/:_authToken=` key npm writes for a registry.
 *
 * npm keys auth on the registry URL with the scheme stripped and a trailing
 * slash, so `https://registry.npmjs.org` becomes `//registry.npmjs.org/`. Any
 * path is kept, because a registry served under a path prefix
 * (`https://gitlab.example.com/api/v4/packages/npm`) gets its own entry.
 */
export const authTokenKey = (registry: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `//${url.host}${path}/:_authToken`;
};

/**
 * Read the auth token for one registry out of an `.npmrc` document.
 *
 * Scoped to the registry on purpose. An `.npmrc` routinely holds credentials
 * for several registries at once, and handing a private registry's token to
 * npmjs.org — or the reverse — would leak a credential to a host that was never
 * meant to see it. Matching only the exact key is what prevents that.
 */
export const parseNpmrcToken = (contents: string, registry: string): string | undefined => {
  const key = authTokenKey(registry);
  if (key === undefined) return undefined;

  // Last one wins, matching npm's own ini parsing: a later line overrides an
  // earlier one with the same key.
  let found: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#") || trimmedLine.startsWith(";")) continue;
    const eq = trimmedLine.indexOf("=");
    if (eq === -1) continue;
    if (trimmedLine.slice(0, eq).trim() !== key) continue;

    let value = trimmedLine.slice(eq + 1).trim();
    // npm's ini writer quotes values that need it; strip a matched pair.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // `${NPM_TOKEN}` is npm's own env interpolation. Resolve it rather than
    // sending the literal string as a bearer token, which fails as a 401 that
    // looks nothing like its cause.
    const envRef = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (envRef) value = process.env[envRef[1] as string]?.trim() ?? "";
    if (value) found = value;
  }
  return found;
};

/** Read the token for `registry` from the user's `.npmrc`, or undefined. */
export const readNpmrcToken = (registry: string, path: string): string | undefined => {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    // An absent or unreadable .npmrc contributes nothing. Unlike the config
    // file, this one is not something the user pointed us at, so a failure to
    // read it is not worth failing startup over.
    return undefined;
  }
  return parseNpmrcToken(contents, registry);
};
