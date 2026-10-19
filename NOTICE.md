# Notices

This repository contains only build files (Dockerfile, lockfile, entrypoint, CI) under the MIT License (`LICENSE`).
The container image it builds also contains third-party software, unmodified, under the licenses below.

## mobile-next/mobile-mcp

Source: https://github.com/mobile-next/mobile-mcp — npm `@mobilenext/mobile-mcp@1.0.12`
License: Apache License 2.0 (the full text ships in the image at `/app/node_modules/@mobilenext/mobile-mcp/LICENSE`).
Its npm dependencies (including the `mobilecli` binary, `@mobilenext/mobilecli-linux-amd64`) are installed exactly as
pinned in `package-lock.json`; each package's own license file ships with it under `/app/node_modules/`.

## Android SDK Platform-Tools (adb)

Source: https://developer.android.com/tools/releases/platform-tools — `platform-tools_r37.0.1-linux.zip`
`adb` is part of the Android Open Source Project and is licensed under the Apache License 2.0.
Per the Android SDK License Agreement §3.5, components under an open source license are governed solely by that license.
The upstream `NOTICE.txt` from the archive ships in the image at `/opt/platform-tools/NOTICE.txt` and is not altered.

## Node.js runtime

The runtime layer is `gcr.io/distroless/nodejs22-debian13` (Node.js, MIT; Debian packages under their own licenses,
listed in the image under `/usr/share/doc`).
