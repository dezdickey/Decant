# Threat model

**Version:** 2.0 (desktop app). Updated at every stage; see the roadmap.

Offload moves files from a computer to a cloud, checks every copy by checksum, and can then remove the local originals. That last step is why this document exists: a tool that deletes files on the strength of a check has to be hard to trick.

## What is worth protecting

| Asset | Why it matters | Property |
|---|---|---|
| **Local files** being offloaded | Removing them is the point of the app, and a permanent delete cannot be undone | Integrity, availability |
| **Cloud sign-in tokens** in rclone's config | Whoever has one can read and change the whole cloud account | Confidentiality |
| **The rclone control password** | Whoever has it can make rclone do anything rclone can do, as the user | Confidentiality |
| **Cloud copies** of offloaded files | They become the only copy once the originals are removed | Integrity |
| **Run history** | Shows what was uploaded and removed, and when | Integrity (made tamper-evident in 2.1) |

## Who might attack, and who is out of scope

- **A malicious website** open in the same browser (the v1 browser version). In scope.
- **Content shown in the app**, for example a file named to look like markup, trying to run script in the interface. In scope.
- **Another user account on the same computer**, which can reach the loopback port. In scope.
- **A compromised dependency or build step**, meaning the supply chain. In scope.
- **Someone on the network.** In scope for cloud traffic, which rclone protects with TLS. Offload listens only on 127.0.0.1.
- **Malware running as the same user.** **Out of scope**, and stated plainly: it can already read rclone's config file and every file Offload could touch, so no app-level control holds against it. 2.3 encrypts the config at rest, which raises the cost of reading tokens off a stolen disk, not of malware already running.

## Architecture and trust boundaries

```
 [ Interface (webview) ]   B1: Tauri IPC — three named commands only
          │
 [ Rust core ]             holds the rclone password; allowlist; path checks
          │                B2: HTTP on 127.0.0.1, random port, basic auth
 [ rclone rcd ]            B3: other local users can reach the port
          │                B4: TLS to the provider, OAuth tokens
 [ Cloud provider ]
                           B5: supply chain — rclone binary, crates, Tauri, CI
```

## STRIDE, boundary by boundary

### B1: Interface to core
| Threat | How it would look | Mitigation in 2.0 |
|---|---|---|
| **Elevation** | Script injected into the page calls powerful functions | The build manifest and capability grant only `rc`, `free_file` and `app_info`; Tauri refuses anything else before it reaches Offload. A strict CSP allows script only from the app's own files. `freezePrototype` blocks prototype-pollution tricks. File names are always inserted as text, never as HTML. |
| **Elevation** | The page asks rclone for something dangerous | `rc` accepts only an allowlist of 14 calls. Absent on purpose: `core/command` (runs any rclone command), `operations/purge` and `delete`, `deletefile`, every config write or dump, and `core/quit`. |
| **Information disclosure** | The page reads sign-in tokens | `config/get` replies are cut down to the remote's type (and an alias's target) before the page sees them. |
| **Tampering** | The page widens a request, for example by redirecting rclone's config through `_config` | `_config` is trimmed to `Transfers`, clamped to 1–16. |
| **Tampering** | `free_file` is pointed outside the folder being offloaded | The relative path must be plainly relative, with no `..`, root or drive. After resolving links, the real path must still sit under the real folder, and must be a regular file. |

### B2: Core to rclone
| Threat | How it would look | Mitigation in 2.0 |
|---|---|---|
| **Spoofing** | Something else answers on the port | The port is chosen at launch, and rclone is started by the core and waited for. |
| **Information disclosure** | The password leaks | 192 random bits, made fresh each launch. It reaches rclone through environment variables, not the command line or a file, and exists only in the core's memory. |
| **Elevation** | A web page talks to rclone directly | rclone runs with **no** cross-origin permission, so browsers refuse cross-origin requests to it. Without the password, every request is refused anyway. |

### B3: Other local users
| Threat | Mitigation |
|---|---|
| Connecting to the loopback port | Basic auth with a 192-bit password; guessing is not practical. |
| Reading the log file | It holds rclone's own log, in the user's per-app log folder. |

