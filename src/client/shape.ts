// npm's read endpoints are built for package managers, not context windows.
//
// A full packument for a popular package runs to hundreds of kilobytes: it
// carries the rendered README, a `users` map of everyone who ever starred it,
// and a complete metadata document per published version. `lodash` alone is
// several megabytes. Returning any of that raw would fill the context window
// with material no one asked for, so every list-shaped tool summarizes and the
// `get_*` tools return the fields that answer the question.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Present and meaningful. npm sends `environment: null` rather than omitting
 * the key when none is set, so checking for undefined alone leaks a null into
 * every summary.
 */
const set = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Registry bookkeeping that means nothing outside npm's own storage layer.
 * `_attachments` in particular is the base64 tarball — returning it once would
 * be a multi-megabyte answer to "what version is this".
 */
const INTERNAL_KEYS = [
  "_id",
  "_rev",
  "_npmUser",
  "_npmVersion",
  "_nodeVersion",
  "_hasShrinkwrap",
  "_npmOperationalInternal",
  "_attachments",
  "gitHead",
  "directories",
  "readme",
  "readmeFilename",
  "users",
];

export const stripInternal = (doc: Rec): Rec => {
  const out: Rec = {};
  for (const [key, value] of Object.entries(doc)) {
    if (INTERNAL_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
};

/**
 * One published version, trimmed to what a caller actually reads.
 *
 * `dist` keeps only `tarball`, `integrity` and `unpackedSize`: the signature
 * blocks and legacy `shasum` are large and nobody reads them out of a tool.
 */
export const summarizeVersion = (version: Rec): Rec => {
  const dist = isRecord(version.dist) ? version.dist : undefined;
  return {
    name: version.name,
    version: version.version,
    ...(str(version.description) ? { description: version.description } : {}),
    ...(version.deprecated !== undefined ? { deprecated: version.deprecated } : {}),
    ...(version.license !== undefined ? { license: version.license } : {}),
    ...(isRecord(version.dependencies) ? { dependencies: version.dependencies } : {}),
    ...(isRecord(version.peerDependencies) ? { peerDependencies: version.peerDependencies } : {}),
    ...(isRecord(version.engines) ? { engines: version.engines } : {}),
    ...(version.bin !== undefined ? { bin: version.bin } : {}),
    ...(dist
      ? {
          dist: {
            ...(str(dist.tarball) ? { tarball: dist.tarball } : {}),
            ...(str(dist.integrity) ? { integrity: dist.integrity } : {}),
            ...(num(dist.unpackedSize) ? { unpackedSize: dist.unpackedSize } : {}),
          },
        }
      : {}),
  };
};

export type PackumentSummary = {
  name: unknown;
  "dist-tags": unknown;
  version_count: number;
  versions: string[];
  latest?: Rec;
  created?: unknown;
  modified?: unknown;
  description?: unknown;
  license?: unknown;
  homepage?: unknown;
  repository?: unknown;
  maintainers?: unknown;
  deprecated?: unknown;
};

/**
 * A packument reduced to the shape of the questions people ask it: what
 * versions exist, which is current, and what does the current one look like.
 *
 * The version *list* is names only. Expanding every version document is what
 * makes a raw packument unusable, and a caller who wants one can name it —
 * npm_get_package_version exists for exactly that.
 *
 * `time` collapses to `created`/`modified`: the full map holds one ISO
 * timestamp per version and grows without bound.
 */
export const summarizePackument = (packument: unknown): unknown => {
  if (!isRecord(packument)) return packument;
  const versions = isRecord(packument.versions) ? packument.versions : {};
  const names = Object.keys(versions);
  const time = isRecord(packument.time) ? packument.time : undefined;
  const distTags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {};
  const latestName = str(distTags.latest);
  const latest = latestName && isRecord(versions[latestName]) ? versions[latestName] : undefined;

  return {
    name: packument.name,
    "dist-tags": packument["dist-tags"],
    version_count: names.length,
    versions: names,
    ...(latest ? { latest: summarizeVersion(latest) } : {}),
    ...(time?.created !== undefined ? { created: time.created } : {}),
    ...(time?.modified !== undefined ? { modified: time.modified } : {}),
    ...(packument.description !== undefined ? { description: packument.description } : {}),
    ...(packument.license !== undefined ? { license: packument.license } : {}),
    ...(packument.homepage !== undefined ? { homepage: packument.homepage } : {}),
    ...(packument.repository !== undefined ? { repository: packument.repository } : {}),
    ...(packument.maintainers !== undefined ? { maintainers: packument.maintainers } : {}),
  };
};

/** `{version: publishedAt}` for every version, from the packument's `time` map. */
export const summarizeVersionTimes = (packument: unknown): Rec => {
  if (!isRecord(packument) || !isRecord(packument.time)) return {};
  const out: Rec = {};
  for (const [key, value] of Object.entries(packument.time)) {
    if (key === "created" || key === "modified") continue;
    out[key] = value;
  }
  return out;
};

/**
 * One search hit.
 *
 * npm's search result is far richer than its docs suggest — each hit carries a
 * `score` object with three sub-scores, a `searchScore`, the full maintainer
 * list and a duplicate `sanitized_name`. None of it survives here: the ranking
 * is already expressed by the order, so repeating it per hit is pure cost.
 */
export const summarizeSearchHit = (hit: unknown): unknown => {
  if (!isRecord(hit)) return hit;
  const pkg = isRecord(hit.package) ? hit.package : {};
  const links = isRecord(pkg.links) ? pkg.links : {};
  const publisher = isRecord(pkg.publisher) ? pkg.publisher : undefined;
  const downloads = isRecord(hit.downloads) ? hit.downloads : undefined;

  return {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.description !== undefined ? { description: pkg.description } : {}),
    ...(pkg.date !== undefined ? { date: pkg.date } : {}),
    ...(publisher?.username !== undefined ? { publisher: publisher.username } : {}),
    ...(links.npm !== undefined ? { url: links.npm } : {}),
    ...(links.repository !== undefined ? { repository: links.repository } : {}),
    ...(downloads?.weekly !== undefined ? { weekly_downloads: downloads.weekly } : {}),
    ...(hit.dependents !== undefined ? { dependents: hit.dependents } : {}),
  };
};

export const summarizeSearchResponse = (response: unknown): unknown => {
  if (!isRecord(response)) return response;
  const objects = Array.isArray(response.objects) ? response.objects : [];
  return {
    total: response.total,
    count: objects.length,
    results: objects.map(summarizeSearchHit),
  };
};

/**
 * One security advisory.
 *
 * `references` is dropped deliberately: it is a newline-joined markdown link
 * list that runs to about 1.5 KB per advisory, so a dependency set of any size
 * would be mostly URLs. `url` already points at the canonical write-up.
 */
export const summarizeAdvisory = (advisory: unknown): unknown => {
  if (!isRecord(advisory)) return advisory;
  const cvss = isRecord(advisory.cvss) ? advisory.cvss : undefined;
  return {
    id: advisory.id,
    title: advisory.title,
    severity: advisory.severity,
    vulnerable_versions: advisory.vulnerable_versions,
    ...(advisory.patched_versions !== undefined
      ? { patched_versions: advisory.patched_versions }
      : {}),
    ...(cvss?.score !== undefined ? { cvss_score: cvss.score } : {}),
    ...(Array.isArray(advisory.cwe) ? { cwe: advisory.cwe } : {}),
    ...(advisory.url !== undefined ? { url: advisory.url } : {}),
  };
};

export const summarizeAdvisoryResponse = (response: unknown): unknown => {
  if (!isRecord(response)) return response;
  const out: Rec = {};
  let total = 0;
  for (const [name, advisories] of Object.entries(response)) {
    if (!Array.isArray(advisories)) continue;
    out[name] = advisories.map(summarizeAdvisory);
    total += advisories.length;
  }
  // An empty object is an ambiguous answer to "is anything vulnerable" — it
  // reads equally as "nothing found" and "the call did not work". Say which.
  return { vulnerable_packages: Object.keys(out).length, advisory_count: total, advisories: out };
};

/**
 * A trusted-publisher configuration, flattened out of npm's claims map.
 *
 * npm stores provider-specific claims under keys that mirror each provider's
 * OIDC vocabulary (`repository`, `project_path`, `oidc.circleci.com/org-id`),
 * which is precise and unreadable. This renders one flat shape across all three
 * so a caller can compare two configs without knowing whose vocabulary is whose.
 */
export const summarizeTrustConfig = (config: unknown): unknown => {
  if (!isRecord(config)) return config;
  const claims = isRecord(config.claims) ? config.claims : {};
  const workflowRef = claims.workflow_ref ?? claims.ci_config_ref_uri;
  const workflow = isRecord(workflowRef) ? workflowRef.file : workflowRef;
  return {
    id: config.id,
    provider: config.type,
    ...(set(claims.repository) ? { repository: claims.repository } : {}),
    ...(set(claims.project_path) ? { project_path: claims.project_path } : {}),
    ...(set(workflow) ? { workflow } : {}),
    ...(set(claims.environment) ? { environment: claims.environment } : {}),
    ...(config.type === "circleci" ? { claims } : {}),
    ...(config.permissions !== undefined ? { permissions: config.permissions } : {}),
  };
};

/** A token list entry. The `token` field is already redacted by npm. */
export const summarizeToken = (token: unknown): unknown => {
  if (!isRecord(token)) return token;
  return {
    key: token.key,
    token: token.token,
    ...(token.name !== undefined ? { name: token.name } : {}),
    ...(token.description !== undefined ? { description: token.description } : {}),
    readonly: token.readonly,
    ...(token.bypass_2fa !== undefined ? { bypass_2fa: token.bypass_2fa } : {}),
    ...(Array.isArray(token.cidr) && token.cidr.length > 0 ? { cidr: token.cidr } : {}),
    ...(token.expiry !== undefined ? { expiry: token.expiry } : {}),
    ...(token.created !== undefined ? { created: token.created } : {}),
  };
};

/**
 * The `/-/npm/v1/*` family paginates with a cursor carried in the response.
 * Keeping `urls.next` is what makes the next page reachable at all — dropping
 * it is the easy mistake here.
 */
export const summarizePaginated = (
  response: unknown,
  summarize: (item: unknown) => unknown,
): unknown => {
  if (!isRecord(response)) return response;
  const objects = Array.isArray(response.objects) ? response.objects : [];
  const urls = isRecord(response.urls) ? response.urls : undefined;
  const next = urls && typeof urls.next === "string" ? urls.next : undefined;
  return {
    count: objects.length,
    ...(response.total !== undefined ? { total: response.total } : {}),
    objects: objects.map(summarize),
    ...(next !== undefined ? { next } : {}),
  };
};
