# 1. Tauri for the desktop app

**Status:** accepted, version 2.0

## Context

Version 1 ran as a page opened from disk, talking to an rclone that a launcher script started. Version 2 needs to be installable software: an installer, a window, a tray icon, background jobs, and access to things a web page cannot reach, such as the Recycle Bin and the OS keychain. It should also run on Windows, macOS and Linux, and keep the existing interface, which is plain HTML, CSS and JavaScript with no framework.

## Options

| Option | For | Against |
|---|---|---|
| **Electron** | Mature and widely known | Ships a whole Chromium and Node.js with every copy (hundreds of MB), and gives the page Node access unless carefully locked down |
| **Native Windows app** (C# with WebView2) | Tiny, and buildable with tools already in Windows | Windows only |
| **Tauri** | Uses the system's own webview, so installers are a few MB plus rclone. The native side is Rust, which is memory-safe. Its permission system names exactly which native commands a window may call. Cross-platform. | Needs a Rust toolchain to build; each platform's webview differs slightly |
| **Stay a web page** | Nothing new to build | Not installable software; no tray, Recycle Bin or keychain |

## Decision

Tauri 2. The deciding factor is its security model rather than its size: the page gets **no** native access by default, and each command it may call is listed at build time and granted per window. That fits the core idea of version 2, which is that the interface is the least trusted part.

## Consequences

- The interface stays framework-free and is served by Tauri from `ui/`. The browser version keeps working from the same files.
- Building needs Rust and, on Windows, Microsoft's C++ build tools. CI builds the macOS and Linux installers.
- It is tested on Windows. The other platforms are built by CI but not exercised by hand.
