import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authTokenKey, parseNpmrcToken } from "#/client/npmrc";
import { loadConfig, setupInstructions } from "#/config";
import { ABSENT_CONFIG, ABSENT_NPMRC } from "#test/helpers";

const dirs: string[] = [];

/** Written 0600, both to keep the suite quiet and to model what the docs ask for. */
const writeConfig = (path: string, body: unknown): void => {
  writeFileSync(path, JSON.stringify(body));
  chmodSync(path, 0o600);
};
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "npm-mcp-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("npmrc parsing", () => {
  it("keys auth on the registry host, with a trailing slash", () => {
    expect(authTokenKey("https://registry.npmjs.org")).toBe("//registry.npmjs.org/:_authToken");
    // A registry under a path prefix gets its own entry.
    expect(authTokenKey("https://gitlab.example.com/api/v4/packages/npm")).toBe(
      "//gitlab.example.com/api/v4/packages/npm/:_authToken",
    );
  });

  it("reads the token for the configured registry", () => {
    const npmrc = "//registry.npmjs.org/:_authToken=npm_secret\nmin-release-age=1\n";
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBe("npm_secret");
  });

  /**
   * An .npmrc routinely holds credentials for several registries. Handing a
   * private registry's token to npmjs.org — or the reverse — would leak a
   * credential to a host that was never meant to see it.
   */
  it("ignores a token belonging to a different registry", () => {
    const npmrc = "//npm.internal.example/:_authToken=internal-secret\n";
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBeUndefined();
  });

  it("skips comments and blank lines", () => {
    const npmrc = "# a comment\n\n; another\n//registry.npmjs.org/:_authToken=tok\n";
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBe("tok");
  });

  it("strips quotes npm's ini writer may have added", () => {
    const npmrc = '//registry.npmjs.org/:_authToken="quoted-tok"\n';
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBe("quoted-tok");
  });

  it("resolves npm's ${VAR} interpolation rather than sending it literally", () => {
    // Sending the literal "${NPM_TOKEN}" as a bearer produces a 401 that looks
    // nothing like its cause.
    process.env.NPM_MCP_TEST_TOKEN = "from-env";
    const npmrc = "//registry.npmjs.org/:_authToken=${NPM_MCP_TEST_TOKEN}\n";
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBe("from-env");
    delete process.env.NPM_MCP_TEST_TOKEN;
  });

  it("takes the last of duplicate keys, as npm's own ini parsing does", () => {
    const npmrc =
      "//registry.npmjs.org/:_authToken=first\n//registry.npmjs.org/:_authToken=second\n";
    expect(parseNpmrcToken(npmrc, "https://registry.npmjs.org")).toBe("second");
  });
});

describe("config precedence", () => {
  it("prefers the environment over the config file, field by field", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeConfig(configPath, { token: "from-file", allowWrites: true });

    const config = loadConfig(
      { NPM_TOKEN: "from-env", NPM_ALLOW_WRITES: "0" },
      configPath,
      ABSENT_NPMRC,
    );

    expect(config.token).toBe("from-env");
    expect(config.tokenSource).toBe("environment");
    // The whole point of merging per field: a one-off env override still wins
    // over a file that says otherwise.
    expect(config.allowWrites).toBe(false);
  });

  it("falls back to the config file for fields the environment omits", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeConfig(configPath, { token: "from-file", maxRetries: 7 });

    const config = loadConfig({}, configPath, ABSENT_NPMRC);

    expect(config.token).toBe("from-file");
    expect(config.tokenSource).toBe("file");
    expect(config.maxRetries).toBe(7);
  });

  it("falls back to ~/.npmrc last, so `npm login` alone is enough", () => {
    const dir = tempDir();
    const npmrcPath = join(dir, ".npmrc");
    writeFileSync(npmrcPath, "//registry.npmjs.org/:_authToken=npmrc-token\n");

    const config = loadConfig({}, ABSENT_CONFIG, npmrcPath);

    expect(config.token).toBe("npmrc-token");
    expect(config.tokenSource).toBe("npmrc");
  });

  it("does not read ~/.npmrc at all once an explicit token exists", () => {
    const dir = tempDir();
    const npmrcPath = join(dir, ".npmrc");
    writeFileSync(npmrcPath, "//registry.npmjs.org/:_authToken=npmrc-token\n");

    const config = loadConfig({ NPM_TOKEN: "explicit" }, ABSENT_CONFIG, npmrcPath);

    expect(config.token).toBe("explicit");
    expect(config.tokenSource).toBe("environment");
  });

  it("ignores an .npmrc entry for a registry we are not talking to", () => {
    const dir = tempDir();
    const npmrcPath = join(dir, ".npmrc");
    writeFileSync(npmrcPath, "//registry.npmjs.org/:_authToken=public-token\n");

    const config = loadConfig(
      { NPM_REGISTRY: "https://npm.internal.example" },
      ABSENT_CONFIG,
      npmrcPath,
    );

    expect(config.token).toBeUndefined();
  });

  /**
   * A typo'd key must be an error. Silently ignoring one looks exactly like
   * "that setting had no effect", which is the worst way to learn your
   * credentials came from somewhere else.
   */
  it("rejects an unknown key in the config file, naming the file", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeConfig(configPath, { allowWrite: true });

    expect(() => loadConfig({}, configPath, ABSENT_NPMRC)).toThrow(/not valid/);
  });

  it("distinguishes a malformed config file from an absent one", () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{ not json");
    chmodSync(configPath, 0o600);

    expect(() => loadConfig({}, configPath, ABSENT_NPMRC)).toThrow(/not valid JSON/);
    // An absent file contributes nothing and is not an error.
    expect(() => loadConfig({}, ABSENT_CONFIG, ABSENT_NPMRC)).not.toThrow();
  });

  it("never throws just because nothing is configured", () => {
    // Rule 2: a server that exits here shows up as a bare "Connection closed"
    // with its own explanation swallowed.
    const config = loadConfig({}, ABSENT_CONFIG, ABSENT_NPMRC);

    expect(config.token).toBeUndefined();
    expect(config.allowWrites).toBe(false);
    expect(setupInstructions(config).length).toBeGreaterThan(0);
  });

  it("does flag a contradictory OTP configuration", () => {
    expect(() => loadConfig({ NPM_OTP_MODE: "static" }, ABSENT_CONFIG, ABSENT_NPMRC)).toThrow(
      /NPM_OTP/,
    );
  });

  it("treats an empty env var as unset rather than empty", () => {
    const config = loadConfig({ NPM_TOKEN: "   " }, ABSENT_CONFIG, ABSENT_NPMRC);
    expect(config.token).toBeUndefined();
  });
});
