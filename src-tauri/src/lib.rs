use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
#[cfg(target_os = "macos")]
use power_monitor::Smc;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    sample_interval_seconds: u64,
    show_cpu: bool,
    show_memory: bool,
    show_disk: bool,
    show_network: bool,
    show_battery: bool,
    show_cpu_temperature: bool,
    show_performance_temperature: bool,
    show_efficiency_temperature: bool,
    show_gpu_temperature: bool,
    show_ssd_temperature: bool,
    show_battery_temperature: bool,
    show_ambient_temperature: bool,
    start_at_login: bool,
    launch_hidden: bool,
    theme: String,
    binary_units: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sample_interval_seconds: 2,
            show_cpu: true,
            show_memory: true,
            show_disk: false,
            show_network: false,
            show_battery: false,
            show_cpu_temperature: true,
            show_performance_temperature: false,
            show_efficiency_temperature: false,
            show_gpu_temperature: false,
            show_ssd_temperature: false,
            show_battery_temperature: false,
            show_ambient_temperature: false,
            start_at_login: true,
            launch_hidden: true,
            theme: "system".into(),
            binary_units: false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    pid: u32,
    parent_pid: u32,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
    runtime_seconds: u64,
    protected: bool,
    developer: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    sampled_at: u64,
    cpu_percent: f32,
    memory_total: u64,
    memory_used: u64,
    disk_total: u64,
    disk_used: u64,
    network_rx_bytes_per_second: u64,
    network_tx_bytes_per_second: u64,
    battery_percent: Option<u8>,
    cpu_temp_c: Option<f32>,
    cpu_temp_source: Option<String>,
    cpu_performance_temp_c: Option<f32>,
    cpu_efficiency_temp_c: Option<f32>,
    gpu_temp_c: Option<f32>,
    ssd_temp_c: Option<f32>,
    battery_temp_c: Option<f32>,
    ambient_temp_c: Option<f32>,
    processes: Vec<ProcessInfo>,
}

struct SystemState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    previous_network: Mutex<Option<(Instant, u64, u64)>>,
    latest: Mutex<Option<Snapshot>>,
    #[cfg(target_os = "macos")]
    smc: Mutex<Option<Smc>>,
}

#[derive(Default)]
struct ThermalSnapshot {
    cpu_temp_c: Option<f32>,
    cpu_temp_source: Option<String>,
    cpu_performance_temp_c: Option<f32>,
    cpu_efficiency_temp_c: Option<f32>,
    gpu_temp_c: Option<f32>,
    ssd_temp_c: Option<f32>,
    battery_temp_c: Option<f32>,
    ambient_temp_c: Option<f32>,
}

const PROTECTED: &[&str] = &["kernel_task", "WindowServer", "launchd", "loginwindow", "systemstats"];
const DEVELOPER: &[&str] = &[
    "xcodebuild", "swift", "swiftc", "swift-frontend", "clang", "clang++", "SourceKitService",
    "Simulator", "CoreSimulatorService", "node", "npm", "pnpm", "yarn", "vite", "metro",
    "react-native", "expo", "gradle", "java", "rustc", "cargo", "codesign",
];

#[tauri::command]
fn load_settings(state: State<'_, SystemState>) -> Result<Settings, String> {
    state.settings.lock().map(|settings| settings.clone()).map_err(|_| "settings lock failed".into())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, SystemState>,
    mut settings: Settings,
) -> Result<Settings, String> {
    settings.sample_interval_seconds = match settings.sample_interval_seconds {
        1 | 2 | 5 | 10 => settings.sample_interval_seconds,
        _ => 2,
    };
    if !["system", "dark", "light"].contains(&settings.theme.as_str()) {
        settings.theme = "system".into();
    }

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = app.autolaunch();
        let enabled = autostart.is_enabled().map_err(|e| e.to_string())?;
        if settings.start_at_login && !enabled {
            autostart.enable().map_err(|e| e.to_string())?;
        } else if !settings.start_at_login && enabled {
            autostart.disable().map_err(|e| e.to_string())?;
        }
    }

    let serialized = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if let Some(parent) = state.settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&state.settings_path, serialized).map_err(|e| e.to_string())?;
    *state.settings.lock().map_err(|_| "settings lock failed")? = settings.clone();

    if let Ok(latest) = state.latest.lock() {
        if let Some(snapshot) = latest.as_ref() {
            update_tray_title(&app, &settings, snapshot);
        }
    }
    Ok(settings)
}

