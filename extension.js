/* ============================================
   System Monitor Panel — extension.js
   GNOME 50 Shell Extension
   ============================================ */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';


/* ── Helpers ──────────────────────────────────── */

/**
 * Read a small virtual file synchronously.
 * Perfectly fine for /proc and /sys reads.
 */
function readFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (ok) {
            const decoder = new TextDecoder('utf-8');
            return decoder.decode(contents);
        }
    } catch (_e) {
        // file may not exist on all systems
    }
    return null;
}

/**
 * Format a size given in kB to a human-readable string.
 */
function formatBytes(kB) {
    if (kB >= 1048576)
        return `${(kB / 1048576).toFixed(1)} GB`;
    else if (kB >= 1024)
        return `${(kB / 1024).toFixed(0)} MB`;
    return `${kB} kB`;
}

/**
 * Get a CSS class name based on a usage percentage threshold.
 */
function thresholdClass(percent) {
    if (percent >= 85)
        return 'critical';
    if (percent >= 60)
        return 'warning';
    return 'normal';
}

/**
 * Temperature threshold class (°C) for coloring.
 */
function tempThresholdClass(tempC) {
    if (tempC >= 85)
        return 'critical';
    if (tempC >= 65)
        return 'warning';
    return 'normal';
}

/**
 * Convert °C to °F.
 */
function celsiusToFahrenheit(c) {
    return c * 9 / 5 + 32;
}

/**
 * Friendly names for common thermal-zone / hwmon sensor identifiers.
 */
const TEMP_FRIENDLY_NAMES = {
    'x86_pkg_temp': 'CPU Package',
    'Package id 0': 'CPU Package',
    'coretemp': 'CPU',
    'acpitz': 'Motherboard',
    'pch_cannonlake': 'Chipset (PCH)',
    'pch_skylake': 'Chipset (PCH)',
    'pch_cometlake': 'Chipset (PCH)',
    'iwlwifi_1': 'Wi‑Fi',
    'iwlwifi': 'Wi‑Fi',
    'Composite': 'NVMe SSD',
    'nvme': 'NVMe SSD',
    'INT3400 Thermal': 'Thermal Policy',
    'amdgpu': 'GPU',
    'nouveau': 'GPU',
};

function friendlyTempName(raw) {
    if (TEMP_FRIENDLY_NAMES[raw])
        return TEMP_FRIENDLY_NAMES[raw];
    // Strip trailing digits from generic sensor ids (e.g. "SEN1")
    return raw;
}

/**
 * Return true if a sensor id/name is the whole-CPU (package) sensor.
 */
function isCpuPackageSensor(raw) {
    return raw === 'x86_pkg_temp' || raw === 'Package id 0';
}


/* ── System Metrics Collector ─────────────────── */

class SystemMetrics {
    constructor() {
        this._prevCpuTotal = [];
        this._prevCpuIdle = [];
    }

    /**
     * Read CPU usage from /proc/stat.
     * Returns { overall: Number, cores: [Number] } as percentages.
     */
    getCpuUsage() {
        const data = readFile('/proc/stat');
        if (!data)
            return {overall: 0, cores: []};

        const lines = data.split('\n');
        const cpuLines = lines.filter(l => /^cpu[0-9]*\s/.test(l));

        const results = [];

        for (const line of cpuLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5)
                continue;

            const user = parseInt(parts[1], 10);
            const nice = parseInt(parts[2], 10);
            const system = parseInt(parts[3], 10);
            const idle = parseInt(parts[4], 10);
            const iowait = parts[5] ? parseInt(parts[5], 10) : 0;
            const irq = parts[6] ? parseInt(parts[6], 10) : 0;
            const softirq = parts[7] ? parseInt(parts[7], 10) : 0;
            const steal = parts[8] ? parseInt(parts[8], 10) : 0;

            const totalIdle = idle + iowait;
            const total = user + nice + system + idle + iowait + irq + softirq + steal;

            results.push({name: parts[0], total, idle: totalIdle});
        }

        const usages = [];
        for (let i = 0; i < results.length; i++) {
            const {total, idle} = results[i];
            const prevTotal = this._prevCpuTotal[i] || 0;
            const prevIdle = this._prevCpuIdle[i] || 0;

            const dTotal = total - prevTotal;
            const dIdle = idle - prevIdle;

            let usage = 0;
            if (dTotal > 0)
                usage = ((dTotal - dIdle) / dTotal) * 100;

            usages.push(Math.round(usage * 10) / 10);

            this._prevCpuTotal[i] = total;
            this._prevCpuIdle[i] = idle;
        }

