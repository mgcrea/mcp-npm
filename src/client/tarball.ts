// Building the thing `npm publish` sends.
//
// The tarball is produced by shelling out to `npm pack` rather than being
// assembled here. That is deliberate: which files end up inside is decided by
// `files`, `.npmignore`, `.gitignore` and a list of always/never-included
// special cases that npm has accumulated over a decade. Reimplementing that
// would produce a tarball that is subtly not what `npm publish` would have
// sent, and the difference would only surface after it was published.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { PreconditionError } from "#/client/errors";

const execFileAsync = promisify(execFile);

export type PackedTarball = {
  manifest: Record<string, unknown>;
  name: string;
  version: string;
  /** Base64 tarball bytes, as npm's `_attachments` wants them. */
  data: string;
  byteLength: number;
  /** sha512 subresource integrity, the modern field. */
  integrity: string;
  /** sha1 hex. Legacy, but older clients still read it. */
  shasum: string;
  filename: string;
};

/**
 * The tarball basename npm uses: the scope is dropped, so `@mgcrea/mcp-npm`
 * at 1.0.0 is `mcp-npm-1.0.0.tgz`. It appears both in `_attachments` and in the
 * `dist.tarball` URL, and the two must agree or the registry stores a package
 * whose tarball link 404s.
 */
export const tarballFilename = (name: string, version: string): string => {
  const unscoped = name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
  return `${unscoped}-${version}.tgz`;
};

/** The canonical tarball URL for a published version. */
export const tarballUrl = (registry: string, name: string, version: string): string =>
  `${registry.replace(/\/+$/, "")}/${name}/-/${tarballFilename(name, version)}`;

export type PackOptions = {
  /** Injected in tests so nothing shells out. */
  exec?: (dir: string, destination: string) => Promise<void>;
  /** An explicit npm CLI path, from NPM_BIN. Wins over every probe below. */
  npmBin?: string | undefined;
};

/** How npm's CLI will be invoked, and which rule found it (quoted in errors). */
export type NpmCli = { command: string; args: string[]; source: string };

export type ResolveNpmCliOptions = {
  npmBin?: string | undefined;
  /** The Node running this process. Overridden in tests. */
  execPath?: string;
  exists?: (path: string) => boolean;
};

/**
 * Find npm's CLI, and prefer running it with the Node we are already inside.
 *
 * Spawning bare `npm` is what broke: it resolves through PATH, and a server
 * spawned by a GUI app inherits launchd's minimal `/usr/bin:/bin` rather than a
 * shell PATH, so npm is simply not there. It works from a terminal-launched
 * server, which is exactly why it shipped.
 *
 * The obvious repair — an absolute path to the `npm` shim — does not work
 * either, and fails in a way that looks like a different bug. That shim is a
 * `#!/usr/bin/env node` script, and there is no `node` on that PATH to run it,
 * so `spawn npm ENOENT` merely becomes `env: node: No such file or directory`.
 *
 * So resolve npm's `npm-cli.js` and hand it to `process.execPath`. That Node
 * provably exists: we are executing inside it. No shebang, no PATH lookup.
 */
