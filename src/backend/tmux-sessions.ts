/**
 * The "tmux.sessions" service, as ssh-terminal consumes it.
 *
 * This is the replacement for tmux-monitor's provider: same contract (v1:
 * detect, attachOrCreate, waitForSession), but attachOrCreate reads the
 * plugin's effective per-host configuration instead of the hardcoded
 * mouse/history-limit pair, and names new sessions after the host's
 * sessionNamePattern when one is set. The terminal resolves the single
 * unnamed provider of the service, so this only runs when tmux-monitor is
 * disabled — activate() refuses the registration otherwise (the registry
 * would refuse it anyway) and the tab shows the state.
 *
 * Under plugin API 2 the terminal cannot hand out ssh2 objects (they do not
 * cross plugin processes): every call receives a shell handle —
 * { termixShellKey, exec(command) -> {stdout, stderr, code}, write(data) } —
 * whose termixShellKey is stable for one connection. exec answers a Promise,
 * so nothing here may use the ssh2 callback API.
 *
 * Naming detail that matters: the terminal calls
 * `attachOrCreate(shell, undefined, suggestedName, hostId)` and then
 * `waitForSession(shell, suggestedName)` — the *suggested* name is the
 * terminal's own hardcoded `termix-<hostId>-<ts>`, not ours. When a pattern
 * renames the session, the generated name is recorded against the
 * connection's termixShellKey (the handle objects differ per call), and
 * waitForSession checks that record first, so the terminal tracks the real
 * session name.
 */

import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { eq } from "drizzle-orm";
import {
  effectiveConfig,
  HOST_KEYS,
  type TmuxEffectiveConfig,
} from "./option-catalog.js";
import { perSessionArgs, shellEscape } from "./config-builder.js";
import { buildSessionName, isValidSessionName, withSuffix } from "./naming.js";
import {
  detectTmuxViaHandle,
  tmuxCommand,
  waitForTmuxSessionViaHandle,
  type TmuxShellHandle,
} from "./tmux-exec.js";
import { recordTmuxServiceCall } from "./service-state.js";

/** How long a generated-name record answers waitForSession. */
const GENERATED_NAME_TTL_MS = 30_000;

/** Bounds the generated-name map: one entry per live connection, at most. */
const GENERATED_NAME_MAX = 256;

function asShellHandle(
  client: unknown,
  options?: { allowMissingWrite?: boolean },
): TmuxShellHandle {
  const handle = client as Partial<TmuxShellHandle> | null;
  const writeOk =
    handle === null
      ? false
      : handle.write === undefined
        ? options?.allowMissingWrite === true
        : typeof handle.write === "function";
  if (
    !handle ||
    typeof handle.termixShellKey !== "string" ||
    typeof handle.exec !== "function" ||
    !writeOk
  ) {
    throw new Error(
      "tmux.sessions: the terminal passed no shell handle (plugin API 2 contract)" +
        (options?.allowMissingWrite ? " (write optional here)" : ""),
    );
  }
  return handle as TmuxShellHandle;
}

async function hostConfig(
  ctx: PluginContext,
  hostId: number | undefined,
): Promise<TmuxEffectiveConfig> {
  const stored: Record<string, unknown> = {};
  for (const key of HOST_KEYS) {
    stored[key] =
      hostId === undefined
        ? undefined
        : await ctx.settings.getHost(hostId, key);
  }
  return effectiveConfig(stored);
}

/** Termix login of the acting user, for the {user} variable. */
async function actorUsername(ctx: PluginContext): Promise<string | undefined> {
  const actor = ctx.currentActor();
  if (!actor) return undefined;
  try {
    // Same read-only lookup the totp plugin uses for account labels.
    const { users } = await ctx.db.refs<{ users: any }>();
    const drizzle = await ctx.db.client<any>();
    const rows = await drizzle
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, actor))
      .limit(1);
    if (rows[0]?.username) return rows[0].username;
  } catch {
    // Without db:core-refs the actor id stands in; still unique.
  }
  return actor;
}

async function hostIdentity(
  ctx: PluginContext,
  hostId: number | undefined,
): Promise<{ host?: string; sshUser?: string }> {
  if (hostId === undefined) return {};
  try {
    const host = await ctx.hosts.get(hostId);
    if (!host) return {};
    return { host: host.name ?? host.ip, sshUser: host.username };
  } catch {
    return {};
  }
}

/**
 * Picks the session name: the pattern's, falling back to the caller's
 * suggestion, deduplicated against the host's live sessions.
 */
