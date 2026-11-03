# CPU Guardian

CPU Guardian is a lightweight macOS system monitor built with Rust, Tauri 2, React, and TypeScript. It lives in the menu bar, samples system statistics locally, and keeps running when its dashboard is closed.

## Features

- Live CPU, memory, startup-volume disk, network, battery, and process readings.
- Customizable menu bar metrics, sampling interval, appearance, and byte units.
- Start at login enabled on first launch; startup and hidden-launch behavior can be changed in Settings.
- Dashboard window opens from the menu bar and hides when closed so monitoring can continue.
- Searchable process list with protected-system and developer-process labels.
- No telemetry or account connection. Settings stay in the app's local data folder.

System totals are estimates based on macOS process, VM, disk, and interface counters. CPU values reflect sampled process CPU and can differ from Activity Monitor. Network rates sum active `en*` interfaces, while WindowServer is shown as observed process usage without per-app attribution. Some metrics, such as battery, are unavailable on certain Macs.

## Requirements

- macOS 13 or later
- Rust 1.90+
- Node.js 20.19+ or 22.12+

## Development

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --bundles app,dmg
```

The `.app` bundle and Apple Silicon DMG are written under `src-tauri/target/release/bundle/`.

## Privacy

The app reads local macOS process and system counters. It does not terminate processes, request Screen Recording access, or send collected metrics over the network.
