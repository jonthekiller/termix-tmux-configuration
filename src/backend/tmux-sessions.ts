/**
 * The "tmux.sessions" service, as ssh-terminal consumes it.
 *
 * This is the replacement for tmux-monitor's provider: same contract (v1:
 * detect, attachOrCreate, waitForSession, clients and streams as unknown),
 * but attachOrCreate reads the plugin's effective per-host configuration
 * instead of the hardcoded mouse/history-limit pair, and names new sessions
 * after the host's sessionNamePattern when one is set. The terminal resolves
 * the single unnamed provider of the service, so this only runs when
 * tmux-monitor is disabled — activate() refuses the registration otherwise
 * (the registry would refuse it anyway) and the tab shows the state.
 *
 * Naming detail that matters: the terminal calls
 * `attachOrCreate(stream, undefined, suggestedName, hostId)` and then
 * `waitForSession(conn, suggestedName)` — the *suggested* name is the
 * terminal's own hardcoded `termix-<hostId>-<ts>`, not ours. When a pattern
 * renames the session, the generated name is recorded against the SSH client
 * the stream belongs to, and waitForSession checks that record first, so the
 * terminal tracks the real session name.
 */

import type { Client, ClientChannel } from "ssh2";
import { eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  effectiveConfig,
  HOST_KEYS,
  type TmuxEffectiveConfig,
} from "./option-catalog.js";
import { perSessionArgs, shellEscape } from "./config-builder.js";
import { buildSessionName, isValidSessionName, withSuffix } from "./naming.js";
import { detectTmux, tmuxCommand, waitForTmuxSession } from "./tmux-exec.js";

/** How long a generated-name record answers waitForSession. */
const GENERATED_NAME_TTL_MS = 30_000;

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
  conn: Client | undefined,
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
    const detection = await detectTmux(conn);
    for (const session of detection.sessions) taken.add(session.name);
  }
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = withSuffix(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  return fallback;
}

export function createTmuxSessionsService(ctx: PluginContext) {
  // Generated name per SSH client, answered by waitForSession. A WeakMap so
  // a closed connection's entry goes with the client object.
  const generatedNames = new WeakMap<Client, { name: string; at: number }>();

  return {
    detect(client: unknown) {
      return detectTmux(client as Client);
    },

    async attachOrCreate(
      stream: unknown,
      name?: string,
      newName?: string,
      hostId?: number,
    ) {
      const config = await hostConfig(ctx, hostId);
      const client = (stream as ClientChannel)?._client as Client | undefined;
      if (name) {
        // Attach to an existing session, as asked.
        (stream as ClientChannel).write(attachCommand(config, name, undefined));
        return;
      }
      const sessionName = await pickName(ctx, config, newName, hostId, client);
      // A pattern rename has to be visible to the waitForSession that
      // follows, which still asks for the terminal's suggested name.
      if (client && newName && sessionName !== newName) {
        generatedNames.set(client, { name: sessionName, at: Date.now() });
      }
      (stream as ClientChannel).write(
        attachCommand(config, undefined, sessionName),
      );
    },

    async waitForSession(client: unknown, name: string) {
      const clientKey = client as Client;
      const generated = generatedNames.get(clientKey);
      const ours =
        generated && Date.now() - generated.at < GENERATED_NAME_TTL_MS
          ? generated.name
          : null;
      const target = ours ?? name;
      const confirmed = await waitForTmuxSession(clientKey, target);
      if (generated) generatedNames.delete(clientKey);
      if (!confirmed) {
        ctx.log.warn(
          `Timed out waiting for a new tmux session to appear: ${target}`,
        );
        // The terminal stores whatever comes back; the generated name is the
        // truth when it was ours, the caller's when nothing else fits.
        return ours ?? name;
      }
      return confirmed;
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
