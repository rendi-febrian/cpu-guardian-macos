import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import logoUrl from './assets/cpu-guardian-logo.svg';
import './App.css';

type Proc = {
  pid: number;
  parentPid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  runtimeSeconds: number;
  protected: boolean;
  developer: boolean;
};

type Snapshot = {
  sampledAt: number;
  cpuPercent: number;
  memoryTotal: number;
  memoryUsed: number;
  diskTotal: number;
  diskUsed: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  batteryPercent: number | null;
  cpuTempC: number | null;
  cpuTempSource: string | null;
  cpuPerformanceTempC: number | null;
  cpuEfficiencyTempC: number | null;
  gpuTempC: number | null;
  ssdTempC: number | null;
  batteryTempC: number | null;
  ambientTempC: number | null;
  processes: Proc[];
};

type Settings = {
  sampleIntervalSeconds: number;
  showCpu: boolean;
  showMemory: boolean;
  showDisk: boolean;
  showNetwork: boolean;
  showBattery: boolean;
  showCpuTemperature: boolean;
  showPerformanceTemperature: boolean;
  showEfficiencyTemperature: boolean;
  showGpuTemperature: boolean;
  showSsdTemperature: boolean;
  showBatteryTemperature: boolean;
  showAmbientTemperature: boolean;
  startAtLogin: boolean;
  launchHidden: boolean;
  theme: 'system' | 'dark' | 'light';
  binaryUnits: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  sampleIntervalSeconds: 2,
  showCpu: true,
  showMemory: true,
  showDisk: false,
  showNetwork: false,
  showBattery: false,
  showCpuTemperature: true,
  showPerformanceTemperature: false,
  showEfficiencyTemperature: false,
  showGpuTemperature: false,
  showSsdTemperature: false,
  showBatteryTemperature: false,
  showAmbientTemperature: false,
  startAtLogin: true,
  launchHidden: true,
  theme: 'system',
  binaryUnits: false,
};

const NAV = [
  { id: 'Overview', icon: '◫' },
  { id: 'Thermals', icon: '♨' },
  { id: 'Processes', icon: '▤' },
  { id: 'Developer Tools', icon: '⌘' },
  { id: 'Settings', icon: '⚙' },
];

