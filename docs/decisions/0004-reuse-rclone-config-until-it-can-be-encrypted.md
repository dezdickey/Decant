# 4. Reuse rclone's config until Decant can encrypt its own

**Status:** accepted for 2.0; replaced in 2.3

## Context

rclone keeps cloud sign-in tokens in its config file, in plain text unless the user sets a config password. Decant eventually wants its own config, encrypted, with the key in the OS keychain (stage 2.3). The question is what 2.0 does in the meantime.

## Options

1. **Copy the user's remotes into a Decant config now.** This puts a second plain-text copy of every token on disk.
2. **Reuse rclone's own config** where the remotes already live, and switch to an encrypted Decant config in 2.3.

## Decision

Option 2. Copying tokens before they can be encrypted would double the number of places a token can be stolen from, for no benefit until 2.3. Reusing the config adds no new exposure.

## Consequences

- 2.0 sees exactly the remotes the user already set up with `rclone config`.
- The threat model lists the plain-text config as a known gap until 2.3.
- In 2.3, import copies remotes into the encrypted config, and the user can then remove them from rclone's.
