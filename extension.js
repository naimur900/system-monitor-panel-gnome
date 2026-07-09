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
    if (kB >= 1073741824)
        return `${(kB / 1073741824).toFixed(2)} TB`;
    else if (kB >= 1048576)
        return `${(kB / 1048576).toFixed(1)} GB`;
    else if (kB >= 1024)
        return `${(kB / 1024).toFixed(0)} MB`;
    return `${kB} kB`;
}

/**
 * Format a network speed given in bytes/second to a human-readable string.
 * When useBits is true, render as a bit rate (kbps/Mbps/Gbps) instead.
 * Bit rates use decimal (1000-based) units by convention; byte rates binary.
 */
function formatSpeed(bytesPerSec, useBits = false) {
    const b = Math.max(0, bytesPerSec);
    if (useBits) {
        const bits = b * 8;
        if (bits >= 1e9)
            return `${(bits / 1e9).toFixed(1)} Gbps`;
        if (bits >= 1e6)
            return `${(bits / 1e6).toFixed(1)} Mbps`;
        if (bits >= 1e3)
            return `${(bits / 1e3).toFixed(0)} kbps`;
        return `${Math.round(bits)} bps`;
    }
    if (b >= 1048576)
        return `${(b / 1048576).toFixed(1)} MB/s`;
    if (b >= 1024)
        return `${(b / 1024).toFixed(0)} KB/s`;
    return `${Math.round(b)} B/s`;
}

/**
 * Compact speed string for the tight panel area (e.g. "1.2M", "340K").
 */
function formatSpeedCompact(bytesPerSec, useBits = false) {
    const b = Math.max(0, bytesPerSec);
    if (useBits) {
        const bits = b * 8;
        if (bits >= 1e9)
            return `${(bits / 1e9).toFixed(1)}G`;
        if (bits >= 1e6)
            return `${(bits / 1e6).toFixed(1)}M`;
        if (bits >= 1e3)
            return `${Math.round(bits / 1e3)}K`;
        return `${Math.round(bits)}b`;
    }
    if (b >= 1048576)
        return `${(b / 1048576).toFixed(1)}M`;
    if (b >= 1024)
        return `${Math.round(b / 1024)}K`;
    return `${Math.round(b)}B`;
}

/**
 * Filesystem types that are block-backed but never interesting to report:
 * squashfs images (snaps, appimages) and read-only optical/boot images.
 */
const IGNORED_FS_TYPES = new Set(['squashfs', 'overlay', 'ramfs']);

/**
 * Mount-point prefixes where desktop environments auto-mount removable media.
 */
const EXTERNAL_MOUNT_PREFIXES = ['/run/media/', '/media/', '/mnt/'];

/**
 * /proc/mounts escapes spaces, tabs, newlines and backslashes as octal.
 */
