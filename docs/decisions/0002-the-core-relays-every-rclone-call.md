# 2. The core relays every rclone call

**Status:** accepted, version 2.0

## Context

In version 1, the page talked to rclone's remote-control server directly over HTTP, carrying its password. That meant:

- the password had to reach the page, through a file on disk;
- rclone had to allow cross-origin requests, from the origin `null`;
- the page could make **any** rclone call, including `core/command`, which runs arbitrary rclone commands, and `config/get`, which returns cloud sign-in tokens.

If the interface were ever tricked into running someone else's script, that script would inherit all of it.

## Options

1. **Keep the direct connection**, and pass the password to the page through Tauri instead of a file.
2. **Relay through the core**: the page calls one native command, `rc(path, params)`. The core holds the password, checks the call against an allowlist, trims the request and the reply, and forwards it.
3. **Reimplement the needed operations in Rust** without rclone's server.

## Decision

Option 2. It is the smallest change that makes the interface untrusted by design:

- **The password never leaves the core.** It lives in memory and reaches rclone through environment variables.
- **rclone grants no cross-origin access at all.** No web page, including Decant's own, can talk to it.
- **Only 14 calls are allowed.** The rest of rclone's API, including everything that deletes folders, runs commands or rewrites config, is unreachable from the page.
- **Replies are trimmed.** `config/get` comes back with the remote's type only, so tokens never reach the page.

Option 3 would throw away rclone's tested support for dozens of clouds in exchange for writing and maintaining it again.

## Consequences

- Adding a feature that needs a new rclone call means adding it to the allowlist in `src-tauri/src/rclone.rs`. That is a deliberate, reviewable step.
- Deleting local files goes through a separate native command, `free_file`, with its own path checks, rather than through rclone's `deletefile`.
- Every call takes one extra hop through the core. It is local and costs well under a millisecond.
