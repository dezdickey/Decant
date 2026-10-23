# Decant roadmap

Version 1 is a local web page over rclone: upload, verify by checksum, then free the space. Version 2 turns it into installable desktop software, built for Windows, macOS and Linux and tested on Windows. It is built security-first, and every stage ships on its own.

The idea running through all of it is **chain of custody**: data leaves a machine only with proof it arrived intact, every deletion leaves a record that cannot be quietly rewritten, and that proof can be checked again months later.

## Principles

- **Nothing leaves the device except your files, to the cloud you chose.** No accounts, no telemetry, no crash reporting, no analytics.
- **Least privilege.** Ask for the narrowest cloud permission that does the job, and keep secrets out of reach of the user interface.
- **Prove, don't assume.** Deleting is only ever offered on a checksum match, and every action is logged.
- **Security is a habit, not a phase.** Every stage is attacked as it is built, and the last stage attacks all of it.
- **Small and inspectable.** The interface stays plain HTML, CSS and JavaScript, with no framework and no bundler. The native layer is a small Rust core.

## Architecture (v2)

```
┌──────────────── Decant (Tauri) ────────────────┐
│  Interface: HTML/CSS/JS, no framework           │
│        │  Tauri IPC (no network involved)       │
│  Rust core ── holds the rclone password         │
│        │      allowlists and trims every call   │
│        │      Recycle Bin, keychain, tray       │
│        ▼                                        │
│  rclone rcd (bundled), 127.0.0.1, random port   │
└─────────────────────────────────────────────────┘
```

| v1 | v2 | Why it is better |
|---|---|---|
| The page calls rclone over HTTP, with the password in `session.js` | The page asks the Rust core, and only the core talks to rclone | The password never touches disk or JavaScript, and rclone accepts no cross-origin requests at all |
| The page can make any rclone call | The core allows a fixed list of calls and strips sign-in tokens from replies | A compromised page still cannot run arbitrary rclone commands or read credentials |
| You install rclone and run `rclone config` | rclone is bundled; clouds are added inside the app (2.3) | No terminal, ever |
| Deleting is permanent | The Recycle Bin or Trash by default, permanent if chosen | Recoverable mistakes |
| A browser tab | A window, a tray icon and background jobs | Real software |

## How every stage is built and shipped

- **A pull request.** Each stage is built on its own branch and merged through a pull request once the automated checks pass.
- **Signed commits.** Every commit and release tag is signed, so GitHub shows it as *Verified*.
- **Decision records.** Each significant choice gets a short record in `docs/decisions/`: the context, the options, what was chosen and why.
- **Attacked as it is built.** Each stage records how its new features were attacked and what that changed.
- **The release kit:** a version tag with installers for every platform, release notes in `CHANGELOG.md`, an updated `THREAT_MODEL.md`, a short demo clip, and a write-up by the author of what was built and the security idea behind it.

## Stages

### 2.0 Desktop
- Tauri app wrapping the v1 interface, with rclone as a bundled sidecar.
- Every rclone call goes through the Rust core, which owns the password, allows a fixed list of calls, and strips sign-in tokens from replies.
- Freed files go to the Recycle Bin or Trash, or are deleted permanently if chosen. Either way, the core first proves the file lies inside the folder being offloaded.
- Tray icon. Closing the window while a job runs keeps it running in the tray; otherwise closing quits.
- Tests: unit tests, property-based tests of the path check, and integration tests of the core against a real rclone.
- `THREAT_MODEL.md` (assets, trust boundaries, a STRIDE pass over each) and `SECURITY.md` (private vulnerability reporting).
- **Supply chain, from the first release:** CI runs tests, `cargo clippy`, `cargo audit` and CodeQL on every pull request and every push to `main`. Dependabot keeps dependencies current, and an OpenSSF Scorecard rates the repository's practices. Every release carries SHA-256 checksums, an SBOM and GitHub build provenance. The bundled rclone is verified against its published checksum.

### 2.1 Proof
- **An anchored, tamper-evident activity log.** Append-only, with each entry carrying the SHA-256 of the one before it, and signed with a key held in the OS keychain. A hash chain alone can be rewritten end to end by anyone who can edit the file, so it is also anchored outside the machine (next point).
- **Custody receipts.** After each offload, a small receipt is uploaded beside the files: the chain's latest hash, plus a SHA-256 manifest of every file in the standard `sha256sum` format. Rewriting the log on the computer cannot also rewrite the copy in the cloud.
- **Verification reports:** every file with its size, its checksum on both sides and when it was checked, exportable as CSV or JSON.
- A *Verify log* action that checks the chain, the signatures and the latest receipt.
- Fuzz testing of the log and receipt parsers.

### 2.2 New layout and jobs
- Sidebar layout: **Decant**, **Jobs**, **History**, **Clouds**, **Settings**. History is where the 2.1 log and reports live.
- Several jobs queued at once, and saved jobs that run again with one click.
- Rules: only files older than *N* days, include or exclude patterns, minimum size.
- Scheduled offloads while Decant sits in the tray, and OS notifications.
- **Re-checking old offloads:** a scheduled job compares files uploaded long ago against their custody receipts, to catch anything the cloud lost or corrupted.
- An accessibility pass: everything works from the keyboard and reads correctly in a screen reader.
- **The project page** on GitHub Pages: what it does, screenshots, a demo and the security model.
- **A speed benchmark:** browser uploads against Decant, measured on a real connection.

### 2.3 Clouds
- **Add a cloud** inside the app, on the new Clouds page, through rclone's config API, including the browser sign-in step.
- Decant's own config, encrypted at rest with the key in Windows Credential Manager, the macOS Keychain or the Secret Service.
- Google Drive through Decant's own client ID with the narrow `drive.file` permission, which only sees files the app uploaded itself. Existing rclone remotes, with full access, can still be imported. The trade-off is explained in the app.

### 2.4 Managed installs
- **Group Policy on Windows:** an ADMX template, so IT departments set Decant's policy the way they manage other software. A policy file does the same on macOS and Linux.
- Policies can turn deleting off, require verification, limit which clouds may be used and cap bandwidth. The app shows which settings are locked.
- Silent install switches and documentation for rolling out to many machines.

### 2.5 Release hardening
- Auto-update with signed update manifests. Tauri's updater checks an Ed25519 signature before installing anything.
- Code signing for Windows, applying first to the SignPath Foundation's free program for open-source projects.
- Notarisation for macOS if an Apple developer account is ever taken on.

### 2.6 Break it
- A structured attack on the finished app: the allowlist, the IPC boundary, the path check, the log chain and receipts, the local server, the update channel and the policy enforcement.
- A published report of what was tried, what held, and what was found, with every finding fixed in a 2.6.x release.

## Decisions still open

- ~~**Name**~~: settled in 2.0. The project began as "Offload", which turned out to be shared by several tools doing similar jobs, and was renamed **Decant**.
- **Google client ID** (2.3): created by the project owner in Google's developer console.
- **Code signing** (2.5): free through SignPath if accepted, otherwise an annual cost. Until then, Windows shows "Unknown publisher" on install.

## Testing

- `tests/index.html` for the interface's pure modules, run headless in CI.
- `cargo test` for the Rust core: unit tests, property-based tests of the path check, and integration tests against a real rclone.
- Fuzzing in CI on Linux, where Rust's fuzzing tools work best.
- End-to-end runs against an isolated rclone config whose "cloud" is a local folder, never a real account.
