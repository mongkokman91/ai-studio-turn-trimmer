# Self-hosted Chromium updates

This repository publishes versioned extension ZIPs automatically. When the repository secret `CRX_PRIVATE_KEY_B64` is configured, releases also contain a signed `ai-studio-turn-trimmer.crx` and `updates.xml`.

## One-time signing-key setup

Generate the key once and keep it permanently. Replacing it changes the extension ID and breaks the update chain.

```bash
openssl genrsa -out extension.pem 2048
base64 -w 0 extension.pem
```

On macOS use:

```bash
base64 < extension.pem | tr -d '\n'
```

Add the resulting Base64 text as the GitHub Actions repository secret named `CRX_PRIVATE_KEY_B64`.

Never commit `extension.pem` or its Base64 representation.

## Release behavior

A push to `main` reads the version from `manifest.json`, creates a versioned ZIP, and publishes a GitHub Release. With the signing secret present it additionally signs a stable-identity CRX and publishes the Chromium update manifest.

The extension manifest points to the latest-release `updates.xml`, which in turn points to the latest-release CRX.

## Updating

Increment `manifest.json`'s version and push to `main`. The release workflow handles packaging and publication.