function unescapeMountField(field) {
    return field.replace(/\\(\d{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Decide whether a mounted device lives on removable/external storage.
 *
 * A device is external when it is auto-mounted under a removable-media path,
 * sits behind USB/MMC in the sysfs device tree, or its backing disk sets the
 * `removable` flag. Device-mapper nodes (LUKS, LVM) have no /sys/class/block
 * symlink to walk, so those are only caught by the mount-point check.
 */
function isExternalDisk(device, mountPoint) {
    if (EXTERNAL_MOUNT_PREFIXES.some(p => mountPoint.startsWith(p)))
        return true;

    const blockName = device.slice('/dev/'.length);

    let target = null;
    try {
        target = GLib.file_read_link(`/sys/class/block/${blockName}`);
    } catch (_e) {
        return false;
    }
    if (!target)
        return false;

    if (target.includes('/usb') || target.includes('/mmc_host/'))
        return true;

    // Partitions carry no `removable` flag — it lives on the parent disk, which
    // is the directory containing the partition in the resolved sysfs path.
    let removable = readFile(`/sys/class/block/${blockName}/removable`);
    if (removable === null) {
        const segments = target.split('/');
        const diskName = segments[segments.length - 2];
        if (diskName)
            removable = readFile(`/sys/class/block/${diskName}/removable`);
    }

    return removable !== null && removable.trim() === '1';
}

/**
 * Query a mount point for its size/used/free in bytes, or null when the
 * filesystem cannot be stat'd (permissions, stale network mount, …).
 */
function queryFilesystemUsage(mountPoint) {
    try {
        const info = Gio.File.new_for_path(mountPoint).query_filesystem_info(
            'filesystem::size,filesystem::used,filesystem::free', null);

        const total = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        // filesystem::used is not reported by every backend; derive it there.
        const used = info.get_attribute_uint64('filesystem::used') ||
            Math.max(0, total - free);

        return {total, used, free};
    } catch (_e) {
        return null;
    }
}

/**
 * Human-friendly label for a mount point.
 */
function friendlyMountName(mountPoint) {
    if (mountPoint === '/')
        return 'Root';
    // Auto-mounted media lives at /run/media/<user>/<label>; the label is the
    // only part the user recognises.
    for (const prefix of EXTERNAL_MOUNT_PREFIXES) {
        if (mountPoint.startsWith(prefix))
            return mountPoint.split('/').pop() || mountPoint;
    }
    return mountPoint;
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
    return TEMP_FRIENDLY_NAMES[raw] || raw;
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
        this._prevRx = 0;
        this._prevTx = 0;
        this._prevNetTime = 0;
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
     * Read aggregate network throughput from /proc/net/dev.
     * Speeds are computed from the byte delta over the elapsed wall-clock time,
     * so they stay correct regardless of how often this is polled.
     * Returns { rxSpeed, txSpeed } in bytes/second and { rxTotal, txTotal } in bytes.
     */
    getNetworkSpeed() {
        const data = readFile('/proc/net/dev');
        const now = GLib.get_monotonic_time(); // microseconds
        if (!data)
            return {rxSpeed: 0, txSpeed: 0, rxTotal: 0, txTotal: 0};

        let rxTotal = 0;
        let txTotal = 0;
        for (const line of data.split('\n')) {
            const idx = line.indexOf(':');
            if (idx === -1)
                continue;

            const iface = line.slice(0, idx).trim();
            // Skip the loopback interface — it's not real traffic.
            if (iface === 'lo')
                continue;

            const parts = line.slice(idx + 1).trim().split(/\s+/);
            if (parts.length < 9)
                continue;

            const rx = parseInt(parts[0], 10);  // received bytes
            const tx = parseInt(parts[8], 10);  // transmitted bytes
            if (!isNaN(rx))
                rxTotal += rx;
            if (!isNaN(tx))
                txTotal += tx;
        }

        let rxSpeed = 0;
        let txSpeed = 0;
        if (this._prevNetTime > 0) {
            const dt = (now - this._prevNetTime) / 1e6; // seconds
            if (dt > 0) {
                rxSpeed = Math.max(0, (rxTotal - this._prevRx) / dt);
                txSpeed = Math.max(0, (txTotal - this._prevTx) / dt);
            }
        }

        this._prevRx = rxTotal;
        this._prevTx = txTotal;
        this._prevNetTime = now;

        return {rxSpeed, txSpeed, rxTotal, txTotal};
    }

    /**
     * Read mounted filesystem usage from /proc/mounts.
     *
     * External (removable/USB) disks are only included when includeExternal is
     * true. Sizes are in bytes. Returns [{ name, mountPoint, device, total,
     * used, free, percent, isExternal }] with internal disks first, each group
     * sorted by mount point.
     */
    getDiskUsage(includeExternal = false) {
        const data = readFile('/proc/mounts');
        if (!data)
            return [];

        const disks = [];
        // A device mounted more than once (btrfs subvolumes, bind mounts)
        // reports identical usage for each mount, so only keep the first.
        const seenDevices = new Set();

        for (const line of data.split('\n')) {
            const parts = line.split(/\s+/);
            if (parts.length < 3)
                continue;

            const device = unescapeMountField(parts[0]);
            const mountPoint = unescapeMountField(parts[1]);
            const fsType = parts[2];

            // Only real block-backed filesystems: this drops tmpfs, proc,
            // cgroup, gvfs and every other pseudo filesystem in one check.
            if (!device.startsWith('/dev/'))
                continue;
            if (IGNORED_FS_TYPES.has(fsType))
                continue;
            if (seenDevices.has(device))
                continue;

            const isExternal = isExternalDisk(device, mountPoint);
            if (isExternal && !includeExternal)
                continue;

            const usage = queryFilesystemUsage(mountPoint);
            if (!usage || usage.total <= 0)
                continue;

            seenDevices.add(device);
            disks.push({
                name: friendlyMountName(mountPoint),
                mountPoint,
                device,
                total: usage.total,
                used: usage.used,
                free: usage.free,
                percent: (usage.used / usage.total) * 100,
                isExternal,
            });
        }

        disks.sort((a, b) => {
            if (a.isExternal !== b.isExternal)
                return a.isExternal ? 1 : -1;
            return a.mountPoint.localeCompare(b.mountPoint);
        });
        return disks;
    }

    /**
     * Aggregate usage across the given disks. Returns { percent, used, total }.
     */
    getOverallDiskUsage(disks) {
        let used = 0;
        let total = 0;
        for (const d of disks) {
            used += d.used;
            total += d.total;
        }
        return {
            percent: total > 0 ? (used / total) * 100 : 0,
            used,
            total,
        };
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
        this._prevRx = 0;
        this._prevTx = 0;
        this._prevNetTime = 0;
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
        this.progressBarFill.set_width(Math.round((clamped / 100) * 500));

        // (Re)build per-core widgets only when the core count changes.
        if (this._coreWidgets.length !== cpu.cores.length) {
            this.coresContainer.remove_all_children();
            this._coreWidgets = [];

            for (let i = 0; i < cpu.cores.length; i += 2) {
                const row = new St.BoxLayout({style_class: 'smp-cores-row'});

                const w1 = this._createCoreWidget(i);
                row.add_child(w1.box);
                this._coreWidgets.push(w1);

                // Spacer between the columns: pushes the left column to the
                // start and the right column to the end (justified to the
                // edges) with the gap in the middle.
                row.add_child(new St.Widget({x_expand: true}));

                if (i + 1 < cpu.cores.length) {
                    const w2 = this._createCoreWidget(i + 1);
                    row.add_child(w2.box);
                    this._coreWidgets.push(w2);
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
            w.barFill.set_width(Math.round((cClamped / 100) * 150));

            w.barFill.remove_style_class_name('smp-progress-normal');
            w.barFill.remove_style_class_name('smp-progress-warning');
            w.barFill.remove_style_class_name('smp-progress-critical');
            w.barFill.add_style_class_name(`smp-progress-${thresholdClass(usage)}`);
        }
    }

    _createCoreWidget(index) {
        const box = new St.BoxLayout({
            style_class: 'smp-core-box',
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

        return {box, barFill, val};
    }
});

const MemoryCardItem = GObject.registerClass(
class MemoryCardItem extends St.BoxLayout {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card smp-card-half smp-card-half-left',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
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
        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
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

        this.swapBarBg = new St.BoxLayout({style_class: 'smp-swap-bar-bg smp-swap-bar-bg-half'});
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
        this.progressBarFill.set_width(Math.round((clamped / 100) * 220));

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
            this.swapBarFill.set_width(Math.round((sClamped / 100) * 220));
        } else {
            this.swapBox.visible = false;
        }
    }
});

const DiskCardItem = GObject.registerClass(
class DiskCardItem extends St.BoxLayout {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card smp-card-half smp-card-half-right',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.set_vertical(true);

        // Header
        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-disk-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-disk',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'Disk',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '—',
            style_class: 'smp-card-value smp-color-disk',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        // Combined usage across every listed filesystem
        this.overallLabel = new St.Label({
            text: 'Total storage used',
            style_class: 'smp-section-subtitle',
        });
        this.add_child(this.overallLabel);

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-disk-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        // Per-filesystem breakdown
        this.disksContainer = new St.BoxLayout({
            style_class: 'smp-disks-container',
            vertical: true,
        });
        this.add_child(this.disksContainer);
    }

    update(disks, overall) {
        if (disks.length > 0) {
            this.valueLabel.text = `${overall.percent.toFixed(1)}%`;
            this.overallLabel.text =
                `Total · ${formatBytes(overall.used / 1024)} / ${formatBytes(overall.total / 1024)}`;

            const clamped = Math.max(0, Math.min(100, overall.percent));
            this.progressBarFill.set_width(Math.round((clamped / 100) * 220));

            this.progressBarFill.remove_style_class_name('smp-progress-normal');
            this.progressBarFill.remove_style_class_name('smp-progress-warning');
            this.progressBarFill.remove_style_class_name('smp-progress-critical');
            this.progressBarFill.add_style_class_name(`smp-progress-${thresholdClass(overall.percent)}`);
        } else {
            this.valueLabel.text = 'N/A';
            this.overallLabel.text = 'Total storage used';
            this.progressBarFill.set_width(0);
        }

        // The mount list changes whenever a drive is plugged in or the external
        // toggle flips, so rebuild the rows rather than diff them.
        this.disksContainer.remove_all_children();

        if (disks.length === 0) {
            this.disksContainer.add_child(new St.Label({
                text: 'No mounted filesystems found',
                style_class: 'smp-no-sensors',
            }));
            return;
        }

        for (const disk of disks.slice(0, 5))
            this.disksContainer.add_child(this._createDiskEntry(disk));
    }

    _createDiskEntry(disk) {
        const entry = new St.BoxLayout({
            style_class: 'smp-disk-entry',
            vertical: true,
        });

        const row = new St.BoxLayout({style_class: 'smp-disk-row'});

        row.add_child(new St.Label({
            text: disk.name,
            style_class: 'smp-disk-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (disk.isExternal) {
            row.add_child(new St.Label({
                text: 'EXT',
                style_class: 'smp-disk-badge',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        row.add_child(new St.Widget({x_expand: true}));

        row.add_child(new St.Label({
            text: `${Math.round(disk.percent)}%`,
            style_class: 'smp-disk-percent',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        }));

        entry.add_child(row);

        const barBg = new St.BoxLayout({style_class: 'smp-disk-bar-bg'});
        const barFill = new St.Widget({
            style_class: `smp-disk-bar-fill smp-progress-${thresholdClass(disk.percent)}`,
        });
        const clamped = Math.max(0, Math.min(100, disk.percent));
        barFill.set_width(Math.round((clamped / 100) * 220));
        barBg.add_child(barFill);
        entry.add_child(barBg);

        entry.add_child(new St.Label({
            text: `${formatBytes(disk.used / 1024)} / ${formatBytes(disk.total / 1024)} · ${formatBytes(disk.free / 1024)} free`,
            style_class: 'smp-disk-detail',
        }));

        return entry;
    }
});

const TempCardItem = GObject.registerClass(
class TempCardItem extends St.BoxLayout {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card smp-card-half smp-card-half-left',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
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

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
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
            this.progressBarFill.set_width(Math.round((tempPercent / 100) * 220));

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

const NetworkCardItem = GObject.registerClass(
class NetworkCardItem extends St.BoxLayout {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card smp-card-half smp-card-half-right',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.set_vertical(true);

        // Header
        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-network-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-net',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'Network',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '—',
            style_class: 'smp-card-value smp-color-net',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        // Current speed rows
        this.downLabel = this._addSpeedRow('Download', '↓');
        this.upLabel = this._addSpeedRow('Upload', '↑');

        // Cumulative totals (since boot)
        this.rxTotalLabel = this._addStatRow('Total received', '—');
        this.txTotalLabel = this._addStatRow('Total sent', '—');
    }

    _addSpeedRow(titleText, arrow) {
        const row = new St.BoxLayout({style_class: 'smp-detail-row'});

        row.add_child(new St.Label({
            text: `${arrow}  ${titleText}`,
            style_class: 'smp-detail-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        row.add_child(new St.Widget({x_expand: true}));

        const value = new St.Label({
            text: '0 B/s',
            style_class: 'smp-net-speed-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(value);

        this.add_child(row);
        return value;
    }

    _addStatRow(titleText, valueText) {
        const row = new St.BoxLayout({style_class: 'smp-detail-row'});

        row.add_child(new St.Label({
            text: titleText,
            style_class: 'smp-detail-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

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

    update(net, useBits = false) {
        this.valueLabel.text = `↓ ${formatSpeed(net.rxSpeed, useBits)}`;
        this.downLabel.text = formatSpeed(net.rxSpeed, useBits);
        this.upLabel.text = formatSpeed(net.txSpeed, useBits);
        // Cumulative totals stay in bytes; a bit-count total is not meaningful.
        // formatBytes expects kB; /proc counters are bytes.
        this.rxTotalLabel.text = formatBytes(net.rxTotal / 1024);
        this.txTotalLabel.text = formatBytes(net.txTotal / 1024);
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

        // Refresh button — pulls fresh data in place and keeps the menu open.
        const refreshBtn = this._makeIconButton('view-refresh-symbolic', 'Refresh now');
        refreshBtn.connect('clicked', () => indicator._refreshAll());
        box.add_child(refreshBtn);

        // System Monitor button
        const monitorBtn = this._makeButton(
            'utilities-system-monitor-symbolic', 'System Monitor');
        monitorBtn.connect('clicked', () => {
            indicator.menu.close();
            this._launchSystemMonitor();
        });
        box.add_child(monitorBtn);

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

    _makeIconButton(iconName, accessibleName) {
        const btn = new St.Button({
            style_class: 'smp-footer-button smp-footer-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: accessibleName,
        });
        btn.set_child(new St.Icon({icon_name: iconName, style_class: 'smp-footer-btn-icon'}));
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
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._cpuBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-cpu-symbolic.svg`), '—');
        this._panelBox.add_child(this._cpuBox.container);

        this._memBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-memory-symbolic.svg`), '—');
        this._panelBox.add_child(this._memBox.container);

        this._diskBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-disk-symbolic.svg`), '—');
        this._panelBox.add_child(this._diskBox.container);

        this._tempBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-temperature-symbolic.svg`), '—');
        this._panelBox.add_child(this._tempBox.container);

        this._netBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-network-symbolic.svg`), '—');
        this._panelBox.add_child(this._netBox.container);

        // ── Build dropdown ──
        this._buildDropdownMenu();

        // ── Signals ──
        // Clicking the panel button opens the dropdown, which pulls fresh data.
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

        // Seed the CPU and network deltas, then do the first real refresh
        // shortly after. The periodic timer is already started by
        // _applySettings() above.
        this._metrics.getCpuUsage();
        this._metrics.getNetworkSpeed();
        this._seedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._refreshAll();
            this._seedTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
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

        // Memory and Disk share a single horizontal row.
        this._memCard = new MemoryCardItem(this._extension);
        this._diskCard = new DiskCardItem(this._extension);

        this._memDiskRow = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card-row',
        });
        this._memDiskRow.add_child(this._memCard);
        this._memDiskRow.add_child(this._diskCard);
        this.menu.addMenuItem(this._memDiskRow);

        // Temperature and Network share a single horizontal row.
        this._tempCard = new TempCardItem(this._extension);
        this._netCard = new NetworkCardItem(this._extension);

        this._tempNetRow = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card-row',
        });
        this._tempNetRow.add_child(this._tempCard);
        this._tempNetRow.add_child(this._netCard);
        this.menu.addMenuItem(this._tempNetRow);

        this._footer = new FooterItem(this._extension, this);
        this.menu.addMenuItem(this._footer);
    }

    _applySettings() {
        // Panel (top bar) toggles.
        const showCpu = this._settings.get_boolean('show-cpu');
        const showMem = this._settings.get_boolean('show-memory');
        const showDisk = this._settings.get_boolean('show-disk');
        const showTemp = this._settings.get_boolean('show-temperature');
        const showNet = this._settings.get_boolean('show-network');
        // Dropdown menu card toggles.
        const showCpuCard = this._settings.get_boolean('show-cpu-card');
        const showMemCard = this._settings.get_boolean('show-memory-card');
        const showDiskCard = this._settings.get_boolean('show-disk-card');
        const showTempCard = this._settings.get_boolean('show-temperature-card');
        const showNetCard = this._settings.get_boolean('show-network-card');
        const showIcons = this._settings.get_boolean('show-icons');
        const showLabels = this._settings.get_boolean('show-labels');

        this._cpuBox.container.visible = showCpu;
        this._memBox.container.visible = showMem;
        this._diskBox.container.visible = showDisk;
        this._tempBox.container.visible = showTemp;
        this._netBox.container.visible = showNet;

        for (const box of [this._cpuBox, this._memBox, this._diskBox, this._tempBox, this._netBox]) {
            box.icon.visible = showIcons;
            box.label.visible = showLabels;
        }

        this._cpuCard.visible = showCpuCard;
        this._memCard.visible = showMemCard;
        this._diskCard.visible = showDiskCard;
        this._tempCard.visible = showTempCard;
        this._netCard.visible = showNetCard;
        // Hide each shared row entirely when neither of its cards is shown.
        this._memDiskRow.visible = showMemCard || showDiskCard;
        this._tempNetRow.visible = showTempCard || showNetCard;

        // Restart the timer to pick up any refresh-interval change.
        this._startTimer();
    }

    _startTimer() {
        // Guard against leaking an existing source if called twice.
        this._stopTimer();
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
        this._refreshDisk();
        this._refreshTemperature();
        this._refreshNetwork();
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

    _refreshDisk() {
        // Nothing consumes the filesystem stats while both the panel indicator
        // and the card are hidden, so skip the syscalls entirely.
        if (!this._diskCard.visible && !this._diskBox.container.visible)
            return;

        try {
            const includeExternal = this._settings.get_boolean('show-external-disks');
            const disks = this._metrics.getDiskUsage(includeExternal);
            const overall = this._metrics.getOverallDiskUsage(disks);

            if (disks.length > 0) {
                const percent = Math.round(overall.percent);
                this._diskBox.label.text = `${percent}%`;
                this._setPanelLabelColor(this._diskBox.label, percent);
            } else {
                this._diskBox.label.text = 'N/A';
                this._setPanelLabelColor(this._diskBox.label, 0);
            }

            this._diskCard.update(disks, overall);
        } catch (e) {
            console.error('System Monitor Panel: disk refresh failed', e);
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

    _refreshNetwork() {
        try {
            const useBits = this._settings.get_string('network-unit') === 'bits';

            const net = this._metrics.getNetworkSpeed();
            this._netBox.label.text =
                `↓${formatSpeedCompact(net.rxSpeed, useBits)} ↑${formatSpeedCompact(net.txSpeed, useBits)}`;
            // Network has no percentage scale, so keep the panel label neutral.
            this._setPanelLabelColor(this._netBox.label, 0);
            this._netCard.update(net, useBits);
        } catch (e) {
            console.error('System Monitor Panel: network refresh failed', e);
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

/**
 * Where each panel-position value lands: which of the panel's boxes, and at
 * which index inside it. A null index means "append to the end of the box".
 */
const PANEL_POSITIONS = {
    'far-left': {box: '_leftBox', index: 0},
    'left': {box: '_leftBox', index: null},
    'right': {box: '_rightBox', index: 0},
    'far-right': {box: '_rightBox', index: null},
};

export default class SystemMonitorPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SystemMonitorIndicator(this);

        // Register the indicator (claims the role), then move its container to
        // the configured box/index.
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._applyPosition();

        this._positionChangedId = this._settings.connect(
            'changed::panel-position', () => this._applyPosition());
    }

    _applyPosition() {
        if (!this._indicator)
            return;

        const key = this._settings.get_string('panel-position');
        const {box, index} = PANEL_POSITIONS[key] ?? PANEL_POSITIONS['right'];

        const targetBox = Main.panel[box];
        if (!targetBox) {
            console.error(`System Monitor Panel: unknown panel box "${box}"`);
            return;
        }

        // Move rather than re-calling addToStatusArea, which would throw on
        // the already-claimed role. Detach first so the append index below
        // reflects the box without our own container in it.
        const container = this._indicator.container;
        container.get_parent()?.remove_child(container);
        targetBox.insert_child_at_index(
            container, index ?? targetBox.get_n_children());
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
