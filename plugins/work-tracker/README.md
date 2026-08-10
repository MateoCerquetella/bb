# Work Tracker

Work Tracker brings Linear, GitHub, and Jira issues into BB, organized by BB
project. The external systems remain authoritative; BB keeps a refreshable
project-scoped cache for fast lists and mentions, then fetches issue details
live when a user opens or sends an issue to an agent.

Install the bundled official plugin with `bb plugin install work-tracker`.

## Surfaces

- **Work Tracker panel**: opens on the current BB project, with a deterministic
  project fallback when no project is current. Switch between refined List and
  compact Kanban views, move cards between provider statuses, open live
  details, or prefill a BB agent prompt.
- **Across projects**: an explicit aggregate that keeps tickets grouped by
  their owning BB project instead of flattening unrelated work together.
- **Manage**: project-bound source rules and write-only Linear/Jira credential
  controls. Switching projects also switches the credentials being managed.
- **Composer mentions**: type `@` or `#` plus an issue key or title and choose
  the **Work Tracker** result.
- **CLI**: inspect, configure, refresh, and update the same project-scoped work
  with `bb work ...`.

Kanban lanes preserve the providers' actual status names instead of forcing a
fixed set. Drag a card onto an available lane, or focus it and press Space to
pick it up, Left/Right to choose a status, and Enter to move it. Linear exposes
the selected team's workflow states, Jira exposes the issue's currently valid
transitions, and GitHub exposes Open and Closed. The provider remains
authoritative: failed writes roll back the optimistic card move.

## Project sources

BB projects are the primary Work Tracker scope. Open **Work Tracker → Manage**,
select a BB project, and choose the external work that belongs to it:

- GitHub automatically uses the repositories already mapped to that BB project
  by BB's official GitHub plugin. Manage only whether GitHub is included; there
  is no separate repository picker.
- Linear must be enabled explicitly for the project. Bind both that project's
  API key and one required Linear team key; the connector loads that team's
  open queue and never falls back to a user-wide assigned-issue query.
- Jira must be enabled explicitly for the project. Enter the JQL that selects
  the issues for that project.

GitHub reuses the official GitHub plugin and its `gh` authentication. Install
and configure that plugin first:

```sh
bb plugin install github
gh auth login
bb plugin reload github
```

Enter each project's Linear personal API key and required team key or Jira
Cloud account bundle in **Work Tracker → Manage**. Credentials are isolated by
BB project: one project's refresh never falls back to another project's Linear
key or Jira token. Jira accepts an HTTPS Atlassian Cloud origin
(`*.atlassian.net`), account email, token, and project JQL. Changing the Jira
origin or email requires a replacement token or an explicit token removal in
the same save.

Secret inputs are write-only and remain blank after loading, saving, or
switching projects. Work Tracker stores each project's live secret copy with
atomic owner-only file permissions, while the UI and CLI report only
configured/not-configured status. Keep credentials out of commands, prompts,
comments, and issue text. Removing a credential stops Work Tracker from using
its live project copy, but cannot promise immediate hard erasure from BB
rollback snapshots retained for recovery.

## CLI

Every command is scoped to the current BB project. Outside a project thread, or
to target a different project, pass `--project <proj_id>` explicitly.

```sh
bb work status [--project <proj_id>]
bb work config [--project <proj_id>] [--github on|off] [--linear on|off] \
  [--linear-team <key>] [--jira on|off] [--jira-url <url>] \
  [--jira-email <email>] [--jira-jql <jql>]
bb work credentials [--project <proj_id>] [--json]
bb work refresh [linear|github|jira] [--project <proj_id>]
bb work list [--project <proj_id>] [--source linear|github|jira] \
  [--query <text>] [--cached]
bb work show <linear|github|jira> <locator> [--project <proj_id>]
bb work transitions <linear|github|jira> <locator> [--project <proj_id>]
bb work move <linear|github|jira> <locator> --status <id> \
  [--project <proj_id>]
```

`bb work config` is for nonsecret project fields only. `bb work credentials`
must run from an active BB thread and opens the connected app's authenticated,
project-bound credential form; it never accepts keys or tokens as command
arguments and reports status rather than values. Add `--json` when another
command or agent will consume nonsecret command output.

Run `bb work transitions` immediately before `bb work move`; available Jira
transitions in particular can change with the issue's current state and your
permissions. Status IDs are treated as provider input and are revalidated
before the write.
