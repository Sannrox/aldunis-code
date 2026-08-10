/**
 * Desktop helpers launched with `process.execPath` must run Electron as Node.
 *
 * Under the packaged (or `electron .`) shell, `process.execPath` is the Electron
 * binary — not system Node. Spawning that path without ELECTRON_RUN_AS_NODE=1
 * starts a second GUI Aldunis/Electron process, which shows in the macOS Dock
 * until the single-instance lock makes it quit.
 */
export function withElectronRunAsNode(
  env: NodeJS.ProcessEnv,
  electronVersion: string | undefined = process.versions.electron,
): NodeJS.ProcessEnv {
  return electronVersion ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : { ...env };
}

/** String-map form for MCP server env blocks (Codex TOML / Claude mcp-config / ACP). */
export function electronMcpEnvironment(
  env: Record<string, string> = {},
  electronVersion: string | undefined = process.versions.electron,
): Record<string, string> {
  if (!electronVersion) return { ...env };
  return { ...env, ELECTRON_RUN_AS_NODE: "1" };
}