#[tauri::command]
fn process_snapshot(state: State<'_, SystemState>) -> Result<Snapshot, String> {
    state
        .latest
        .lock()
        .map_err(|_| "snapshot state lock failed".to_string())?
        .clone()
        .ok_or_else(|| "The first system sample is still starting".into())
}

fn collect_snapshot(app: &AppHandle, state: &SystemState) -> Result<Snapshot, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pcpu=,rss=,etime=,comm="])
        .output()
        .map_err(|e| format!("process collection failed: {e}"))?;
    if !output.status.success() {
        return Err("process collection failed".into());
    }

    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(cpu), Some(rss), Some(elapsed)) =
            (fields.next(), fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(parent_pid), Ok(cpu_percent), Ok(rss_kb)) = (
            pid.parse::<u32>(),
            ppid.parse::<u32>(),
            cpu.parse::<f32>(),
            rss.parse::<u64>(),
        ) else {
            continue;
        };
        let name = fields.collect::<Vec<_>>().join(" ");
        let base = name.rsplit('/').next().unwrap_or(&name);
        let protected = PROTECTED.iter().any(|process| base == *process);
        let developer = DEVELOPER
            .iter()
            .any(|process| base.eq_ignore_ascii_case(process) || base.to_ascii_lowercase().contains(&process.to_ascii_lowercase()));
        processes.push(ProcessInfo {
            pid,
            parent_pid,
            name,
            cpu_percent,
            memory_bytes: rss_kb.saturating_mul(1024),
            runtime_seconds: parse_elapsed(elapsed),
            protected,
            developer,
        });
    }
    processes.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent));

    let memory_total = sysctl("hw.memsize");
    let memory_used = used_memory_bytes(memory_total);
    let logical_cpus = sysctl("hw.logicalcpu").max(1) as f32;
    let cpu_percent = processes.iter().map(|process| process.cpu_percent).sum::<f32>() / logical_cpus;
    let (network_rx, network_tx) = network_totals();
    let now = Instant::now();
    let (network_rx_bytes_per_second, network_tx_bytes_per_second) = {
        let mut previous = state.previous_network.lock().map_err(|_| "network state lock failed")?;
        let rates = previous
            .as_ref()
            .map(|(at, old_rx, old_tx)| {
                let elapsed = now.duration_since(*at).as_secs_f64().max(0.001);
                (
                    (network_rx.saturating_sub(*old_rx) as f64 / elapsed) as u64,
                    (network_tx.saturating_sub(*old_tx) as f64 / elapsed) as u64,
                )
            })
            .unwrap_or_default();
        *previous = Some((now, network_rx, network_tx));
        rates
    };
    let (disk_total, disk_used) = disk_usage();
    let thermals = read_thermal_snapshot(&state);
    let snapshot = Snapshot {
        sampled_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        cpu_percent,
        memory_total,
        memory_used,
        disk_total,
        disk_used,
        network_rx_bytes_per_second,
        network_tx_bytes_per_second,
        battery_percent: battery_level(),
        cpu_temp_c: thermals.cpu_temp_c,
        cpu_temp_source: thermals.cpu_temp_source,
        cpu_performance_temp_c: thermals.cpu_performance_temp_c,
        cpu_efficiency_temp_c: thermals.cpu_efficiency_temp_c,
        gpu_temp_c: thermals.gpu_temp_c,
        ssd_temp_c: thermals.ssd_temp_c,
        battery_temp_c: thermals.battery_temp_c,
        ambient_temp_c: thermals.ambient_temp_c,
        processes,
    };

    let settings = state.settings.lock().map_err(|_| "settings lock failed")?.clone();
    update_tray_title(app, &settings, &snapshot);
    *state.latest.lock().map_err(|_| "snapshot state lock failed")? = Some(snapshot.clone());
    Ok(snapshot)
}

fn start_background_sampler(app: AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<SystemState>();
        let _ = collect_snapshot(&app, &state);
        let interval = state
            .settings
            .lock()
            .map(|settings| settings.sample_interval_seconds.clamp(1, 10))
            .unwrap_or(2);
        std::thread::sleep(Duration::from_secs(interval));
    });
}

fn update_tray_title(app: &AppHandle, settings: &Settings, snapshot: &Snapshot) {
    if let Some(tray) = app.tray_by_id("main") {
        let title = tray_title(settings, snapshot);
        let _ = tray.set_title(Some(&title));
    }
}

