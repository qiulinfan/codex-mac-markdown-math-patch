# Codex macOS Markdown math patch

This repository patches the **native `.md` file preview** in Codex for macOS build `26.924.22138` (`CFBundleVersion` `11645`). It adds `$...$` and `$$...$$` math and keeps a formula containing `|` in one GFM table cell. The source app must be an unmodified copy of that exact build. Hash checks stop the process on any other build.

The patch is experimental and is not a Codex plugin API or an official Codex release. The repository contains source and tests only; it does not distribute a Codex app, ASAR archive, signing certificate, or patched binary.

## Prepare

- macOS on Apple silicon, Node.js 20 or newer, Xcode command line tools (including `/usr/bin/python3`), and an **Apple Development** code signing identity in your keychain.
- An unmodified Codex app for build `26.924.22138`. Keep this original app intact.
- Enough free space for an independent app copy.

List available signing identities with `security find-identity -v -p codesigning`. Use the full name of your own Apple Development identity in the command below. No signing key is stored in this repository.

```sh
npm ci
npm test
CODEX_ORIGINAL_APP="/path/to/original/ChatGPT.app" npm run test:core
mkdir -p "$HOME/Applications"
npm run build:mac -- \
  --source "/path/to/original/ChatGPT.app" \
  --output "$HOME/Applications/Codex Math Preview.app" \
  --identity "Apple Development: YOUR NAME (YOUR TEAM ID)"
npm run verify:mac -- \
  --source "/path/to/original/ChatGPT.app" \
  --output "$HOME/Applications/Codex Math Preview.app"
```

The build command creates a new app outside `/Applications`; it refuses an existing output path. The source is checked against the pinned original ASAR before the copy is patched. Verify the signed copy, then open it and inspect [`core/smoke.md`](core/smoke.md) in Codex's native file preview. Confirm inline math, display math, and the three-column table containing determinant bars before considering installation. Keep the original app as a rollback copy.

The app is signed locally with your identity, so macOS will see it as different from the official OpenAI-signed build. Do not run both copies simultaneously against the same Codex profile. Codex updates may replace the patch and require a new build-specific implementation.

## What changes

- `core/` changes two JavaScript entries in the version-pinned ASAR and updates integrity metadata; its offline tests use synthetic fixtures.
- `packaging/` stages an independent app copy, updates Electron's ASAR integrity digest, signs nested native code and the app, and verifies the output.
- The source app and signing credentials are never included in the Git repository.

There is no generic browser-preview MCP plugin in this repository.