        return {
            overall: usages.length > 0 ? usages[0] : 0,
            cores: usages.slice(1),
        };
    }

    /**
     * Read memory info from /proc/meminfo (all values in kB).
     */
    getMemoryUsage() {
        const empty = {
            percent: 0, total: 0, available: 0, used: 0, free: 0,
            buffers: 0, cached: 0, swapTotal: 0, swapUsed: 0, swapPercent: 0,
        };

        const data = readFile('/proc/meminfo');
        if (!data)
            return empty;

        const values = {};
        for (const line of data.split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+)/);
            if (match)
                values[match[1]] = parseInt(match[2], 10);
        }

        const total = values['MemTotal'] || 0;
        const free = values['MemFree'] || 0;
        const available = values['MemAvailable'] !== undefined ? values['MemAvailable'] : free;
        const used = Math.max(0, total - available);
        const percent = total > 0 ? (used / total) * 100 : 0;
        const buffers = values['Buffers'] || 0;
        const cached = (values['Cached'] || 0) + (values['SReclaimable'] || 0);

        const swapTotal = values['SwapTotal'] || 0;
        const swapFree = values['SwapFree'] || 0;
        const swapUsed = Math.max(0, swapTotal - swapFree);
        const swapPercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

        return {percent, total, available, used, free, buffers, cached, swapTotal, swapUsed, swapPercent};
    }

    /**
     * Read temperatures from /sys/class/thermal and /sys/class/hwmon.
     * Returns [{ name (raw), tempC, isCpu }] sorted by temperature descending.
     */
    getTemperatures() {
        const temps = [];

        // Method 1: thermal_zone*
        try {
            const thermalDir = Gio.File.new_for_path('/sys/class/thermal');
            const enumerator = thermalDir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.startsWith('thermal_zone'))
                    continue;

                const typeStr = readFile(`/sys/class/thermal/${name}/type`);
                const tempStr = readFile(`/sys/class/thermal/${name}/temp`);

                if (tempStr) {
                    const millideg = parseInt(tempStr.trim(), 10);
                    if (!isNaN(millideg)) {
                        const raw = typeStr ? typeStr.trim() : name;
                        temps.push({
                            name: raw,
                            tempC: millideg / 1000,
                            isCpu: isCpuPackageSensor(raw),
                        });
                    }
                }
            }
            enumerator.close(null);
        } catch (_e) {
            // thermal_zone not available
        }

        // Method 2: hwmon fallback (if thermal_zone found nothing useful)
        if (temps.length === 0) {
            try {
                const hwmonDir = Gio.File.new_for_path('/sys/class/hwmon');
                const enumerator = hwmonDir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const hwmonName = info.get_name();
                    const basePath = `/sys/class/hwmon/${hwmonName}`;
                    const nameStr = readFile(`${basePath}/name`);
                    const chipName = nameStr ? nameStr.trim() : hwmonName;

                    for (let i = 1; i <= 16; i++) {
                        const tempStr = readFile(`${basePath}/temp${i}_input`);
                        if (!tempStr)
                            break;

                        const millideg = parseInt(tempStr.trim(), 10);
                        if (isNaN(millideg))
                            continue;

                        const labelStr = readFile(`${basePath}/temp${i}_label`);
                        const label = labelStr ? labelStr.trim() : chipName;
                        temps.push({
                            name: label,
                            tempC: millideg / 1000,
                            isCpu: isCpuPackageSensor(label) || chipName === 'coretemp',
                        });
                    }
                }
                enumerator.close(null);
            } catch (_e) {
                // hwmon not available
            }
        }

        temps.sort((a, b) => b.tempC - a.tempC);
        return temps;
    }

    /**
     * Overall system temperature: prefer the CPU-package sensor,
     * otherwise fall back to the hottest valid sensor.
     * Returns { tempC, name } or null.
     */
    getOverallTemperature(temps) {
        const list = temps || this.getTemperatures();
        const valid = list.filter(t => t.tempC > 0 && t.tempC < 130);
        if (valid.length === 0)
            return null;

        const cpu = valid.find(t => t.isCpu);
        if (cpu)
            return {tempC: cpu.tempC, name: friendlyTempName(cpu.name)};

        return {tempC: valid[0].tempC, name: friendlyTempName(valid[0].name)};
    }

    destroy() {
        this._prevCpuTotal = [];
        this._prevCpuIdle = [];
    }
}


