import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import { fileURLToPath } from "node:url";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import {
  attachCommand,
  createTmuxSessionsService,
} from "../../src/backend/tmux-sessions.js";
import { tmuxServiceState } from "../../src/backend/service-state.js";
import { DEFAULT_CONFIG } from "../../src/backend/option-catalog.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

const HOSTS = [
  {
    id: 1,
    userId: "user-1",
    name: "web-1",
    ip: "10.0.0.1",
    port: 22,
    username: "deploy",
    tags: null,
    folder: null,
    authType: "ssh",
  },
];

/** A stream look-alike that records what the service writes into the PTY. */
function fakeStream(): { written: string[]; asClient: unknown } {
  const written: string[] = [];
  return {
    written,
    asClient: { write: (data: string) => void written.push(data) },
  };
}

/**
 * A stream bound to an ssh2 client, like a real ClientChannel: the service
 * reads `stream._client` to remember generated names, and the same client
 * object reaches waitForSession.
 */
function fakeStreamWithClient(): {
  written: string[];
  asClient: unknown;
  client: unknown;
} {
  const written: string[] = [];
  const client = {
    exec(
      _command: string,
      callback: (err: Error | null, stream?: unknown) => void,
    ) {
      const events = new Map<string, Array<(...args: unknown[]) => void>>();
      const on = (event: string, listener: (...args: unknown[]) => void) => {
        events.set(event, [...(events.get(event) ?? []), listener]);
      };
      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of events.get(event) ?? []) listener(...args);
      };
      callback(null, { on, stderr: { on } });
      setTimeout(() => emit("close", 0), 0);
    },
  };
  return {
    written,
    asClient: {
      _client: client,
      write: (data: string) => void written.push(data),
    },
    client,
  };
}

describe("attachCommand", () => {
  // The whole command is wrapped by withTmuxPath into /bin/sh -c '...', so
  // the inner quotes come back shell-escaped; assert on escaped fragments.
  it("creates the session, sets the options, attaches and closes the shell", () => {
    const command = attachCommand(DEFAULT_CONFIG, undefined, "web-1");
    expect(command).toContain("new-session -d -s ");
    expect(command).toContain("=web-1");
    expect(command).toContain("history-limit 50000");
    expect(command).toContain("attach-session -t ");
    expect(command.endsWith("&& exit\r")).toBe(true);
    expect(command).toContain("/bin/sh -c");
  });

  it("attaches to an existing session without creating one", () => {
    const command = attachCommand(DEFAULT_CONFIG, "shared", undefined);
    expect(command).not.toContain("new-session");
    expect(command).toContain("=shared");
    expect(command).toContain("mouse on");
  });
});

describe("tmux.sessions service", () => {
  let db: TestDb;
  let mock: MockPluginContext;

  beforeEach(async () => {
    db = await createTestDb(pluginDir);
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run("user-1", "user-1");
    let router: Router | null = null;
    mock = createMockCtx({
      pluginId: manifest.id,
      manifest,
      capabilities: manifest.capabilities,
      db: db.database,
      router: () => (router = express.Router()),
      permissions: ["tmux-configuration.use", "tmux-configuration.sessions"],
      hosts: HOSTS,
      shareableUsers: [{ id: "user-1", username: "alice" }],
    });
    mock.setActor("user-1");
    tmuxServiceState.provided = false;
    tmuxServiceState.conflictWith = null;
    await activate(mock.ctx);
  });

  afterEach(() => {
    db.close();
  });

  it("is provided on activation when no other plugin holds the service", () => {
    expect(mock.services.has("tmux.sessions")).toBe(true);
    expect(tmuxServiceState.provided).toBe(true);
  });

  it("writes the host's effective options at session creation", async () => {
    await mock.ctx.settings.setHost(1, "historyLimit", 123456);
    await mock.ctx.settings.setHost(1, "mouse", "off");

    const service = createTmuxSessionsService(mock.ctx);
    const stream = fakeStream();
    await service.attachOrCreate(stream.asClient, undefined, "build", 1);

    expect(stream.written).toHaveLength(1);
    expect(stream.written[0]).toContain("new-session -d -s ");
    expect(stream.written[0]).toContain("history-limit 123456");
    expect(stream.written[0]).toContain("=build");
    expect(stream.written[0]).toContain("mouse off");
  });

  it("falls back to the catalog defaults without a host id", async () => {
    const service = createTmuxSessionsService(mock.ctx);
    const stream = fakeStream();
    await service.attachOrCreate(
      stream.asClient,
      undefined,
      "adhoc",
      undefined,
    );
    expect(stream.written[0]).toContain("history-limit 50000");
  });

  it("names the session after the host's pattern, over the suggested name", async () => {
    await mock.ctx.settings.setHost(
      1,
      "sessionNamePattern",
      "termix-{user}-{host}",
    );

    const service = createTmuxSessionsService(mock.ctx);
    const stream = fakeStream();
    await service.attachOrCreate(stream.asClient, undefined, "termix-1-abc", 1);

    expect(stream.written[0]).toContain("termix-user-1-web-1");
    expect(stream.written[0]).not.toContain("termix-1-abc");
  });

  it("waitForSession answers the generated name the terminal does not know", async () => {
    await mock.ctx.settings.setHost(1, "sessionNamePattern", "{user}-{hostId}");

    const service = createTmuxSessionsService(mock.ctx);
    const stream = fakeStreamWithClient();
    // The stream carries its ssh2 client, like a real ClientChannel would.
    const client = (stream.asClient as { _client: unknown })._client;
    await service.attachOrCreate(stream.asClient, undefined, "termix-1-abc", 1);
    expect(stream.written[0]).toContain("user-1-1");

    // The terminal still waits for its own suggested name; the service
    // resolves it to the generated one.
    const confirmed = await service.waitForSession(client, "termix-1-abc");
    expect(confirmed).toBe("user-1-1");
  });
});

describe("tmux.sessions conflict", () => {
  let db: TestDb;
  let mock: MockPluginContext;

  beforeEach(async () => {
    db = await createTestDb(pluginDir);
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run("user-1", "user-1");
    let router: Router | null = null;
    // tmux-monitor got there first: the service is seeded, ours must yield.
    mock = createMockCtx({
      pluginId: manifest.id,
      manifest,
      capabilities: manifest.capabilities,
      db: db.database,
      router: () => (router = express.Router()),
      permissions: ["tmux-configuration.use", "tmux-configuration.sessions"],
      services: { "tmux.sessions": {} },
    });
    tmuxServiceState.provided = false;
    tmuxServiceState.conflictWith = null;
  });

  afterEach(() => {
    db.close();
  });

  it("activation yields instead of failing, and the state records the conflict", async () => {
    await activate(mock.ctx);
    expect(mock.services.has("tmux.sessions")).toBe(true);
    expect(tmuxServiceState.provided).toBe(false);
    expect(tmuxServiceState.conflictWith).not.toBeNull();
  });
});
