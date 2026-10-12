import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  effectiveConfig,
  validateJsonFields,
} from "../../src/backend/option-catalog.js";
import {
  buildConfigFile,
  CONFIG_FILE_PATH,
  perSessionArgs,
  pushFileCommand,
  shellEscape,
  tmuxConfQuote,
} from "../../src/backend/config-builder.js";

describe("effectiveConfig", () => {
  it("answers the catalog defaults for nothing stored", () => {
    expect(effectiveConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(effectiveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("merges stored values over the defaults", () => {
    expect(
      effectiveConfig({ historyLimit: 100000, mouse: "off" }),
    ).toMatchObject({ historyLimit: 100000, mouse: "off", exitEmpty: "on" });
  });

  it("clamps historyLimit and drops mistyped keys", () => {
    expect(effectiveConfig({ historyLimit: 5 }).historyLimit).toBe(1000);
    expect(effectiveConfig({ historyLimit: "big" }).historyLimit).toBe(
      DEFAULT_CONFIG.historyLimit,
    );
    // An unknown custom option name never reaches the config.
    expect(
      effectiveConfig({
        customOptions: { "valid-name": "v", "bad name;": "v" },
      }).customOptions,
    ).toEqual({ "valid-name": "v" });
    expect(
      effectiveConfig({ environment: { GOOD_VAR: "1", "bad-var": "1" } })
        .environment,
    ).toEqual({ GOOD_VAR: "1" });
  });
});

describe("validateJsonFields", () => {
  it("accepts valid objects and passes through undefined", () => {
    expect(validateJsonFields({ customOptions: { a: "b" } })).toEqual({});
    expect(validateJsonFields({ environment: { PATH: 1 } })).toEqual({});
    expect(validateJsonFields({})).toEqual({});
  });

  it("rejects non-objects, arrays and bad names", () => {
    expect(validateJsonFields({ customOptions: "x" })).toHaveProperty(
      "customOptions",
    );
    expect(validateJsonFields({ environment: [] })).toHaveProperty(
      "environment",
    );
    expect(
      validateJsonFields({ customOptions: { "bad name": "v" } }),
    ).toHaveProperty("customOptions");
    expect(
      validateJsonFields({ environment: { "bad-name": "v" } }),
    ).toHaveProperty("environment");
  });
});

describe("config generation", () => {
  it("quotes conf values so ; and # survive", () => {
    expect(tmuxConfQuote('a"b\\c;d#e')).toBe('"a\\"b\\\\c;d#e"');
  });

  it("builds a file with global options, environment and the snippet", () => {
    const file = buildConfigFile({
      ...DEFAULT_CONFIG,
      historyLimit: 123456,
      mouse: "off",
      customOptions: { "default-shell": "/bin/zsh" },
      environment: { EDITOR: "vim" },
      configSnippet: "set-option -g status-interval 5",
    });
    expect(file).toContain("set-option -g history-limit 123456");
    expect(file).toContain("set-option -g mouse off");
    expect(file).toContain('set-option -g default-shell "/bin/zsh"');
    expect(file).toContain('set-environment -g EDITOR "vim"');
    expect(file).toContain("set-option -g status-interval 5");
  });

  it("targets sessions exactly, with the chain separator", () => {
    const args = perSessionArgs(DEFAULT_CONFIG, "main");
    expect(args).toContain("'=main'");
    expect(args).toContain(" \\; ");
    expect(args).toContain("history-limit 50000");
  });

  it("escapes shell values", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("pushes the file through a quoted heredoc under a random delimiter", () => {
    const command = pushFileCommand("set-option -g mouse on\n");
    expect(command).toContain(`cat > ${CONFIG_FILE_PATH} <<'TMUX_CONF_EOF_`);
    expect(command).toContain("set-option -g mouse on");
    // The delimiter is unique per call, so a snippet containing one line of
    // an older delimiter cannot terminate the document early.
    const other = pushFileCommand("x");
    expect(command).not.toBe(other);
  });
});
