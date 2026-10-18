# Security policy

Offload deletes files on the strength of a checksum check, so security reports are taken seriously and handled first.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. Only the maintainer sees the report.

It helps to include:
- the version (shown in the app, or the release tag);
- what an attacker could do, and what they would need first;
- steps to reproduce, or a proof of concept.

## What to expect

This is a one-person project, so responses are best effort. The aim is:
- an acknowledgement within a week;
- an assessment, and a fix or a mitigation plan, within 30 days for anything that could lead to data loss or exposed credentials;
- credit in the release notes, unless you prefer not to be named.

Please give a reasonable chance to ship a fix before disclosing publicly.

## Supported versions

| Version | Supported |
|---|---|
| Latest 2.x release | Yes |
| Older 2.x releases | Upgrade to the latest |
| 1.x (browser version) | Security fixes while 2.x is in development |

## Scope

In scope: anything that lets a web page, a file name, another local user or a tampered download make Offload delete the wrong files, leak cloud credentials or the local control password, or reach rclone calls outside the allowlist. See [THREAT_MODEL.md](THREAT_MODEL.md) for what is and is not covered.

Out of scope: attacks that need malware already running as the same user (see the threat model), and vulnerabilities in rclone or the cloud providers themselves, which should go to those projects.