export const resolveNpmCli = (opts: ResolveNpmCliOptions = {}): NpmCli => {
  const execPath = opts.execPath ?? process.execPath;
  const exists = opts.exists ?? existsSync;
  const npmBin = opts.npmBin?.trim();

  if (npmBin) {
    // Validate a PATH-like value here rather than letting it fail at spawn.
    // A bad `.js` target spawns *successfully* — node exists — and then dies
    // with a MODULE_NOT_FOUND stack dump that names node's loader internals
    // instead of the setting the user got wrong. A bare command name is left
    // alone: it is meant to be resolved through PATH, so an existence check on
    // it would be meaningless.
    if (npmBin.includes("/") && !exists(npmBin)) {
      throw new PreconditionError(`NPM_BIN points at ${npmBin}, which does not exist.`, {
        npmBin,
        remedy:
          "Set NPM_BIN to npm's `npm-cli.js` (usually " +
          "`<node prefix>/lib/node_modules/npm/bin/npm-cli.js`) or to an npm executable, or " +
          "unset it to let this server find npm beside the Node it is running under.",
      });
    }
    // A `.js` target is a CLI entrypoint, not an executable — it needs a Node
    // in front of it for the same shebang reason as everything else here.
    return npmBin.endsWith(".js")
      ? { command: execPath, args: [npmBin], source: "NPM_BIN" }
      : { command: npmBin, args: [], source: "NPM_BIN" };
  }

  const base = dirname(execPath);
  const candidates = [
    // Standard unix layout: node in bin/, npm beside it under lib/.
    join(base, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // An app bundle that ships npm as a sibling of the node binary.
    join(base, "npm", "bin", "npm-cli.js"),
    join(base, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return { command: execPath, args: [candidate], source: candidate };
  }

  // Last resort, and the behaviour every terminal-launched install already has.
  // If PATH has npm, nothing above needed to be true.
  return { command: "npm", args: [], source: "PATH" };
};

/**
 * PATH for the packing child, with the running Node's directory prepended.
 *
 * `npm pack` runs the package's own prepack/prepare scripts, so this child is
 * about to execute the project's build. Under a bare `/usr/bin:/bin` that build
 * dies the moment it invokes `node`, `tsc` or a package manager — the very next
 * failure after the one being fixed, and indistinguishable from it to anyone
 * reading the error.
 */
export const packEnv = (
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const execDir = dirname(execPath);
  const current = env.PATH ?? "";
  const alreadyThere = current.split(delimiter).includes(execDir);
  return { ...env, PATH: alreadyThere ? current : `${execDir}${delimiter}${current}` };
};

/**
 * Turn a failed spawn into something that names the actual problem.
 *
 * A bare `spawn npm ENOENT` says nothing about which of three things to fix,
 * and the least guessable one — that this process has a PATH the user has never
 * seen, because a GUI-spawned server does not inherit a shell's — is invisible
 * unless it is printed. So print it.
 */
const npmMissing = (err: unknown, cli: NpmCli): unknown => {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code !== "ENOENT") return err;
  return new PreconditionError(
    `Could not run npm to pack the package: ${cli.command} was not found.`,
    {
      tried: cli.source,
      command: cli.command,
      path: process.env.PATH ?? "",
      node: process.execPath,
      remedy:
        "npm's CLI could not be located. A server started by a GUI app inherits a minimal PATH " +
        "(often just /usr/bin:/bin) rather than your shell's, so an npm installed by Homebrew or " +
        "a version manager is not on it. Set NPM_BIN to npm's `npm-cli.js` (or to an npm " +
        "executable) for this server, or start the server from a shell where `npm` resolves.",
    },
  );
};

/**
 * Pack a directory into an npm tarball and read it back.
 *
 * `npm pack` runs the package's own `prepack`/`prepare` scripts, exactly as a
 * real publish would — which is what makes the output trustworthy, and also
 * means this executes the project's build. That is worth knowing before
 * pointing it at a directory you have not read.
 */
export const packDirectory = async (
  directory: string,
  opts: PackOptions = {},
): Promise<PackedTarball> => {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;

  const name = typeof manifest.name === "string" ? manifest.name : undefined;
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  if (!name || !version) {
    throw new Error(
      `${join(directory, "package.json")} needs both a "name" and a "version" to be published.`,
    );
  }

  const destination = mkdtempSync(join(tmpdir(), "npm-mcp-pack-"));
  try {
    if (opts.exec) {
      await opts.exec(directory, destination);
    } else {
      const cli = resolveNpmCli({ npmBin: opts.npmBin });
      try {
        await execFileAsync(
          cli.command,
          [...cli.args, "pack", "--silent", "--pack-destination", destination],
          { cwd: directory, env: packEnv(), maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (err) {
        throw npmMissing(err, cli);
      }
    }

    const filename = tarballFilename(name, version);
    const bytes = readFileSync(join(destination, filename));

    return {
      manifest,
      name,
      version,
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      filename,
    };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
};

/**
 * The document `PUT /{pkg}` expects: the version manifest, the dist-tag it
 * should answer to, and the tarball itself base64'd under `_attachments`.
 *
 * npm has no separate upload step — the bytes travel inside the metadata
 * document, which is why a publish body is the size of the package.
 */
export const buildPublishBody = (
  packed: PackedTarball,
  registry: string,
  tag: string,
  access: string | undefined,
): Record<string, unknown> => ({
  _id: packed.name,
  name: packed.name,
  ...(typeof packed.manifest.description === "string"
    ? { description: packed.manifest.description }
    : {}),
  "dist-tags": { [tag]: packed.version },
  versions: {
    [packed.version]: {
      ...packed.manifest,
      _id: `${packed.name}@${packed.version}`,
      dist: {
        integrity: packed.integrity,
        shasum: packed.shasum,
        tarball: tarballUrl(registry, packed.name, packed.version),
      },
    },
  },
  ...(access ? { access } : {}),
  _attachments: {
    [packed.filename]: {
      content_type: "application/octet-stream",
      data: packed.data,
      length: packed.byteLength,
    },
  },
});