fn tray_title(settings: &Settings, snapshot: &Snapshot) -> String {
    let mut items = Vec::new();
    if settings.show_cpu {
        items.push(format!("CPU {:.0}%", snapshot.cpu_percent.max(0.0)));
    }
    if settings.show_memory {
        items.push(format!("RAM {}", short_bytes(snapshot.memory_used, settings.binary_units)));
    }
    if settings.show_disk && snapshot.disk_total > 0 {
        let percent = snapshot.disk_used.saturating_mul(100) / snapshot.disk_total;
        items.push(format!("SSD {percent}%"));
    }
    if settings.show_network {
        items.push(format!(
            "↓{} ↑{}",
            short_bytes(snapshot.network_rx_bytes_per_second, settings.binary_units),
            short_bytes(snapshot.network_tx_bytes_per_second, settings.binary_units)
        ));
    }
    if settings.show_battery {
        if let Some(percent) = snapshot.battery_percent {
            items.push(format!("BAT {percent}%"));
        }
    }
    if settings.show_cpu_temperature {
        append_temperature(&mut items, "CPU", snapshot.cpu_temp_c);
    }
    if settings.show_performance_temperature {
        append_temperature(&mut items, "P", snapshot.cpu_performance_temp_c);
    }
    if settings.show_efficiency_temperature {
        append_temperature(&mut items, "E", snapshot.cpu_efficiency_temp_c);
    }
    if settings.show_gpu_temperature {
        append_temperature(&mut items, "GPU", snapshot.gpu_temp_c);
    }
    if settings.show_ssd_temperature {
        append_temperature(&mut items, "SSD", snapshot.ssd_temp_c);
    }
    if settings.show_battery_temperature {
        append_temperature(&mut items, "BAT", snapshot.battery_temp_c);
    }
    if settings.show_ambient_temperature {
        append_temperature(&mut items, "AMB", snapshot.ambient_temp_c);
    }
    if items.is_empty() { "CPU Guardian".into() } else { items.join("  ") }
}

fn append_temperature(items: &mut Vec<String>, label: &str, temperature: Option<f32>) {
    if let Some(temperature) = temperature {
        items.push(format!("{label} {:.0}°", temperature));
    }
}

fn valid_temperature(value: f32) -> Option<f32> {
    // power-monitor documents 0°C as its sentinel for an absent SMC sensor.
    (value.is_finite() && (0.0..=125.0).contains(&value) && value > 0.0).then_some(value)
}

