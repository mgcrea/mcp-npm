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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
      await execFileAsync("npm", ["pack", "--silent", "--pack-destination", destination], {
        cwd: directory,
        maxBuffer: 64 * 1024 * 1024,
      });
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
