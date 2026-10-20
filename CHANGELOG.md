# Changelog

Each version is one stage of the [roadmap](ROADMAP.md). The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [semantic versioning](https://semver.org/).

## [2.0.0] — Desktop

Decant becomes installable software for Windows, macOS and Linux, with rclone bundled.

### Changed
- **Renamed from Offload to Decant.** "Offload" was already used by several tools doing similar jobs. The browser launcher is now `Decant.cmd`, and settings saved by the 1.0 browser version are not carried over.

### Added
- Desktop app built with Tauri, wrapping the existing interface, with rclone included in the installer.
- A tray icon. Closing the window while an upload or check runs keeps it running in the tray; closing with nothing running quits, and stops rclone.
- Freed files go to the **Recycle Bin** (Trash on macOS and Linux) by default, with permanent deletion as an explicit choice. The dialog says that the space returns only once the bin is emptied.
- `THREAT_MODEL.md`, `SECURITY.md`, and decision records in `docs/decisions/`.
- CI on every push: interface tests, Rust tests, Clippy, `cargo audit`, CodeQL, OpenSSF Scorecard and Dependabot.
- A release pipeline: installers for three platforms, SHA-256 checksums, an SBOM, and GitHub build provenance.

### Security
- The interface can no longer reach rclone. A Rust core holds the password, relays only an allowlist of 14 calls, trims `_config` to the one setting the page uses, and strips sign-in tokens from `config/get` replies.
- rclone grants no cross-origin access, so no web page can talk to it.
- The rclone password is 192 random bits, made fresh each launch. It reaches rclone through environment variables and stays in the core's memory.
- Before removing a file, the core proves it lies inside the folder being offloaded, checking the text of the path and then the resolved real path.
- The page may call exactly three native commands, granted to its one window.
- Every GitHub Action is pinned to a commit, and the bundled rclone is checked against its published SHA-256.

### Fixed
- A comparison by size alone could be reported as a checksum match, because rclone names the missing hash type `none`. It is now labelled as size-only and never unlocks removal.
- Closing the window always hid it in the tray, because the check for running jobs counted itself as one. The core now tracks the background jobs it started.

## [1.0.0] — Browser version

- Upload a folder to any rclone remote, with a plan before anything moves, live progress, a checksum check of every file, and removal of verified local copies.
- Runs as a page opened from disk, talking to rclone's remote-control server with a per-launch password.