### B4: rclone to the cloud
| Threat | Mitigation |
|---|---|
| Interception or tampering in transit | TLS, handled by rclone. |
| A wrong or corrupted cloud copy leading to a bad delete | Removal is offered only for files whose **checksums** match. A size-only comparison never unlocks it. Each file is checked again (size and modification time) just before removal, and skipped if it changed. Removal is refused when the copy is on the same disk or inside the same folder, or behind a wrapper remote whose real storage cannot be determined. |
| Losing files to a mistaken removal | The Recycle Bin or Trash by default. Permanent deletion is a separate, explicit choice. |

### B5: Supply chain
| Threat | Mitigation |
|---|---|
| A tampered rclone binary | `scripts/fetch-rclone.sh` pins the version and checks the download against rclone's published SHA-256. |
| A vulnerable or malicious crate | `Cargo.lock` is committed; `cargo audit` runs in CI; Dependabot proposes updates. |
| A tampered build | Releases are built by GitHub Actions and carry build provenance, SHA-256 checksums and an SBOM. |

## How 2.0 was attacked

Each stage records what was tried against its new parts. For 2.0:

| Attack | How | Result |
|---|---|---|
| Run a forbidden rclone call through the page's channel | Live test: `operations/purge` and `core/command` sent through the relay, with a control sending the same purge straight to rclone | Refused with 403 and never executed. The control proved the purge would have deleted the folder. |
| Read a sign-in token through the page's channel | Live test: a remote with a planted token, read through the relay and straight from rclone | rclone returns the token; the relay returns `{"type": "drive"}` only. `config/dump` is refused. |
| Talk to rclone without the password | Live test: a wrong password and no password | 401 both times; the real password works |
| Reach rclone from a web page | Live test: CORS preflights from `https://evil.example`, `null` and `http://127.0.0.1` | No `Access-Control-Allow-Origin` for any of them, so browsers block the request |
| Make the core delete outside the folder | Unit tests for `..`, absolute paths and folders, plus 4,000 generated paths mixing `..`, `.`, drive letters, UNC prefixes and both slash styles | Nothing outside the folder, and nothing containing `..`, was ever approved |
| Leave rclone running after quitting | Manual test on Windows: quit with no job running | rclone exits with the app |

**Two bugs found by testing, both fixed in 2.0:**

- **A size-only check could read as a checksum match.** When the cloud and the disk share no checksum, rclone reports the hash type as the word `none`, and the page treated that as a real checksum, reporting "every file matches" after comparing sizes only. Removal stayed locked in that test only because the remote was encrypted. Size-only results are now labelled as such and can never unlock removal. (Found while testing v1.)
- **Closing the window never quit.** rclone counts every call as a running job, including the call asking what is running, so the app always believed an upload was in progress and hid in the tray. It now tracks the background jobs it started. (Found while testing the desktop app.)

## Known gaps

Listed so they are not mistaken for oversights.

| Gap | Why it is open | Planned |
|---|---|---|
| rclone's config, holding the tokens, is plain text on disk | 2.0 reuses the user's existing rclone config rather than copying tokens into a second plain-text file | 2.3 encrypts Offload's own config, with the key in the OS keychain |
| Run history can be edited | It is a convenience list kept in the webview's storage | 2.1: a signed, hash-chained log anchored by receipts in the cloud |
| The checksum comes from the provider | Offload trusts what the cloud reports for its copy | 2.1 records a local SHA-256 manifest in each custody receipt; 2.2 re-checks old offloads |
| A file could change between the last check and its removal | The re-check narrows the window, but cannot close it completely | Accepted |
| If Offload crashes, rclone can outlive it | Nothing outside the core knows the password, so the leftover process is idle and unreachable | Possible fix: tie rclone's lifetime to the app's with a Windows job object |
| `SHA256SUMS` for rclone is fetched over HTTPS, but its signature is not checked | The checksum guards against corrupted downloads, not a compromised download server | Check rclone's signature on `SHA256SUMS` in CI |
| Installers are not code-signed | A certificate is needed | 2.5 |

## The browser version (v1)

Still shipped, for anyone who prefers not to install anything. Its model differs: the password sits in `ui/session.js`, which any process running as the user can read, and rclone allows the origin `null`, which sandboxed pages also share. The password still guards every request. The desktop app removes both weaknesses.