function formatBytes(bytes: number, binary: boolean, rate = false) {
  const base = binary ? 1024 : 1000;
  const units = binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  const text = unit === 0 ? `${Math.round(value)} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
  return rate ? `${text}/s` : text;
}

function trayPreview(settings: Settings, data: Snapshot | null) {
  if (!data) return 'CPU 0%  RAM —';
  const values: string[] = [];
  if (settings.showCpu) values.push(`CPU ${Math.round(data.cpuPercent)}%`);
  if (settings.showMemory) values.push(`RAM ${formatBytes(data.memoryUsed, settings.binaryUnits)}`);
  if (settings.showDisk && data.diskTotal) values.push(`SSD ${Math.round((data.diskUsed / data.diskTotal) * 100)}%`);
  if (settings.showNetwork) {
    values.push(`↓${formatBytes(data.networkRxBytesPerSecond, settings.binaryUnits, true)} ↑${formatBytes(data.networkTxBytesPerSecond, settings.binaryUnits, true)}`);
  }
  if (settings.showBattery && data.batteryPercent !== null) values.push(`BAT ${data.batteryPercent}%`);
  if (settings.showCpuTemperature && data.cpuTempC !== null) values.push(`CPU ${Math.round(data.cpuTempC)}°`);
  if (settings.showPerformanceTemperature && data.cpuPerformanceTempC !== null) values.push(`P ${Math.round(data.cpuPerformanceTempC)}°`);
  if (settings.showEfficiencyTemperature && data.cpuEfficiencyTempC !== null) values.push(`E ${Math.round(data.cpuEfficiencyTempC)}°`);
  if (settings.showGpuTemperature && data.gpuTempC !== null) values.push(`GPU ${Math.round(data.gpuTempC)}°`);
  if (settings.showSsdTemperature && data.ssdTempC !== null) values.push(`SSD ${Math.round(data.ssdTempC)}°`);
  if (settings.showBatteryTemperature && data.batteryTempC !== null) values.push(`BAT ${Math.round(data.batteryTempC)}°`);
  if (settings.showAmbientTemperature && data.ambientTempC !== null) values.push(`AMB ${Math.round(data.ambientTempC)}°`);
  return values.length ? values.join('  ') : 'CPU Guardian';
}

function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('Overview');
  const [query, setQuery] = useState('');

  useEffect(() => {
    invoke<Settings>('load_settings')
      .then((value) => setSettings(value))
      .catch((reason) => setError(String(reason)))
      .finally(() => setSettingsReady(true));
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    let active = true;
    const poll = () => {
      invoke<Snapshot>('process_snapshot')
        .then((snapshot) => {
          if (!active) return;
          setData(snapshot);
          setError('');
          setHistory((items) => [...items.slice(-35), snapshot.cpuPercent]);
        })
        .catch((reason) => active && setError(String(reason)));
    };
    poll();
    const interval = window.setInterval(poll, settings.sampleIntervalSeconds * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [settingsReady, settings.sampleIntervalSeconds]);

  const visibleProcesses = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return (data?.processes ?? []).filter((process) => `${process.name} ${process.pid}`.toLowerCase().includes(lower));
  }, [data, query]);

  const saveSettings = async (next: Settings) => {
    setSettings(next);
    try {
      const saved = await invoke<Settings>('save_settings', { settings: next });
      setSettings(saved);
      setError('');
    } catch (reason) {
      setError(`Settings could not be saved: ${String(reason)}`);
    }
  };

  const changeSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    void saveSettings({ ...settings, [key]: value });
  };

  const themeClass = settings.theme === 'system' ? 'theme-system' : `theme-${settings.theme}`;
  const windowServer = data?.processes.find((process) => process.name.endsWith('/WindowServer') || process.name === 'WindowServer');
  const developerProcesses = visibleProcesses.filter((process) => process.developer);

  return (
    <div className={`shell ${themeClass}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brandIcon" src={logoUrl} alt="" />
          <span><b>CPU Guardian</b><small>MAC SYSTEM MONITOR</small></span>
        </div>
        <div className="navLabel">MONITOR</div>
        <nav>
          {NAV.map((item) => (
            <button key={item.id} className={`nav ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              <span>{item.icon}</span>{item.id}
            </button>
          ))}
        </nav>
        <div className="sidebarBottom">
          <span className="liveDot" /> Running in menu bar
          <small>Updates every {settings.sampleIntervalSeconds}s</small>
        </div>
      </aside>

      <main className="main">
        <header className="pageHeader">
          <div>
            <div className="eyebrow">SYSTEM MONITOR / {tab.toUpperCase()}</div>
            <h1>{tab}</h1>
          </div>
          <div className="topRight">
            <span className="status"><i /> LIVE</span>
            <span className="chip">macOS · Apple Silicon</span>
          </div>
        </header>

        {error && <div className="errorBanner">{error}</div>}
        {!data ? <div className="loading">Collecting live system metrics…</div> : (
          <>
            {tab === 'Overview' && (
              <>
                <section className="metricsGrid">
                  <MetricCard title="CPU USAGE" value={`${data.cpuPercent.toFixed(1)}%`} note="System utilization" progress={data.cpuPercent} tone="green" />
                  <MetricCard title="MEMORY USED" value={formatBytes(data.memoryUsed, settings.binaryUnits)} note={`of ${formatBytes(data.memoryTotal, settings.binaryUnits)} physical memory`} progress={data.memoryTotal ? (data.memoryUsed / data.memoryTotal) * 100 : 0} tone="blue" />
                  <MetricCard title="DISK USED" value={formatBytes(data.diskUsed, settings.binaryUnits)} note={`of ${formatBytes(data.diskTotal, settings.binaryUnits)} · startup volume`} progress={data.diskTotal ? (data.diskUsed / data.diskTotal) * 100 : 0} tone="purple" />
                  <MetricCard title="NETWORK" value={`↓ ${formatBytes(data.networkRxBytesPerSecond, settings.binaryUnits, true)}`} note={`↑ ${formatBytes(data.networkTxBytesPerSecond, settings.binaryUnits, true)} sent`} progress={null} tone="orange" />
                </section>

                <section className="overviewGrid">
                  <article className="panel chartPanel">
                    <div className="panelHead"><div><h2>CPU activity</h2><p>Recent system utilization</p></div><span className="tag">LIVE</span></div>
                    <div className="chart">
                      <div className="chartLines"><i /><i /><i /><i /></div>
                      <div className="chartValue"><b>{data.cpuPercent.toFixed(1)}%</b><span>Current sample</span></div>
                      <svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label="Recent CPU activity">
                        <defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#8592ff" stopOpacity=".35" /><stop offset="1" stopColor="#8592ff" stopOpacity="0" /></linearGradient></defs>
                        <path d={chartPath(history)} fill="url(#chartFill)" stroke="none" />
                        <path d={chartPath(history, true)} fill="none" stroke="#909cff" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                      </svg>
                    </div>
                  </article>

                  <article className="panel systemPanel">
                    <div className="panelHead"><div><h2>System signals</h2><p>Useful live readings at a glance</p></div><span className="tag">{data.processes.length} PROCESSES</span></div>
                    <div className="signalList">
                      <Signal icon="◈" label="WindowServer" detail="Observed CPU usage" value={windowServer ? `${windowServer.cpuPercent.toFixed(1)}%` : '—'} />
                      <Signal icon="◷" label="Battery" detail={data.batteryPercent === null ? 'Battery not detected' : 'Current charge'} value={data.batteryPercent === null ? '—' : `${data.batteryPercent}%`} />
                      <Signal icon="⌘" label="Developer tools" detail="Recognized running processes" value={`${data.processes.filter((process) => process.developer).length}`} />
                    </div>
                    <p className="finePrint">CPU and memory values are sampled from macOS process and VM statistics.</p>
                  </article>
                </section>

                <section className="panel thermalOverview">
                  <div className="panelHead"><div><h2>Temperatures</h2><p>Internal thermal sensors · updates every {settings.sampleIntervalSeconds}s</p></div><button className="textButton" onClick={() => setTab('Thermals')}>All sensors <span>→</span></button></div>
                  <ThermalGrid data={data} compact />
                </section>

                <ProcessTable processes={data.processes.slice(0, 8)} binaryUnits={settings.binaryUnits} title="Top processes" description="Sorted by current CPU usage" onViewAll={() => setTab('Processes')} />
              </>
            )}

            {tab === 'Thermals' && (
              <>
                <section className="panel thermalIntro">
                  <div className="thermalIntroIcon">♨</div>
                  <div><h2>Internal temperature sensors</h2><p>Live readings from the Mac’s system management controller. Sensor availability depends on the Mac model and macOS version; unavailable readings appear as “—”.</p></div>
                </section>
                <ThermalGrid data={data} />
              </>
            )}

            {tab === 'Processes' && (
              <ProcessTable processes={visibleProcesses} binaryUnits={settings.binaryUnits} title="Processes" description="macOS process snapshot · per-process CPU can exceed 100%" query={query} onQueryChange={setQuery} />
            )}

            {tab === 'Developer Tools' && (
              <ProcessTable processes={developerProcesses} binaryUnits={settings.binaryUnits} title="Developer workloads" description="Recognized build, editor, simulator, and runtime processes" query={query} onQueryChange={setQuery} />
            )}

            {tab === 'Settings' && (
              <SettingsPage
                settings={settings}
                data={data}
                onChange={changeSetting}
              />
            )}
          </>
        )}
        <footer>CPU Guardian <span>·</span> macOS native sample <span>·</span> {data ? new Date(data.sampledAt * 1000).toLocaleTimeString() : 'Waiting for first sample'}</footer>
      </main>
    </div>
  );
}

function chartPath(values: number[], stroke = false) {
  const points = values.length > 1 ? values : [0, 0];
  const line = points.map((value, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 600;
    const y = 102 - Math.min(100, Math.max(0, value)) * 0.84;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return stroke ? line : `${line} L 600 120 L 0 120 Z`;
}

function MetricCard({ title, value, note, progress, tone }: { title: string; value: string; note: string; progress: number | null; tone: string }) {
  return (
    <article className="metricCard">
      <div className="metricTitle">{title}<span className={`metricGlyph ${tone}`}>◌</span></div>
      <strong>{value}</strong>
      {progress !== null && <div className={`meter ${tone}`}><i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>}
      {progress === null && <div className="meterPlaceholder" />}
      <small>{note}</small>
    </article>
  );
}

function ThermalGrid({ data, compact = false }: { data: Snapshot; compact?: boolean }) {
  const metrics = [
    { title: 'CPU TEMPERATURE', value: data.cpuTempC, note: data.cpuTempSource ?? 'CPU sensor unavailable', tone: 'orange' },
    { title: 'PERFORMANCE CLUSTER', value: data.cpuPerformanceTempC, note: 'P-core cluster', tone: 'red' },
    { title: 'EFFICIENCY CLUSTER', value: data.cpuEfficiencyTempC, note: 'E-core cluster', tone: 'purple' },
    { title: 'GPU TEMPERATURE', value: data.gpuTempC, note: 'GPU die sensor', tone: 'blue' },
    { title: 'SSD TEMPERATURE', value: data.ssdTempC, note: 'Internal storage sensor', tone: 'green' },
    { title: 'BATTERY TEMPERATURE', value: data.batteryTempC, note: 'Battery sensor', tone: 'yellow' },
    { title: 'AMBIENT TEMPERATURE', value: data.ambientTempC, note: 'Air inlet sensor', tone: 'cyan' },
  ];
  return (
    <div className={`thermalGrid ${compact ? 'compact' : ''}`}>
      {metrics.map((metric) => (
        <article className="thermalCard" key={metric.title}>
          <div className={`thermalIcon ${metric.tone}`}>♨</div>
          <div className="thermalCardText"><span>{metric.title}</span><small>{metric.note}</small></div>
          <strong className={metric.value === null ? 'unavailable' : ''}>{metric.value === null ? '—' : `${metric.value.toFixed(1)}°C`}</strong>
        </article>
      ))}
    </div>
  );
}

function Signal({ icon, label, detail, value }: { icon: string; label: string; detail: string; value: string }) {
  return <div className="signalRow"><span className="signalIcon">{icon}</span><span className="signalCopy"><b>{label}</b><small>{detail}</small></span><strong>{value}</strong></div>;
}

function ProcessTable({
  processes,
  binaryUnits,
  title,
  description,
  query,
  onQueryChange,
  onViewAll,
}: {
  processes: Proc[];
  binaryUnits: boolean;
  title: string;
  description: string;
  query?: string;
  onQueryChange?: (value: string) => void;
  onViewAll?: () => void;
}) {
  return (
    <section className="panel processPanel">
      <div className="panelHead">
        <div><h2>{title}</h2><p>{description}</p></div>
        {onQueryChange ? <input className="search" placeholder="Search name or PID…" value={query} onChange={(event) => onQueryChange(event.target.value)} /> : onViewAll && <button className="textButton" onClick={onViewAll}>View all <span>→</span></button>}
      </div>
      <div className="tableWrap">
        <table>
          <thead><tr><th>PROCESS</th><th>PID</th><th>CPU</th><th>MEMORY</th><th>RUNTIME</th><th>CLASSIFICATION</th></tr></thead>
          <tbody>
            {processes.slice(0, 100).map((process) => (
              <tr key={process.pid}>
                <td><span className="procDot" />{process.name.split('/').pop() || process.name}</td>
                <td>{process.pid}</td>
                <td className={process.cpuPercent > 80 ? 'hot' : ''}>{process.cpuPercent.toFixed(1)}%</td>
                <td>{formatBytes(process.memoryBytes, binaryUnits)}</td>
                <td>{formatRuntime(process.runtimeSeconds)}</td>
                <td><span className={`classTag ${process.protected ? 'protected' : process.developer ? 'developer' : ''}`}>{process.protected ? 'Protected' : process.developer ? 'Developer' : 'User process'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!processes.length && <div className="emptyState">No matching processes.</div>}
      </div>
    </section>
  );
}

function formatRuntime(seconds: number) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function SettingsPage({ settings, data, onChange }: { settings: Settings; data: Snapshot; onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void }) {
  return (
    <div className="settingsLayout">
      <section className="panel settingsPanel">
        <div className="panelHead"><div><h2>Menu bar</h2><p>Choose what CPU Guardian displays beside the clock.</p></div><span className="tag">LIVE PREVIEW</span></div>
        <div className="previewBar"><span className="previewDot" />{trayPreview(settings, data)}</div>
        <div className="settingList">
          <SettingRow label="CPU usage" description="System utilization percentage" checked={settings.showCpu} onChange={(value) => onChange('showCpu', value)} />
          <SettingRow label="Memory used" description="Used memory as a compact size" checked={settings.showMemory} onChange={(value) => onChange('showMemory', value)} />
          <SettingRow label="Disk usage" description="Used space on the startup volume" checked={settings.showDisk} onChange={(value) => onChange('showDisk', value)} />
          <SettingRow label="Network speed" description="Current receive and send rates" checked={settings.showNetwork} onChange={(value) => onChange('showNetwork', value)} />
          <SettingRow label="Battery level" description="Shown when this Mac has a battery" checked={settings.showBattery} onChange={(value) => onChange('showBattery', value)} />
          <SettingRow label="CPU temperature" description="CPU proximity, or cluster average when unavailable" checked={settings.showCpuTemperature} onChange={(value) => onChange('showCpuTemperature', value)} />
          <SettingRow label="Performance cluster temperature" description="P-core cluster sensor" checked={settings.showPerformanceTemperature} onChange={(value) => onChange('showPerformanceTemperature', value)} />
          <SettingRow label="Efficiency cluster temperature" description="E-core cluster sensor" checked={settings.showEfficiencyTemperature} onChange={(value) => onChange('showEfficiencyTemperature', value)} />
          <SettingRow label="GPU temperature" description="GPU die sensor" checked={settings.showGpuTemperature} onChange={(value) => onChange('showGpuTemperature', value)} />
          <SettingRow label="SSD temperature" description="Internal storage sensor" checked={settings.showSsdTemperature} onChange={(value) => onChange('showSsdTemperature', value)} />
          <SettingRow label="Battery temperature" description="Battery sensor" checked={settings.showBatteryTemperature} onChange={(value) => onChange('showBatteryTemperature', value)} />
          <SettingRow label="Ambient temperature" description="Air inlet sensor" checked={settings.showAmbientTemperature} onChange={(value) => onChange('showAmbientTemperature', value)} />
        </div>
      </section>

      <section className="panel settingsPanel">
        <div className="panelHead"><div><h2>Behavior</h2><p>Sampling, startup, and display preferences.</p></div></div>
        <div className="settingSelectRow"><span><b>Refresh interval</b><small>How often system statistics update</small></span><select value={settings.sampleIntervalSeconds} onChange={(event) => onChange('sampleIntervalSeconds', Number(event.target.value))}><option value={1}>1 second</option><option value={2}>2 seconds</option><option value={5}>5 seconds</option><option value={10}>10 seconds</option></select></div>
        <div className="settingList">
          <SettingRow label="Start at login" description="Open CPU Guardian when you sign in" checked={settings.startAtLogin} onChange={(value) => onChange('startAtLogin', value)} />
          <SettingRow label="Start in the menu bar" description="Keep the dashboard hidden when the app starts" checked={settings.launchHidden} onChange={(value) => onChange('launchHidden', value)} />
          <SettingRow label="Binary units" description="Use KiB, MiB, and GiB instead of KB, MB, and GB" checked={settings.binaryUnits} onChange={(value) => onChange('binaryUnits', value)} />
        </div>
        <div className="settingSelectRow last"><span><b>Appearance</b><small>Choose the dashboard color scheme</small></span><select value={settings.theme} onChange={(event) => onChange('theme', event.target.value as Settings['theme'])}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></div>
      </section>
      <div className="settingsNote"><span>ⓘ</span> Settings are saved on this Mac. Closing this window keeps CPU Guardian active in the menu bar.</div>
    </div>
  );
}

function SettingRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="settingRow">
      <span><b>{label}</b><small>{description}</small></span>
      <button className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button>
    </div>
  );
}

export default App;
