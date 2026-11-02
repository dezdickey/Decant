# 5. Count what arrived by listing the cloud folder

**Status:** accepted for 2.0.1

## Context

Recent and the "left today" figure used the byte count from rclone's `core/stats`. That count includes every byte rclone had to send again, so after a run full of retries it can be far higher than what reached the cloud. In the Linux test of 2.0.0 a stopped run said 179 MB when one 25 MB file had arrived ([#17](https://github.com/dezdickey/Decant/issues/17)). Decant's point is proof that data arrived, so its own record has to count arrivals, not traffic.

## Options

1. **Ask rclone which transfers finished,** with `core/transferred`. It is read-only, but it would be a fifteenth call on the core's allowlist. The allowlist is the app's main security boundary, and its size is stated in the threat model, the README and the release notes.
2. **Follow the progress list between polls** and count files as they leave it. Small files can start and finish between two polls without ever showing, and a file leaving the list may have failed.
3. **List the cloud folder after the upload** and count the files there at the same size as on this computer, less the ones that were there before it started.

## Decision

Option 3. It needs no new call: the page already lists the cloud folder to plan an upload, and Decant lists it again after every upload anyway to refresh the plan, so the count reuses that listing. It also measures the thing that matters, which is what is in the cloud, rather than how many bytes were sent.

## Consequences

- The allowlist stays at 14 calls.
- If the folder can't be listed after a run, the record falls back to rclone's byte count, as before.
- A file counts by size, not by checksum. The record says what arrived; the check that follows still proves it, file by file, before anything can be freed.
