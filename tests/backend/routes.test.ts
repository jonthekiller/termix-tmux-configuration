import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { Client } from "ssh2";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

const HOSTS = [
  {
    id: 1,
    userId: "user-1",
    name: "web-1",
    ip: "10.0.0.1",
    port: 22,
    username: "root",
    tags: "prod,web",
    folder: "prod",
    authType: "ssh",
  },
  {
    id: 2,
    userId: "user-1",
    name: "db-1",
    ip: "10.0.0.2",
    port: 22,
    username: "root",
    tags: "prod,db",
    folder: "prod",
    authType: "ssh",
  },
];

/**
 * An ssh2 Client look-alike whose exec answers like a Linux host with tmux
 * installed and one live session named "main".
 */
function fakeSshClient(): Client {
  return {
    exec(
      command: string,
      callback: (err: Error | null, stream?: unknown) => void,
    ) {
      const events = new Map<string, Array<(...args: unknown[]) => void>>();
      const on = (event: string, listener: (...args: unknown[]) => void) => {
        events.set(event, [...(events.get(event) ?? []), listener]);
      };
      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of events.get(event) ?? []) listener(...args);
      };
      const stream = { on, stderr: { on } };
      callback(null, stream);

      if (command.includes("list-sessions")) {
        emit("data", Buffer.from("main|2|1\n"));
      } else if (command.includes("-V")) {
        emit("data", Buffer.from("tmux 3.4\n"));
      }
      // Everything (mkdir, cat heredoc, set-option chains) succeeds.
      setTimeout(() => emit("close", 0), 0);
    },
  } as unknown as Client;
}

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;

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
    permissions: ["tmux-configuration.use"],
    hosts: HOSTS,
    sshClient: fakeSshClient(),
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe("hosts", () => {
  it("lists hosts with their effective configuration", async () => {
    const { status, body } = await request("GET", "/hosts");
    expect(status).toBe(200);
    expect(body.hosts).toHaveLength(2);
    expect(body.hosts[0]).toMatchObject({
      id: 1,
      name: "web-1",
      folder: "prod",
      enabled: false,
      config: expect.objectContaining({ historyLimit: 50000, mouse: "on" }),
    });
  });

  it("saves and resets per-host options", async () => {
    const saved = await request("PUT", "/host/1/options", {
      values: { historyLimit: 123456, mouse: "off" },
    });
    expect(saved.status).toBe(200);
    expect(await mock.ctx.settings.getHost(1, "historyLimit")).toBe(123456);
    expect(await mock.ctx.settings.getHost(1, "mouse")).toBe("off");

    const { body } = await request("GET", "/hosts");
    expect(body.hosts[0].config).toMatchObject({
      historyLimit: 123456,
      mouse: "off",
    });
  });

  it("refuses an option save with nothing in it", async () => {
    const { status } = await request("PUT", "/host/1/options", {});
    expect(status).toBe(400);
  });
});

describe("apply", () => {
  it("applies to a tag selection and records the run", async () => {
    const { status, body } = await request("POST", "/apply", {
      tag: "web",
      force: true,
    });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      hostId: 1,
      ok: true,
      reason: "applied",
      sessionsTouched: 1,
    });

    const history = await request("GET", "/history");
    expect(history.body.runs).toHaveLength(1);
    expect(history.body.runs[0]).toMatchObject({ hostId: 1, ok: true });
  });

  it("skips hosts the plugin is disabled on", async () => {
    const { body } = await request("POST", "/apply", { all: true });
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result.reason).toBe("disabled");
    }
  });

  it("applies a profile's values as the override", async () => {
    await mock.ctx.settings.setHost(1, "enableTmuxConfiguration", true);
    const created = await request("POST", "/profiles", {
      name: "hardened",
      options: { historyLimit: 999999, mouse: "off" },
    });
    expect(created.status).toBe(201);

    const profiles = await request("GET", "/profiles");
    const profile = profiles.body.profiles[0];

    const { body } = await request("POST", "/apply", {
      hostIds: [1],
      profileId: profile.id,
      force: true,
    });
    expect(body.results[0]).toMatchObject({ ok: true, hostId: 1 });
  });

  it("refuses an apply without a usable selector", async () => {
    const { status } = await request("POST", "/apply", {});
    expect(status).toBe(400);
  });
});

describe("validation", () => {
  it("rejects a malformed customOptions object", async () => {
    const errors = await mock.validateSettings("host", {
      customOptions: { "bad name": "v" },
    });
    expect(errors).toHaveProperty("customOptions");
  });
});

describe("integration", () => {
  it("reports whether this plugin drives session creation", async () => {
    const { status, body } = await request("GET", "/integration");
    expect(status).toBe(200);
    expect(typeof body.providesTmuxSessions).toBe("boolean");
    expect(body.conflictWith).toBeNull();
  });
});
