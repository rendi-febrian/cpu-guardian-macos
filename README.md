# CPU Guardian

CPU Guardian is a lightweight macOS system monitor built with Rust, Tauri 2, React, and TypeScript. It lives in the menu bar, samples system statistics locally, and keeps running when its dashboard is closed.

## Features

- Live CPU, memory, startup-volume disk, network, battery, and process readings.
- Live CPU, P-core and E-core, GPU, SSD, battery, and ambient temperature readings from available SMC sensors.
- Customizable menu bar metrics, sampling interval, appearance, and byte units.
- Start at login enabled on first launch; startup and hidden-launch behavior can be changed in Settings.
- Dashboard window opens from the menu bar and hides when closed so monitoring can continue.
- Searchable process list with protected-system and developer-process labels.
- No telemetry or account connection. Settings stay in the app's local data folder.

System totals are estimates based on macOS process, VM, disk, and interface counters. CPU values reflect sampled process CPU and can differ from Activity Monitor. Network rates sum active `en*` interfaces, while WindowServer is shown as observed process usage without per-app attribution. Temperature readings use the Mac's SMC sensor interface through [power-monitor](https://github.com/electricapp/power-monitor); sensor availability depends on the Mac model and macOS version. Full sensor coverage requires macOS 14 or later, and unavailable sensors appear as `—`.

## Requirements

- macOS 13 or later
- Rust 1.96+
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

The app reads local macOS process, system, and SMC temperature counters. It does not terminate processes, request Screen Recording access, or send collected metrics over the network. The `power-monitor` dependency is MIT OR Apache-2.0 licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
