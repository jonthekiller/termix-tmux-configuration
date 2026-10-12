import {
  boolean,
  defineTable,
  id,
  integer,
  refHost,
  refUser,
  text,
  timestamp,
} from "@termix-ssh/plugin-sdk/db";

/**
 * A user's tags on a tmux session, per host. Sessions are shared on the host
 * itself, but tags are per user: everyone who monitors the same host can tag
 * the same session differently. Fresh table — the tmux-monitor plugin keeps
 * its own copy, so tags do not migrate automatically when switching plugins.
 */
export const sessionTags = defineTable("session_tags", {
  id: id(),
  userId: refUser(),
  hostId: refHost(),
  sessionName: text().notNull(),
  tag: text().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
});

/**
 * A named preset of tmux options a user can apply to any selection of hosts.
 * The options are the same keys the plugin declares as host settings; a
 * profile never overrides the per-host hierarchy, it is a payload for the
 * apply action.
 */
export const profiles = defineTable(
  "profiles",
  {
    id: id(),
    userId: refUser(),
    name: text().notNull(),
    options: text().notNull(), // JSON object of host-setting keys to values
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_p_tmux_configuration_profiles_user", columns: ["userId"] },
    ],
  },
);

/**
 * One row per host per apply run: what was applied, whether it worked and
 * why not. Powers the history view and the "last applied" column.
 */
export const applyRuns = defineTable(
  "apply_runs",
  {
    id: id(),
    userId: refUser(),
    hostId: integer().notNull(),
    hostName: text().notNull(),
    ok: boolean().notNull(),
    reason: text(), // "applied" | "tmux-missing" | error message
    sessionsTouched: integer().notNull().default(0),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "idx_p_tmux_configuration_runs_host", columns: ["hostId"] },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [sessionTags, profiles, applyRuns];
