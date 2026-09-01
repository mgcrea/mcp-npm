#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { isConfigured, loadConfig, setupInstructions } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream in a way that fails far from its cause.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.NPM_DEBUG) console.error("[npm-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[npm-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[npm-mcp]", ...args),
};

/**
 * A config mistake should show the field messages, not forty frames of zod
 * internals.
 */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  const config = loadConfig();
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The banner is not decoration: it prints the resolved capability state, and
  // `writes=ENABLED` scrolling past is the last chance anyone has to notice
  // before an agent changes something real on npm.
  stderrLogger.warn(
    `npm-mcp connected (registry=${config.registry}, ` +
      `token=${config.tokenSource ?? "MISSING"}, otp=${config.otpMode}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"})`,
  );

  if (!isConfigured(config)) {
    stderrLogger.warn(
      "  no token — only npm_auth_status and npm_audit_dependencies are available:",
    );
    for (const line of setupInstructions(config)) stderrLogger.warn(`  ${line}`);
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[npm-mcp] fatal:\n${describeFatal(err)}`);
  process.exit(1);
});