/* ── Custom Cards and Components for Dropdown ─── */

const CpuCardItem = GObject.registerClass(
class CpuCardItem extends PopupMenu.PopupBaseMenuItem {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card',
        });
        this.set_vertical(true);
        this._extension = extension;

        // Header
        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-cpu-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-cpu',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'CPU Usage',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '0.0%',
            style_class: 'smp-card-value smp-color-cpu',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        // Overall progress bar
        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-cpu-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        // Per-core grid (always visible)
        const coresLabel = new St.Label({
            text: 'Per‑core usage',
            style_class: 'smp-section-subtitle',
        });
        this.add_child(coresLabel);

        this.coresContainer = new St.BoxLayout({
            style_class: 'smp-cores-container',
            vertical: true,
        });
        this.add_child(this.coresContainer);
        this._coreWidgets = [];
    }

    update(cpu) {
        const overall = cpu.overall;
        this.valueLabel.text = `${overall.toFixed(1)}%`;

        const clamped = Math.max(0, Math.min(100, overall));
        this.progressBarFill.set_width(Math.round((clamped / 100) * 254));

        // (Re)build per-core widgets only when the core count changes.
        if (this._coreWidgets.length !== cpu.cores.length) {
            this.coresContainer.remove_all_children();
            this._coreWidgets = [];

            for (let i = 0; i < cpu.cores.length; i += 2) {
                const row = new St.BoxLayout({style_class: 'smp-cores-row'});

                const w1 = this._createCoreWidget(i);
                row.add_child(w1.box);
                this._coreWidgets.push(w1);

                if (i + 1 < cpu.cores.length) {
                    const w2 = this._createCoreWidget(i + 1);
                    row.add_child(w2.box);
                    this._coreWidgets.push(w2);
                } else {
                    // Keep the single core aligned to the left column.
                    row.add_child(new St.Widget({x_expand: true, style_class: 'smp-core-box'}));
                }

                this.coresContainer.add_child(row);
            }
        }

        // Update per-core values.
        for (let i = 0; i < cpu.cores.length; i++) {
            const usage = cpu.cores[i];
            const w = this._coreWidgets[i];

            w.val.text = `${usage.toFixed(0)}%`;

            const cClamped = Math.max(0, Math.min(100, usage));
            w.barFill.set_width(Math.round((cClamped / 100) * 60));

            w.barFill.remove_style_class_name('smp-progress-normal');
            w.barFill.remove_style_class_name('smp-progress-warning');
            w.barFill.remove_style_class_name('smp-progress-critical');
            w.barFill.add_style_class_name(`smp-progress-${thresholdClass(usage)}`);
        }
    }

    _createCoreWidget(index) {
        const box = new St.BoxLayout({
            style_class: 'smp-core-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const label = new St.Label({
            text: `Core ${index}`,
            style_class: 'smp-core-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);

        const barBg = new St.BoxLayout({
            style_class: 'smp-mini-bar-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const barFill = new St.Widget({style_class: 'smp-mini-bar-fill'});
        barBg.add_child(barFill);
        box.add_child(barBg);

        const val = new St.Label({
            text: '0%',
            style_class: 'smp-core-value',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        box.add_child(val);

        return {box, label, barBg, barFill, val};
    }
});

const MemoryCardItem = GObject.registerClass(
class MemoryCardItem extends PopupMenu.PopupBaseMenuItem {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card',
        });
        this.set_vertical(true);

        // Header
        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-memory-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-mem',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'Memory',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '0.0%',
            style_class: 'smp-card-value smp-color-mem',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        // Main progress bar
        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-mem-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        // Detail grid
        this.usedLabel = this._addStatRow('Used / Total', '—');
        this.availLabel = this._addStatRow('Available', '—');
        this.freeLabel = this._addStatRow('Free', '—');
        this.cachedLabel = this._addStatRow('Cached', '—');
        this.buffersLabel = this._addStatRow('Buffers', '—');

        // Swap section
        this.swapBox = new St.BoxLayout({vertical: true, style_class: 'smp-swap-box'});
        this.add_child(this.swapBox);

        const swapHeader = new St.BoxLayout({style_class: 'smp-swap-header'});
        const swapTitle = new St.Label({text: 'Swap', style_class: 'smp-swap-title'});
        this.swapValueLabel = new St.Label({text: '0%', style_class: 'smp-swap-value'});
        swapHeader.add_child(swapTitle);
        swapHeader.add_child(new St.Widget({x_expand: true}));
        swapHeader.add_child(this.swapValueLabel);
        this.swapBox.add_child(swapHeader);

        this.swapBarBg = new St.BoxLayout({style_class: 'smp-swap-bar-bg'});
        this.swapBarFill = new St.Widget({style_class: 'smp-swap-bar-fill'});
        this.swapBarBg.add_child(this.swapBarFill);
        this.swapBox.add_child(this.swapBarBg);
    }

    /** Add a "Label ............ value" detail row and return the value label. */
    _addStatRow(titleText, valueText) {
        const row = new St.BoxLayout({style_class: 'smp-detail-row'});

        const title = new St.Label({
            text: titleText,
            style_class: 'smp-detail-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(title);

        row.add_child(new St.Widget({x_expand: true}));

        const value = new St.Label({
            text: valueText,
            style_class: 'smp-detail-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(value);

        this.add_child(row);
        return value;
    }

    update(mem) {
        this.valueLabel.text = `${mem.percent.toFixed(1)}%`;

        const clamped = Math.max(0, Math.min(100, mem.percent));
        this.progressBarFill.set_width(Math.round((clamped / 100) * 254));

        this.usedLabel.text = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
        this.availLabel.text = formatBytes(mem.available);
        this.freeLabel.text = formatBytes(mem.free);
        this.cachedLabel.text = formatBytes(mem.cached);
        this.buffersLabel.text = formatBytes(mem.buffers);

        if (mem.swapTotal > 0) {
            this.swapBox.visible = true;
            this.swapValueLabel.text =
                `${Math.round(mem.swapPercent)}%  ·  ${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}`;

            const sClamped = Math.max(0, Math.min(100, mem.swapPercent));
            this.swapBarFill.set_width(Math.round((sClamped / 100) * 254));
        } else {
            this.swapBox.visible = false;
        }
    }
});

const TempCardItem = GObject.registerClass(
class TempCardItem extends PopupMenu.PopupBaseMenuItem {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card',
        });
        this.set_vertical(true);

        // Header
        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-temperature-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-temp',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'Temperature',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '—',
            style_class: 'smp-card-value smp-color-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        // Overall label + progress bar
        this.overallLabel = new St.Label({
            text: 'Overall system temperature',
            style_class: 'smp-section-subtitle',
        });
        this.add_child(this.overallLabel);

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-temp-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        // Sensor breakdown
        this.sensorsContainer = new St.BoxLayout({
            style_class: 'smp-sensors-container',
            vertical: true,
        });
        this.add_child(this.sensorsContainer);
    }

    update(temps, overall, isFahrenheit) {
        const suffix = isFahrenheit ? '°F' : '°C';
        const conv = t => (isFahrenheit ? celsiusToFahrenheit(t) : t);

        if (overall) {
            this.valueLabel.text = `${Math.round(conv(overall.tempC))}${suffix}`;
            this.overallLabel.text = `Overall · ${overall.name}`;

            const tempPercent = Math.min(100, Math.max(0, (overall.tempC / 110) * 100));
            this.progressBarFill.set_width(Math.round((tempPercent / 100) * 254));

            this.progressBarFill.remove_style_class_name('smp-progress-normal');
            this.progressBarFill.remove_style_class_name('smp-progress-warning');
            this.progressBarFill.remove_style_class_name('smp-progress-critical');
            this.progressBarFill.add_style_class_name(`smp-progress-${tempThresholdClass(overall.tempC)}`);
        } else {
            this.valueLabel.text = 'N/A';
            this.overallLabel.text = 'Overall system temperature';
            this.progressBarFill.set_width(0);
        }

        // Build a clean, de-duplicated sensor list.
        this.sensorsContainer.remove_all_children();

        const seen = new Set();
        const rows = [];
        for (const s of temps) {
            if (s.tempC <= 20 || s.tempC >= 130)
                continue; // skip bogus / inactive sensors
            const friendly = friendlyTempName(s.name);
            if (seen.has(friendly))
                continue;
            seen.add(friendly);
            rows.push({name: friendly, tempC: s.tempC});
            if (rows.length >= 6)
                break;
        }

        if (rows.length === 0) {
            this.sensorsContainer.add_child(new St.Label({
                text: 'No active temperature sensors found',
                style_class: 'smp-no-sensors',
            }));
            return;
        }

        for (const sensor of rows) {
            const row = new St.BoxLayout({style_class: 'smp-sensor-row'});

            row.add_child(new St.Label({
                text: sensor.name,
                style_class: 'smp-sensor-name',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            row.add_child(new St.Widget({x_expand: true}));

            row.add_child(new St.Label({
                text: `${conv(sensor.tempC).toFixed(1)}${suffix}`,
                style_class: 'smp-sensor-value',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            this.sensorsContainer.add_child(row);
        }
    }
});

const FooterItem = GObject.registerClass(
class FooterItem extends PopupMenu.PopupBaseMenuItem {
    _init(extension, indicator) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-footer',
        });

        const box = new St.BoxLayout({style_class: 'smp-footer-box', x_expand: true});
        this.add_child(box);

        // System Monitor button
        const monitorBtn = this._makeButton(
            'utilities-system-monitor-symbolic', 'System Monitor');
        monitorBtn.connect('clicked', () => {
            indicator.menu.close();
            this._launchSystemMonitor();
        });
        box.add_child(monitorBtn);

        box.add_child(new St.Widget({width: 12}));

        // Preferences button
        const prefsBtn = this._makeButton(
            'preferences-system-symbolic', 'Preferences');
        prefsBtn.connect('clicked', () => {
            indicator.menu.close();
            try {
                extension.openPreferences();
            } catch (e) {
                console.error('System Monitor Panel: openPreferences failed', e);
            }
        });
        box.add_child(prefsBtn);
    }

    _makeButton(iconName, labelText) {
        const btn = new St.Button({
            style_class: 'smp-footer-button',
            x_expand: true,
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        const content = new St.BoxLayout({style_class: 'smp-footer-btn-content'});
        content.add_child(new St.Icon({icon_name: iconName, style_class: 'smp-footer-btn-icon'}));
        content.add_child(new St.Label({text: labelText, style_class: 'smp-footer-btn-label'}));
        btn.set_child(content);
        return btn;
    }

    _launchSystemMonitor() {
        // Launch through a proper app-launch context first…
        try {
            const appInfo = Gio.AppInfo.create_from_commandline(
                'gnome-system-monitor', 'System Monitor', Gio.AppInfoCreateFlags.NONE);
            appInfo.launch([], global.create_app_launch_context(0, -1));
            return;
        } catch (e) {
            console.error('System Monitor Panel: AppInfo launch failed', e);
        }
        // …and fall back to a raw spawn if that fails.
        try {
            GLib.spawn_command_line_async('gnome-system-monitor');
        } catch (e) {
            Main.notify('System Monitor Panel', 'Could not launch gnome-system-monitor.');
            console.error('System Monitor Panel: spawn launch failed', e);
        }
    }
});


/* ── Panel Indicator ──────────────────────────── */

const SystemMonitorIndicator = GObject.registerClass(
class SystemMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'System Monitor Panel');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._metrics = new SystemMetrics();
        this._timerId = null;
        this._seedTimeoutId = null;

        // ── Build panel layout ──
        this._panelBox = new St.BoxLayout({
            style_class: 'smp-panel-box panel-status-indicators-box',
        });
        this.add_child(this._panelBox);

        this._cpuBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-cpu-symbolic.svg`), '—');
        this._panelBox.add_child(this._cpuBox.container);

        this._memBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-memory-symbolic.svg`), '—');
        this._panelBox.add_child(this._memBox.container);

        this._tempBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-temperature-symbolic.svg`), '—');
        this._panelBox.add_child(this._tempBox.container);

        // ── Build dropdown ──
        this._buildDropdownMenu();

        // ── Signals ──
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._refreshAll();
        });

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._applySettings();
            this._refreshAll();
        });

        // ── Initial settings + seed + timer ──
        this._applySettings();

        // Seed the CPU delta, then do the first real refresh shortly after.
        this._metrics.getCpuUsage();
        this._seedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._refreshAll();
            this._seedTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });

        this._startTimer();
    }

    _createMetricBox(gicon, labelText) {
        const container = new St.BoxLayout({
            style_class: 'smp-metric-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            gicon,
            style_class: 'smp-metric-icon system-status-icon',
        });
        container.add_child(icon);

        const label = new St.Label({
            text: labelText,
            style_class: 'smp-metric-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        container.add_child(label);

        return {container, icon, label};
    }

    _buildDropdownMenu() {
        this.menu.box.add_style_class_name('smp-dropdown-menu');

        this._cpuCard = new CpuCardItem(this._extension);
        this.menu.addMenuItem(this._cpuCard);

        this._memCard = new MemoryCardItem(this._extension);
        this.menu.addMenuItem(this._memCard);

        this._tempCard = new TempCardItem(this._extension);
        this.menu.addMenuItem(this._tempCard);

        this._footer = new FooterItem(this._extension, this);
        this.menu.addMenuItem(this._footer);
    }

    _applySettings() {
        const showCpu = this._settings.get_boolean('show-cpu');
        const showMem = this._settings.get_boolean('show-memory');
        const showTemp = this._settings.get_boolean('show-temperature');
        const showIcons = this._settings.get_boolean('show-icons');
        const showLabels = this._settings.get_boolean('show-labels');

        this._cpuBox.container.visible = showCpu;
        this._memBox.container.visible = showMem;
        this._tempBox.container.visible = showTemp;

        this._cpuBox.icon.visible = showIcons;
        this._memBox.icon.visible = showIcons;
        this._tempBox.icon.visible = showIcons;

        this._cpuBox.label.visible = showLabels;
        this._memBox.label.visible = showLabels;
        this._tempBox.label.visible = showLabels;

        this._cpuCard.visible = showCpu;
        this._memCard.visible = showMem;
        this._tempCard.visible = showTemp;

        this._stopTimer();
        this._startTimer();
    }

    _startTimer() {
        const interval = Math.max(1, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshAll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    // Each metric is refreshed independently so a failure in one never
    // blocks the others.
    _refreshAll() {
        this._refreshCpu();
        this._refreshMemory();
        this._refreshTemperature();
    }

    _refreshCpu() {
        try {
            const cpu = this._metrics.getCpuUsage();
            const overall = Math.round(cpu.overall);
            this._cpuBox.label.text = `${overall}%`;
            this._setPanelLabelColor(this._cpuBox.label, overall);
            this._cpuCard.update(cpu);
        } catch (e) {
            console.error('System Monitor Panel: CPU refresh failed', e);
        }
    }

    _refreshMemory() {
        try {
            const mem = this._metrics.getMemoryUsage();
            const percent = Math.round(mem.percent);
            this._memBox.label.text = `${percent}%`;
            this._setPanelLabelColor(this._memBox.label, percent);
            this._memCard.update(mem);
        } catch (e) {
            console.error('System Monitor Panel: memory refresh failed', e);
        }
    }

    _refreshTemperature() {
        try {
            const unit = this._settings.get_string('temperature-unit');
            const isFahrenheit = unit === 'fahrenheit';

            const temps = this._metrics.getTemperatures();
            const overall = this._metrics.getOverallTemperature(temps);

            if (overall) {
                const displayTemp = isFahrenheit ? celsiusToFahrenheit(overall.tempC) : overall.tempC;
                const suffix = isFahrenheit ? '°F' : '°C';
                this._tempBox.label.text = `${Math.round(displayTemp)}${suffix}`;
                this._setPanelTempColor(this._tempBox.label, overall.tempC);
            } else {
                this._tempBox.label.text = 'N/A';
                this._setPanelLabelColor(this._tempBox.label, 0);
            }

            this._tempCard.update(temps, overall, isFahrenheit);
        } catch (e) {
            console.error('System Monitor Panel: temperature refresh failed', e);
        }
    }

    _setPanelLabelColor(label, percent) {
        label.remove_style_class_name('smp-label-normal');
        label.remove_style_class_name('smp-label-warning');
        label.remove_style_class_name('smp-label-critical');
        label.add_style_class_name(`smp-label-${thresholdClass(percent)}`);
    }

    _setPanelTempColor(label, tempC) {
        label.remove_style_class_name('smp-label-normal');
        label.remove_style_class_name('smp-label-warning');
        label.remove_style_class_name('smp-label-critical');
        label.add_style_class_name(`smp-label-${tempThresholdClass(tempC)}`);
    }

    destroy() {
        this._stopTimer();

        if (this._seedTimeoutId) {
            GLib.source_remove(this._seedTimeoutId);
            this._seedTimeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._metrics.destroy();
        this._metrics = null;
        this._settings = null;

        super.destroy();
    }
});


/* ── Extension Entry Point ────────────────────── */

export default class SystemMonitorPanelExtension extends Extension {
    enable() {
        this._indicator = new SystemMonitorIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