async function pickName(
  ctx: PluginContext,
  config: TmuxEffectiveConfig,
  suggestedName: string | undefined,
  hostId: number | undefined,
  conn: TmuxShellHandle | undefined,
): Promise<string> {
  const fallback =
    suggestedName && isValidSessionName(suggestedName)
      ? suggestedName
      : `termix-${Math.random().toString(36).slice(2, 8)}`;
  if (!config.sessionNamePattern.trim()) return fallback;
  const vars = {
    hostId,
    ...(await hostIdentity(ctx, hostId)),
    user: (await actorUsername(ctx)) ?? "unknown",
  };
  const base = buildSessionName(config.sessionNamePattern, vars);
  // The generated name must not collide with a live session; -2, -3, …
  const taken = new Set<string>();
  if (conn) {
    const detection = await detectTmuxViaHandle(conn);
    for (const session of detection.sessions) taken.add(session.name);
  }
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = withSuffix(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  return fallback;
}

/** One line out of an unknown error, safe for logs and diagnostics. */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export function createTmuxSessionsService(ctx: PluginContext) {
  // Generated name per connection, answered by waitForSession. Keyed by the
  // handle's termixShellKey: the terminal builds a fresh handle object for
  // every call, but the key is stable for one connection.
  const generatedNames = new Map<string, { name: string; at: number }>();
  // Every call lands here: the terminal's session menu missing while tmux
  // sessions exist is exactly the failure nobody could see before.
  const record = (
    call: "detect" | "attachOrCreate" | "waitForSession",
    startedAt: number,
    ok: boolean,
    detail: string,
  ): void => {
    recordTmuxServiceCall({
      call,
      ms: Date.now() - startedAt,
      ok,
      detail,
    });
  };

  return {
    async detect(client: unknown) {
      const startedAt = Date.now();
      try {
        // detect only runs commands: the terminal may hand a handle without
        // write here, and refusing it would blind the session menu.
        const shell = asShellHandle(client, { allowMissingWrite: true });
        const detection = await detectTmuxViaHandle(shell, (stage, error) => {
          ctx.log.warn(
            `tmux.sessions detect: ${stage} failed: ${errorMessage(error)}`,
          );
        });
        record(
          "detect",
          startedAt,
          detection.available,
          detection.available
            ? `tmux present, ${detection.sessions.length} session(s)`
            : "tmux binary not found",
        );
        ctx.log.info(
          `tmux.sessions detect: ${detection.available ? `available, ${detection.sessions.length} session(s)` : "tmux not found"} (${Date.now() - startedAt}ms)`,
        );
        return detection;
      } catch (error) {
        record("detect", startedAt, false, errorMessage(error));
        ctx.log.warn(`tmux.sessions detect failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async attachOrCreate(
      stream: unknown,
      name?: string,
      newName?: string,
      hostId?: number,
    ) {
      const startedAt = Date.now();
      try {
        const shell = asShellHandle(stream);
        const config = await hostConfig(ctx, hostId);
        if (name) {
          // Attach to an existing session, as asked.
          record("attachOrCreate", startedAt, true, `attach to ${name}`);
          ctx.log.info(`tmux.sessions: attaching to session ${name}`);
          shell.write(attachCommand(config, name, undefined));
          return;
        }
        const sessionName = await pickName(ctx, config, newName, hostId, shell);
        // A pattern rename has to be visible to the waitForSession that
        // follows, which still asks for the terminal's suggested name.
        if (newName && sessionName !== newName) {
          if (generatedNames.size >= GENERATED_NAME_MAX) {
            const oldest = generatedNames.keys().next().value;
            if (oldest !== undefined) generatedNames.delete(oldest);
          }
          generatedNames.set(shell.termixShellKey, {
            name: sessionName,
            at: Date.now(),
          });
        }
        record(
          "attachOrCreate",
          startedAt,
          true,
          newName && sessionName !== newName
            ? `created ${sessionName} (suggested ${newName})`
            : `created ${sessionName}`,
        );
        ctx.log.info(
          `tmux.sessions: creating session ${sessionName}` +
            (newName && sessionName !== newName ? ` (suggested: ${newName})` : ""),
        );
        shell.write(attachCommand(config, undefined, sessionName));
      } catch (error) {
        record("attachOrCreate", startedAt, false, errorMessage(error));
        ctx.log.warn(
          `tmux.sessions attachOrCreate failed: ${errorMessage(error)}`,
        );
        throw error;
      }
    },

    async waitForSession(client: unknown, name: string) {
      const startedAt = Date.now();
      try {
        const shell = asShellHandle(client, { allowMissingWrite: true });
        const generated = generatedNames.get(shell.termixShellKey);
        const ours =
          generated && Date.now() - generated.at < GENERATED_NAME_TTL_MS
            ? generated.name
            : null;
        const target = ours ?? name;
        const confirmed = await waitForTmuxSessionViaHandle(shell, target);
        if (generated) generatedNames.delete(shell.termixShellKey);
        if (!confirmed) {
          ctx.log.warn(
            `Timed out waiting for a new tmux session to appear: ${target}`,
          );
          record(
            "waitForSession",
            startedAt,
            false,
            `timeout waiting for ${target}`,
          );
          // The terminal stores whatever comes back; the generated name is the
          // truth when it was ours, the caller's when nothing else fits.
          return ours ?? name;
        }
        record(
          "waitForSession",
          startedAt,
          true,
          `confirmed ${confirmed}`,
        );
        ctx.log.info(
          `tmux.sessions: session ${confirmed} confirmed (${Date.now() - startedAt}ms)`,
        );
        return confirmed;
      } catch (error) {
        record("waitForSession", startedAt, false, errorMessage(error));
        ctx.log.warn(`tmux.sessions waitForSession failed: ${errorMessage(error)}`);
        throw error;
      }
    },
  };
}

/**
 * The command written into the interactive shell: create the session if
 * needed, set this host's options on it, attach, and close the shell only
 * if tmux actually started. `-q` keeps an older tmux that lacks an option
 * from aborting the whole chain. The `=name` target is tmux's exact-match
 * syntax, so a session named like a prefix of another is never mistargeted.
 */
export function attachCommand(
  config: TmuxEffectiveConfig,
  existingSessionName: string | undefined,
  newSessionName: string | undefined,
): string {
  const name =
    existingSessionName ||
    newSessionName ||
    `termix-${Math.random().toString(36).slice(2, 8)}`;
  const parts: string[] = [];
  if (!existingSessionName) {
    parts.push(`new-session -d -s ${shellEscape(name)}`);
  }
  parts.push(perSessionArgs(config, name));
  parts.push(`attach-session -t ${shellEscape(`=${name}`)}`);
  return `${tmuxCommand(parts.join(" \\; "))} && exit\r`;
}

export type TmuxSessionsService = ReturnType<typeof createTmuxSessionsService>;
