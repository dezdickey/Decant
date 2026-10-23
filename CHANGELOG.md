# Changelog

Each version is one stage of the [roadmap](ROADMAP.md). The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [semantic versioning](https://semver.org/).

## [2.0.0] — 2026-10-23 — Desktop

Decant becomes installable software for Windows, macOS and Linux, with rclone bundled.

### Changed
- **Renamed from Offload to Decant.** "Offload" was already used by several tools doing similar jobs. The browser launcher is now `Decant.cmd`, and settings saved by the 1.0 browser version are not carried over.

### Added
- Desktop app built with Tauri, wrapping the existing interface, with rclone included in the installer.
- A tray icon. Closing the window while an upload or check runs keeps it running in the tray; closing with nothing running quits, and stops rclone.
- The app shows its own version beside rclone's, at the top right, so a bug report can name the release.
- Freed files go to the **Recycle Bin** (Trash on macOS and Linux) by default, with permanent deletion as an explicit choice. The dialog says that the space returns only once the bin is emptied.
- `THREAT_MODEL.md`, `SECURITY.md`, and decision records in `docs/decisions/`.
- CI on every pull request and every push to `main`: interface tests, Rust tests, Clippy, `cargo audit` and CodeQL. OpenSSF Scorecard runs on pushes to `main` and weekly, and Dependabot checks dependencies weekly.
- A release pipeline: installers for three platforms, SHA-256 checksums, an SBOM, and GitHub build provenance.
- The macOS app has an ad-hoc signature, because Apple Silicon Macs won't open an app from the internet without one. It doesn't prove who made the app. That would take a paid Apple Developer ID, which isn't planned yet.

### Security
- The interface can no longer reach rclone. A Rust core holds the password, relays only an allowlist of 14 calls, trims `_config` to the one setting the page uses, and strips sign-in tokens from `config/get` replies.
- rclone grants no cross-origin access, so no web page can talk to it.
- The rclone password is 192 random bits, made fresh each launch. It reaches rclone through environment variables and stays in the core's memory.
- Before removing a file, the core proves it lies inside the folder being offloaded, checking the text of the path and then the resolved real path.
- The page may call exactly three native commands, granted to its one window.
- Every GitHub Action is pinned to a commit, and the bundled rclone is checked against its published SHA-256.
- The core's HTTP client is built without TLS. It only ever talks to rclone on 127.0.0.1, so leaving TLS out removes its libraries from the app entirely, along with two advisories `cargo audit` found in them.

### Fixed
- Closing the window always hid it in the tray, because rclone counts the call that lists running jobs as a running job. The core now tracks the background jobs it started.

## [1.0.0] — 2026-10-17 — Browser version

- Upload a folder to any rclone remote, with a plan before anything moves, live progress, a checksum check of every file, and removal of verified local copies.
- Runs as a page opened from disk, talking to rclone's remote-control server with a per-launch password.
- A comparison by size alone is labeled as size-only and never unlocks removal. rclone names a missing hash type `none`, which testing caught being read as a real checksum before 1.0 was finished.
