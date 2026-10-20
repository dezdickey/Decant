# 3. The Recycle Bin by default, with permanent deletion as a choice

**Status:** accepted, version 2.0

## Context

Freeing space is Decant's last step: files that matched their cloud copies by checksum are removed from the computer. Version 1, as a web page, could only delete them permanently. The desktop app can use the Recycle Bin (Trash on macOS and Linux).

The two goals pull against each other. The Recycle Bin makes a mistake recoverable, but files in it still take up space until it is emptied, and getting space back is the reason to remove them at all.

## Decision

The dialog asks, with the Recycle Bin selected by default, and says plainly what each choice means:

- **Recycle Bin:** can be restored; the space comes back once the bin is emptied.
- **Delete permanently:** the space comes back now; cannot be restored.

Both go through the same native command, `free_file`, after the same checks: the path must sit inside the folder being offloaded, and the file must be unchanged since it was verified.

## Consequences

- After moving files to the Recycle Bin, the app says the space returns only once the bin is emptied, so a disk that still looks full is not a surprise.
- The browser version still deletes permanently, and says so.
