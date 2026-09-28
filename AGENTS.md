# Codex macOS Markdown math patch

This repository holds a version-pinned, experimental patch for the native Markdown file preview in Codex for macOS. It is for Codex desktop build `26.924.22138` only. A new Codex build requires fresh inspection and tests; never loosen the source hashes or parser anchors to make an unknown build pass.

## Working rules

- Keep the patch Codex-specific. It changes the native `.md` viewer; the separate MCP browser-preview plugin lives locally in another source tree.
- Only use an app bundle obtained by the user. Never commit Codex/Electron application binaries, ASAR archives, patched bundles, extracted bundles, signing identities, private keys, certificates, or machine-specific reports.
- No user-specific paths, Apple Team IDs, private research text, or secrets belong in tracked source or test fixtures.
- Stage and sign an independent app copy first. Verify its launch and Markdown math, including GFM tables, before any change to an installed app. Keep the original app as a recoverable backup.
- Use code signing with library validation for the release flow. The old isolated test entitlement that disabled library validation is intentionally excluded.
- `README.md` is maintained by the user. Put agent guidance here and user instructions in `INSTALL.md`.
- Keep dry-run and verification paths available and fail closed on unexpected versions, hashes, signatures, or layout.
