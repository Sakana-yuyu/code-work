# Control Agents from the CLI

Use the Agent CLI when you want to inspect or control Code Work agents from a terminal or a script.
The commands connect to a running Code Work server, so the agent and project ids are resolved on
that server.

## Connect to a Server

All Agent CLI commands accept the same connection and output options:

| Option                   | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `--server <url>`         | Server URL or direct pairing URL. Defaults to `http://127.0.0.1:3773`. |
| `--access-token <token>` | Scoped bearer token. An explicit token overrides a pairing URL token.  |
| `--json`                 | Emit machine-readable JSON instead of the human-readable text format.  |

`--server` accepts HTTP, HTTPS, WS, and WSS URLs. It also accepts a direct pairing URL printed by
the server, for example:

```bash
npx t3 agent status <agent-id> --server "https://host.example/pair#token=..."
```

The CLI exchanges the credential in a pairing URL for a standard client bearer session. Pairing
links are preferred because they are limited and easy to revoke. A link may be one-time, expired,
or already consumed; create a new link if the exchange fails.

For a remote address, the CLI requires either a pairing URL or a bearer token. Otherwise it fails
with:

```text
Remote control connections require a pairing link or bearer access token.
```

Do not use a hosted app wrapper URL as the server address. Use the direct pairing URL printed by
the Code Work server. The machine running the CLI must be able to reach both the server's HTTP and
WebSocket endpoints; pairing pages do not proxy Agent CLI traffic.

If you must use `--access-token`, issue a short-lived token on the server host:

```bash
npx t3 auth session issue --ttl 15m --token-only
```

This command currently issues administrative scopes, so prefer a pairing URL. Protect the token,
keep its lifetime short, and revoke the session when it is no longer needed. Treat pairing URLs and
tokens like passwords: keep them out of logs, screenshots, shared command transcripts, and shell
history.

## Inspect an Agent

Read the server's authoritative status snapshot:

```bash
npx t3 agent status <agent-id>
```

Print the agent's message log snapshot:

```bash
npx t3 logs <agent-id>
```

Wait for the latest turn to reach a terminal state:

```bash
npx t3 wait <agent-id>
npx t3 wait <agent-id> --timeout-seconds 120
```

Attach to the latest turn and stream message updates until it reaches a terminal state:

```bash
npx t3 attach <agent-id>
```

`wait` and `attach` are subscription commands. They observe an existing turn and do not start a new
turn themselves.

## Control an Existing Agent

Send a new prompt to an idle agent:

```bash
npx t3 send <agent-id> "Review the failing test and implement the fix."
```

Quote prompts so the shell passes spaces and special characters as one argument.

Move an active agent out of the normal list:

```bash
npx t3 archive <agent-id>
```

Return an archived agent to the active list:

```bash
npx t3 unarchive <agent-id>
```

Interrupt the agent's current active turn:

```bash
npx t3 agent kill <agent-id>
```

`kill` only interrupts the active turn. It does not delete or archive the agent.

Commands that read or control an active agent snapshot do not operate on archived agents. Run
`unarchive` first, then use `agent status`, `logs`, `send`, `wait`, `attach`, or `agent kill`.

## Start a New Agent

Create an agent in a project and start its first turn:

```bash
npx t3 run --project <project-id> "Investigate the build failure and fix it."
```

If the project does not have a default model, or if you want to override it, provide both the
provider instance id and model:

```bash
npx t3 run --project <project-id> --provider <provider-id> --model <model> "Add the feature."
```

`--provider` and `--model` must be supplied together.

## Permissions

A normal pairing session includes the standard client scopes. The Agent CLI needs these specific
orchestration scopes:

| Commands                                                | Required scope          |
| ------------------------------------------------------- | ----------------------- |
| `agent status`, `logs`, `wait`, `attach`                | `orchestration:read`    |
| `send`, `archive`, `unarchive`, `agent kill`, and `run` | `orchestration:operate` |

A token without the required scope is rejected by the server.

## JSON Output

Append `--json` to any command when another program will consume the result:

```bash
npx t3 agent status <agent-id> --json
```

Streaming commands can emit multiple JSON frames. Consume those frames as they arrive. Do not parse
the line order of the human-readable output; that format is intended for people and may evolve.

## Common Failures

- **The agent is archived:** run `npx t3 unarchive <agent-id>` before commands that require an
  active agent snapshot.
- **`send` fails:** the prompt must not be empty, and the agent must be active and idle. Wait for or
  interrupt the current turn before sending another prompt.
- **`archive` or `unarchive` fails:** `archive` expects an active agent, while `unarchive` expects an
  agent that is currently in the archived list.
- **`agent kill` fails:** the agent must have an active turn to interrupt.
- **`wait` fails:** the agent may have no turn, may have been deleted, the stream may have ended
  early, or the optional timeout may have expired.
- **`attach` fails:** the agent may be missing or deleted, may have no turn to attach to, or the
  stream may have ended early.
- **`run` fails:** verify that the project exists, the prompt is not empty, and `--provider` and
  `--model` are supplied together when the project has no default model.
- **A remote connection fails:** verify direct HTTP and WebSocket reachability, then use a fresh
  pairing URL or a valid bearer token with the required scope.

## Remote Safety

Prefer a trusted private network or HTTPS/WSS. Do not expose an unencrypted Code Work server to the
public internet. For setup, pairing, revocation, and network troubleshooting, see
[Remote Access](./remote-access.md).