#[cfg(target_os = "macos")]
fn read_thermal_snapshot(state: &SystemState) -> ThermalSnapshot {
    let Some(reading) = state
        .smc
        .lock()
        .ok()
        .and_then(|mut smc| smc.as_mut().map(|smc| smc.read_thermals()))
    else {
        return ThermalSnapshot::default();
    };

    let cpu_performance_temp_c = valid_temperature(reading.cpu_performance);
    let cpu_efficiency_temp_c = valid_temperature(reading.cpu_efficiency);
    let proximity = valid_temperature(reading.cpu_proximity);
    let cluster_average = [cpu_performance_temp_c, cpu_efficiency_temp_c]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let cpu_temp_c = proximity.or_else(|| {
        (!cluster_average.is_empty())
            .then(|| cluster_average.iter().sum::<f32>() / cluster_average.len() as f32)
    });
    let cpu_temp_source = proximity
        .map(|_| "CPU proximity".to_string())
        .or_else(|| cpu_temp_c.map(|_| "P/E cluster average".to_string()));

    ThermalSnapshot {
        cpu_temp_c,
        cpu_temp_source,
        cpu_performance_temp_c,
        cpu_efficiency_temp_c,
        gpu_temp_c: valid_temperature(reading.gpu),
        ssd_temp_c: valid_temperature(reading.ssd),
        battery_temp_c: valid_temperature(reading.battery),
        ambient_temp_c: valid_temperature(reading.ambient),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_thermal_snapshot(_state: &SystemState) -> ThermalSnapshot {
    ThermalSnapshot::default()
}

fn short_bytes(bytes: u64, binary: bool) -> String {
    let base = if binary { 1024.0 } else { 1000.0 };
    let units = if binary { ["B", "KiB", "MiB", "GiB", "TiB"] } else { ["B", "KB", "MB", "GB", "TB"] };
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= base && unit < units.len() - 1 {
        value /= base;
        unit += 1;
    }
    if unit == 0 { format!("{} B", bytes) } else { format!("{value:.1} {}", units[unit]) }
}

fn sysctl(key: &str) -> u64 {
    Command::new("/usr/sbin/sysctl")
        .args(["-n", key])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

fn used_memory_bytes(total: u64) -> u64 {
    let Ok(output) = Command::new("/usr/bin/vm_stat").output() else { return 0 };
    let text = String::from_utf8_lossy(&output.stdout);
    let page_size = text
        .lines()
        .next()
        .and_then(|line| line.split(" of ").nth(1))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(4096);
    let page_count = |label: &str| -> u64 {
        text.lines()
            .find(|line| line.starts_with(label))
            .and_then(|line| line.rsplit_once(':'))
            .and_then(|(_, value)| value.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let used_pages = page_count("Pages active")
        .saturating_add(page_count("Pages wired down"))
        .saturating_add(page_count("Pages occupied by compressor"));
    used_pages.saturating_mul(page_size).min(total)
}

fn disk_usage() -> (u64, u64) {
    let Ok(output) = Command::new("/bin/df").args(["-k", "/"]).output() else { return (0, 0) };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .nth(1)
        .and_then(|line| {
            let mut fields = line.split_whitespace();
            let total_kb = fields.nth(1)?.parse::<u64>().ok()?;
            let used_kb = fields.next()?.parse::<u64>().ok()?;
            Some((total_kb.saturating_mul(1024), used_kb.saturating_mul(1024)))
        })
        .unwrap_or_default()
}

fn network_totals() -> (u64, u64) {
    let Ok(output) = Command::new("/usr/sbin/netstat").args(["-ibn"]).output() else { return (0, 0) };
    let mut received = 0_u64;
    let mut sent = 0_u64;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 10 || !fields[0].starts_with("en") || !fields[2].starts_with("<Link#") {
            continue;
        }
        received = received.saturating_add(fields[6].parse::<u64>().unwrap_or(0));
        sent = sent.saturating_add(fields[9].parse::<u64>().unwrap_or(0));
    }
    (received, sent)
}

fn battery_level() -> Option<u8> {
    let output = Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().ok()?;
    String::from_utf8(output.stdout).ok()?.split('%').next()?.split_whitespace().last()?.parse().ok()
}

fn parse_elapsed(value: &str) -> u64 {
    let parts = value.split(':').collect::<Vec<_>>();
    let number = |value: &str| value.parse::<u64>().unwrap_or(0);
    match parts.as_slice() {
        [seconds] => number(seconds),
        [minutes, seconds] => number(minutes) * 60 + number(seconds),
        [hours_or_days, minutes, seconds] => {
            let (days, hours) = hours_or_days.split_once('-').map(|(days, hours)| (number(days), number(hours))).unwrap_or((0, number(hours_or_days)));
            days * 86_400 + hours * 3_600 + number(minutes) * 60 + number(seconds)
        }
        _ => 0,
    }
}

fn show_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![process_snapshot, load_settings, save_settings])
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let settings_path = app_data.join("settings.json");
            let is_first_run = !settings_path.exists();
            let settings = fs::read_to_string(&settings_path)
                .ok()
                .and_then(|contents| serde_json::from_str::<Settings>(&contents).ok())
                .unwrap_or_default();
            if is_first_run {
                fs::write(&settings_path, serde_json::to_vec_pretty(&settings)?)?;
            }
            app.manage(SystemState {
                settings: Mutex::new(settings.clone()),
                settings_path,
                previous_network: Mutex::new(None),
                latest: Mutex::new(None),
                #[cfg(target_os = "macos")]
                smc: Mutex::new(Smc::open().ok()),
            });

            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                let enabled = autostart.is_enabled().unwrap_or(false);
                if settings.start_at_login && !enabled {
                    let _ = autostart.enable();
                } else if !settings.start_at_login && enabled {
                    let _ = autostart.disable();
                }
            }

            let open = MenuItem::with_id(app, "open", "Open CPU Guardian", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit CPU Guardian", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("CPU Guardian")
                .title("CPU Guardian")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_dashboard(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_dashboard(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let app_handle = app.handle().clone();
            let state = app.state::<SystemState>();
            let _ = collect_snapshot(&app_handle, &state);
            start_background_sampler(app_handle);

            if let Some(window) = app.get_webview_window("main") {
                if settings.launch_hidden {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CPU Guardian");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_times_parse() {
        assert_eq!(parse_elapsed("01:02:03"), 3_723);
        assert_eq!(parse_elapsed("2-01:00:00"), 176_400);
    }

    #[test]
    fn protected_processes_are_exact_names() {
        assert!(PROTECTED.contains(&"WindowServer"));
        assert!(!PROTECTED.contains(&"MyWindowServer"));
    }
}
