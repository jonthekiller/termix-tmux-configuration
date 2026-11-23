import { describe, expect, it } from "vitest";
import { checkFrameApp } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import * as plugin from "../../src/frontend/index.js";

/**
 * Plugin API 2 frontends run in sandboxed frames (Termix 26.11.2+): every
 * registration reaches the shell as data, and what a frame can't reach must
 * not be registered at all. This walks activate() the way the shell would
 * and fails on any frame problem.
 */
describe("frontend frame compatibility", () => {
  it("activates without frame problems", async () => {
    const manifest = manifestJson as unknown as PluginManifest;
    const { problems } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
  });
});
