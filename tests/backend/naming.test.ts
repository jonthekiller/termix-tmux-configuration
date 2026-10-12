import { describe, expect, it } from "vitest";
import {
  buildSessionName,
  isValidSessionName,
  sanitizeSessionName,
  withSuffix,
  SESSION_NAME_MAX,
} from "../../src/backend/naming.js";

const VARS = {
  user: "alice",
  sshUser: "deploy",
  host: "web-1",
  hostId: 42,
  now: new Date(2026, 9, 6, 14, 5, 9),
};

describe("buildSessionName", () => {
  it("fills the termix user, host and ssh user", () => {
    expect(buildSessionName("{user}-{host}", VARS)).toBe("alice-web-1");
    expect(buildSessionName("tmux-{sshUser}@{hostId}", VARS)).toBe(
      "tmux-deploy@42",
    );
  });

  it("fills date, time, datetime, timestamp, uuid and random", () => {
    expect(buildSessionName("{date}", VARS)).toBe("20261006");
    expect(buildSessionName("{time}", VARS)).toBe("140509");
    expect(buildSessionName("{datetime}", VARS)).toBe("20261006-140509");
    expect(buildSessionName("s-{timestamp}", VARS)).toMatch(/^s-[a-z0-9]+$/);
    expect(buildSessionName("s-{uuid}", VARS)).toMatch(/^s-[0-9a-f]{8}$/);
    expect(buildSessionName("s-{random}", VARS)).toMatch(/^s-[a-z0-9]{4}$/);
  });

  it("drops unknown variables and sanitizes illegal characters", () => {
    expect(buildSessionName("{nope}-x", VARS)).toBe("-x");
    expect(buildSessionName("a:b.c", VARS)).toBe("a-b-c");
  });

  it("caps the length and never returns empty", () => {
    const long = "x".repeat(SESSION_NAME_MAX + 10);
    expect(buildSessionName(long, VARS)).toHaveLength(SESSION_NAME_MAX);
    expect(buildSessionName(":.:", VARS)).toBe("---");
  });

  it("falls back to placeholders when a variable has no value", () => {
    expect(buildSessionName("{user}-{host}", {})).toBe("unknown-unknown");
  });
});

describe("sanitizeSessionName / isValidSessionName / withSuffix", () => {
  it("validates the conservative target set", () => {
    expect(isValidSessionName("termix_@1+2=3")).toBe(true);
    expect(isValidSessionName("has:colon")).toBe(false);
    expect(isValidSessionName("")).toBe(false);
    expect(isValidSessionName("x".repeat(65))).toBe(false);
  });

  it("appends -n suffixes without growing past the limit", () => {
    expect(withSuffix("web", 3)).toBe("web-3");
    const long = "y".repeat(SESSION_NAME_MAX);
    const suffixed = withSuffix(long, 12);
    expect(suffixed).toHaveLength(SESSION_NAME_MAX);
    expect(suffixed.endsWith("-12")).toBe(true);
  });

  it("sanitizes to a non-empty name", () => {
    expect(sanitizeSessionName("***")).toBe("---");
    expect(sanitizeSessionName("")).toBe("termix-session");
  });
});
