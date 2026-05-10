# Changelog

All notable changes to `commonplace-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1-canary.1] - 2026-05-10

### Added

- End-to-end smoke test of the tag-triggered release workflow
  (DAR-960). This canary publish exercises the OIDC Trusted Publisher
  authentication path, the `--provenance` build attestation, the
  drift guards (tag/version/SERVER_VERSION), and the GitHub Release
  creation step before the real `v0.1.0` ships.

### Notes

- This is a pre-release on the `canary` dist-tag. `npm install
  commonplace-mcp` continues to track `latest` (which currently
  points at `0.0.1-canary.0` from the manual claim publish; the
  pointer moves to `v0.1.0` once that ships).
