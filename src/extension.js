/* ============================================
   System Monitor — extension.js
   GNOME 50 Shell Extension
   ============================================

   SPDX-FileCopyrightText: 2026 Naimur Rahman
   SPDX-License-Identifier: GPL-2.0-or-later
*/

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';


/* ── Helpers ──────────────────────────────────── */

// Makes load_contents_async() awaitable; it resolves to [contents, etag].
Gio._promisify(Gio.File.prototype, 'load_contents_async');
// Makes communicate_utf8_async() awaitable; it resolves to [stdout, stderr].
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const DECODER = new TextDecoder('utf-8');

/**
 * Read a small virtual file on a GIO worker thread.
 * Resolves to the file's text, or null if the file is missing or unreadable —
 * not every sensor exists on every machine.
 */
async function readFile(path) {
    try {
        const [contents] = await Gio.File.new_for_path(path)
            .load_contents_async(null);
        return DECODER.decode(contents);
    } catch (_e) {
        return null;
    }
}

/**
 * List the entry names of a /sys/class directory.
 *
 * Listing a /sys/class directory touches only dentries, never a device, so it
 * stays synchronous; keeping the enumerator's lifetime inside one call also
 * avoids holding its directory fd across awaits.
 */
function listSysDir(dirPath) {
    const names = [];
    let enumerator = null;
    try {
        enumerator = Gio.File.new_for_path(dirPath).enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
    } catch (_e) {
        // Tree not present on this system, or it vanished mid-scan.
    } finally {
        // next_file() can throw; without this the directory fd is held
        // until the enumerator is garbage collected.
        enumerator?.close(null);
    }
    return names;
}

/**
 * Swap an actor's `<prefix>-normal|warning|critical` state class for `state`.
 */
function setStateClass(actor, prefix, state) {
    for (const s of ['normal', 'warning', 'critical'])
        actor.remove_style_class_name(`${prefix}-${s}`);
    actor.add_style_class_name(`${prefix}-${state}`);
}

/**
 * Set a progress bar's fill width from a percentage.
 *
 * `logicalWidth` is the bar's width in CSS pixels; Clutter sizes are in device
 * pixels, so it has to be multiplied by the theme scale factor or the fill
 * under-shoots the (CSS-sized) track on HiDPI and fractionally scaled displays.
 */
function setBarWidth(actor, percent, logicalWidth) {
    const clamped = Math.max(0, Math.min(100, percent));
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    actor.set_width(Math.round((clamped / 100) * logicalWidth * scale));
}

/**
 * Append a "Label ............ value" detail row and return the value label.
 */
function addStatRow(parent, titleText, valueText) {
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

    parent.add_child(row);
    return value;
}

/**
 * Grow or shrink `pool` to `count` entries, building new rows with `create`
 * and destroying the surplus. Reusing rows keeps a fast refresh interval from
 * churning hundreds of actors per tick.
 */
function resizeRowPool(pool, count, create) {
    while (pool.length < count)
        pool.push(create());
    while (pool.length > count)
        pool.pop().root.destroy();
    return pool;
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
async function isExternalDisk(device, mountPoint) {
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
    let removable = await readFile(`/sys/class/block/${blockName}/removable`);
    if (removable === null) {
        const segments = target.split('/');
        const diskName = segments[segments.length - 2];
        if (diskName)
            removable = await readFile(`/sys/class/block/${diskName}/removable`);
    }

    return removable !== null && removable.trim() === '1';
}

const FS_USAGE_ATTRS = 'filesystem::size,filesystem::used,filesystem::free';

/**
 * Query every mount point's size/used/free in bytes, then hand the successful
 * results to `callback`.
 *
 * statfs() blocks in uninterruptible sleep on a device that has stopped
 * responding — a drive unplugged without unmounting, or a dm/LVM volume over a
 * failing disk. Everything here runs in the compositor process, so a synchronous
 * call would freeze the whole desktop for the kernel's timeout. The async form
 * hands the syscall to a GIO worker thread instead.
 *
 * Mounts that fail to stat, or report a zero size, are dropped.
 */
function queryFilesystemUsage(mounts, cancellable, callback) {
    if (mounts.length === 0) {
        callback([]);
        return;
    }

    // Fixed-size array so results keep the caller's (already sorted) order
    // regardless of the order the worker threads finish in.
    const results = new Array(mounts.length).fill(null);
    let remaining = mounts.length;

    mounts.forEach((mount, i) => {
        Gio.File.new_for_path(mount.mountPoint).query_filesystem_info_async(
            FS_USAGE_ATTRS, GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
                try {
                    const info = file.query_filesystem_info_finish(res);

                    const total = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    // filesystem::used is not reported by every backend.
                    const used = info.get_attribute_uint64('filesystem::used') ||
                        Math.max(0, total - free);

                    if (total > 0) {
                        results[i] = {
                            ...mount,
                            total,
                            used,
                            free,
                            percent: (used / total) * 100,
                        };
                    }
                } catch (_e) {
                    // Cancelled, unreadable, or a stale mount — leave it out.
                }

                // Only the last callback reports, so the UI sees one complete
                // set. Cancelled queries report too (each entry stays null) so
                // an awaiting caller always resumes; it checks the cancellable
                // itself before touching any UI.
                if (--remaining === 0)
                    callback(results.filter(r => r !== null));
            });
    });
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

function tempThresholdClass(tempC) {
    if (tempC >= 85)
        return 'critical';
    if (tempC >= 65)
        return 'warning';
    return 'normal';
}

function celsiusToFahrenheit(c) {
    return c * 9 / 5 + 32;
}

const TEMP_FRIENDLY_NAMES = {
    'x86_pkg_temp': 'CPU Package',
    'Package id 0': 'CPU Package',
    'coretemp': 'CPU',
    'k10temp': 'CPU',
    'zenpower': 'CPU',
    'Tctl': 'CPU Package',
    'Tdie': 'CPU Package',
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
    'radeon': 'GPU',
    'nouveau': 'GPU',
};

function friendlyTempName(raw) {
    return TEMP_FRIENDLY_NAMES[raw] || raw;
}

/**
 * hwmon chips that report a CPU temperature. Intel exposes coretemp; AMD
 * exposes k10temp (or zenpower with the out-of-tree driver).
 */
const CPU_HWMON_CHIPS = new Set(['coretemp', 'k10temp', 'zenpower']);

/**
 * Return true if a sensor id/name is the whole-CPU (package) sensor.
 * Tctl/Tdie are AMD's package sensors under k10temp.
 */
function isCpuPackageSensor(raw) {
    return raw === 'x86_pkg_temp' || raw === 'Package id 0' ||
        raw === 'Tctl' || raw === 'Tdie';
}

/**
 * Component category for a raw sensor id — a thermal-zone type, hwmon chip
 * name or hwmon channel label — or null for sensors that are not worth a
 * per-refresh read: per-core duplicates, per-CCD temps, opaque ACPI zones
 * (SEN1, B0D4), thermal-policy pseudo-zones and the like.
 */
function tempSensorCategory(raw) {
    if (isCpuPackageSensor(raw) || CPU_HWMON_CHIPS.has(raw) ||
        raw.toLowerCase().includes('cpu'))
        return 'cpu';
    if (raw.startsWith('pch_'))
        return 'chipset';
    if (raw === 'acpitz')
        return 'motherboard';
    if (raw.startsWith('iwlwifi'))
        return 'wifi';
    if (raw === 'Composite' || raw === 'drivetemp')
        return 'drive';
    if (raw === 'amdgpu' || raw === 'radeon' || raw === 'nouveau')
        return 'gpu';
    return null;
}


/* ── GPU helpers ──────────────────────────────── */

/**
 * PCI vendor ids for the GPU vendors worth naming.
 */
const GPU_VENDOR_NAMES = {
    '8086': 'Intel',
    '1002': 'AMD',
    '10de': 'NVIDIA',
};

/**
 * Distro-dependent locations of the PCI id database.
 */
const PCI_IDS_PATHS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids'];

/**
 * Look up a device's marketing name in the pci.ids database. Returns null when
 * the database is missing or the device is unknown. Only called once per GPU
 * at discovery; the database is ~1.5 MB, so it is never kept around.
 *
 * Format: vendor lines start at column 0 ("8086  Intel Corporation"), device
 * lines belong to the vendor block above them and are indented by one tab
 * ("\t9b41  CometLake-U GT2 [UHD Graphics]"). Subdevice lines use two tabs and
 * can never match a "\t<id>  " prefix.
 */
async function lookupPciDeviceName(vendorId, deviceId) {
    if (!vendorId || !deviceId)
        return null;

    for (const path of PCI_IDS_PATHS) {
        const data = await readFile(path);
        if (data === null)
            continue;

        let inVendor = false;
        for (const line of data.split('\n')) {
            if (line.length === 0 || line.startsWith('#'))
                continue;
            if (!line.startsWith('\t')) {
                if (inVendor)
                    break; // left our vendor's block
                inVendor = line.startsWith(`${vendorId}  `);
            } else if (inVendor && line.startsWith(`\t${deviceId}  `)) {
                return line.slice(deviceId.length + 3).trim();
            }
        }
        return null; // a readable database is authoritative — stop here
    }
    return null;
}

/**
 * Compact display name for a GPU. pci.ids names are usually
 * "Chip codename [Marketing name]"; the bracketed part is what users
 * recognise, prefixed with the vendor when it is not already there.
 */
function friendlyGpuName(pciName, vendor) {
    if (!pciName)
        return vendor ? `${vendor} GPU` : 'GPU';
    const bracket = pciName.match(/\[([^\]]+)\]/);
    const name = bracket ? bracket[1] : pciName;
    if (vendor && !name.toLowerCase().startsWith(vendor.toLowerCase()))
        return `${vendor} ${name}`;
    return name;
}


/* ── System Metrics Collector ─────────────────── */

class SystemMetrics {
    constructor() {
        // Keyed by the /proc/stat cpu name ("cpu", "cpu0", …) rather than by
        // position: offlining a core drops its line, which would otherwise
        // shift every later core onto the wrong previous sample.
        this._prevCpu = new Map();
        this._prevNet = new Map();
        this._prevNetTime = 0;

        // Static metadata, discovered once and reused. Sensor paths and a
        // device's removable flag never change while mounted, so re-walking
        // sysfs on every tick is pure waste at a short refresh interval.
        this._tempSensors = null;
        this._mounts = null;
        this._externalCache = new Map();
        this._gpus = null;

        // Previous idle-residency sample per GPU, for drivers (i915/xe) that
        // expose cumulative sleep time instead of a busy percentage.
        this._prevGpuIdle = new Map();

        // /proc/mounts only changes when something is (un)mounted.
        this._mountMonitor = GioUnix.MountMonitor.get();
        this._mountMonitor.connectObject(
            'mounts-changed', () => this._invalidateMounts(), this);
    }

    _invalidateMounts() {
        this._mounts = null;
        // A device node can be reused by different hardware across a replug,
        // so the removable flag is only valid for the current mount set.
        this._externalCache.clear();
    }

    /**
     * Read CPU usage from /proc/stat.
     * Returns { overall: Number, cores: [Number] } as percentages.
     */
    async getCpuUsage() {
        const data = await readFile('/proc/stat');
        if (!data)
            return {overall: 0, cores: []};

        const cpuLines = data.split('\n').filter(l => /^cpu[0-9]*\s/.test(l));

        let overall = 0;
        const cores = [];
        const seen = new Set();

        for (const line of cpuLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5)
                continue;

            const name = parts[0];
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

            const prev = this._prevCpu.get(name);
            this._prevCpu.set(name, {total, idle: totalIdle});
            seen.add(name);

            let usage = 0;
            if (prev) {
                const dTotal = total - prev.total;
                const dIdle = totalIdle - prev.idle;
                // iowait is not monotonic, so dIdle can exceed dTotal or go
                // negative; either way the ratio has to be clamped to 0…100.
                if (dTotal > 0)
                    usage = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
            }
            usage = Math.round(usage * 10) / 10;

            if (name === 'cpu')
                overall = usage;
            else
                cores.push(usage);
        }

        // Drop counters for cores that went offline.
        for (const name of this._prevCpu.keys()) {
            if (!seen.has(name))
                this._prevCpu.delete(name);
        }

        return {overall, cores};
    }

    /**
     * Read memory info from /proc/meminfo (all values in kB).
     */
    async getMemoryUsage() {
        const empty = {
            percent: 0, total: 0, available: 0, used: 0, free: 0,
            buffers: 0, cached: 0, swapTotal: 0, swapUsed: 0, swapPercent: 0,
        };

        const data = await readFile('/proc/meminfo');
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
    async getNetworkSpeed() {
        const data = await readFile('/proc/net/dev');
        const now = GLib.get_monotonic_time(); // microseconds
        if (!data)
            return {rxSpeed: 0, txSpeed: 0, rxTotal: 0, txTotal: 0};

        const dt = this._prevNetTime > 0 ? (now - this._prevNetTime) / 1e6 : 0;

        let rxTotal = 0;
        let txTotal = 0;
        let rxDelta = 0;
        let txDelta = 0;
        const current = new Map();

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
            if (isNaN(rx) || isNaN(tx))
                continue;

            rxTotal += rx;
            txTotal += tx;
            current.set(iface, {rx, tx});

            // Accumulate the delta per interface rather than from a sum across
            // whatever interfaces happened to exist. A VPN or tether going away
            // would otherwise drop its cumulative bytes out of the sum and read
            // as zero throughput; one appearing would read as a huge spike.
            // A counter that moved backwards means the interface was reset.
            const prev = this._prevNet.get(iface);
            if (prev) {
                if (rx >= prev.rx)
                    rxDelta += rx - prev.rx;
                if (tx >= prev.tx)
                    txDelta += tx - prev.tx;
            }
        }

        this._prevNet = current;
        this._prevNetTime = now;

        const rxSpeed = dt > 0 ? rxDelta / dt : 0;
        const txSpeed = dt > 0 ? txDelta / dt : 0;

        return {rxSpeed, txSpeed, rxTotal, txTotal};
    }

    /**
     * Whether a device is removable. Cached: walking the sysfs device tree
     * re-derives a static hardware property, and the cache is dropped whenever
     * the mount set changes.
     */
    async _isExternal(device, mountPoint) {
        let external = this._externalCache.get(device);
        if (external === undefined) {
            external = await isExternalDisk(device, mountPoint);
            this._externalCache.set(device, external);
        }
        return external;
    }

    /**
     * Parse /proc/mounts into the block-backed mounts worth reporting, sorted
     * with internal disks first and each group by mount point.
     *
     * Cached until Gio.UnixMountMonitor reports a change, so a short refresh
     * interval does not re-parse /proc/mounts and re-walk sysfs every tick.
     */
    async _getMounts() {
        if (this._mounts)
            return this._mounts;

        const data = await readFile('/proc/mounts');
        if (!data)
            return [];

        const mounts = [];
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

            seenDevices.add(device);
            const isExternal = await this._isExternal(device, mountPoint);
            mounts.push({
                name: friendlyMountName(mountPoint),
                mountPoint,
                device,
                isExternal,
            });
        }

        mounts.sort((a, b) => {
            if (a.isExternal !== b.isExternal)
                return a.isExternal ? 1 : -1;
            return a.mountPoint.localeCompare(b.mountPoint);
        });

        this._mounts = mounts;
        return mounts;
    }

    /**
     * Collect usage for every mounted filesystem.
     *
     * External (removable/USB) disks are only included when includeExternal is
     * true. Sizes are in bytes. Resolves to [{ name, mountPoint, device,
     * total, used, free, percent, isExternal }]; mounts that cannot be stat'd
     * are omitted (all of them, if `cancellable` fires mid-query).
     */
    async getDiskUsage(includeExternal, cancellable) {
        const mounts = (await this._getMounts())
            .filter(m => includeExternal || !m.isExternal);
        return new Promise(resolve => {
            queryFilesystemUsage(mounts, cancellable, resolve);
        });
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
     * Locate the significant temperature sensors under /sys/class/thermal
     * and /sys/class/hwmon. Returns [{ path, name (display), isCpu }].
     *
     * Both trees are always scanned. Treating hwmon as a fallback only used
     * when thermal_zone came up empty hides the real CPU sensor on machines
     * that expose one useless thermal zone: an AMD box reports acpitz (the
     * motherboard) there while k10temp — the actual CPU — lives under hwmon.
     *
     * Only sensors matching a curated component list — CPU, GPU, chipset,
     * motherboard, drives, Wi‑Fi — are kept, one per component, so a refresh
     * reads a handful of files instead of every core, CCD and ACPI zone the
     * machine exposes. Trees mirroring the same component (x86_pkg_temp vs
     * coretemp) resolve to whichever was found first. A machine where nothing
     * matches keeps its readable thermal zones rather than an empty card.
     */
    async _discoverTempSensors() {
        const sensors = [];

        // One sensor per component; drives and GPUs can be several distinct
        // devices, so they dedupe per chip instead.
        const seen = new Set();
        const takeSensor = (category, basePath) => {
            const key = category === 'drive' || category === 'gpu'
                ? `${category}:${basePath}` : category;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        };

        // Repeated components get a numeric suffix ("NVMe SSD 2") so the
        // display layer, which collapses duplicate names, keeps them apart.
        const friendlyCounts = new Map();
        const displayName = raw => {
            const friendly = friendlyTempName(raw);
            const n = (friendlyCounts.get(friendly) ?? 0) + 1;
            friendlyCounts.set(friendly, n);
            return n === 1 ? friendly : `${friendly} ${n}`;
        };

        const fallbackZones = [];

        for (const name of listSysDir('/sys/class/thermal')) {
            if (!name.startsWith('thermal_zone'))
                continue;

            const basePath = `/sys/class/thermal/${name}`;
            if ((await readFile(`${basePath}/temp`)) === null)
                continue;

            const typeStr = await readFile(`${basePath}/type`);
            const raw = typeStr ? typeStr.trim() : name;

            const category = tempSensorCategory(raw);
            if (!category) {
                fallbackZones.push({basePath, raw});
                continue;
            }
            if (!takeSensor(category, basePath))
                continue;

            sensors.push({
                path: `${basePath}/temp`,
                name: displayName(raw),
                isCpu: category === 'cpu',
            });
        }

        for (const hwmonName of listSysDir('/sys/class/hwmon')) {
            const basePath = `/sys/class/hwmon/${hwmonName}`;
            const nameStr = await readFile(`${basePath}/name`);
            const chipName = nameStr ? nameStr.trim() : hwmonName;

            // hwmon numbering is not contiguous — a chip may expose temp2_input
            // and temp3_input with no temp1_input — so skip gaps rather than
            // stopping at the first one.
            for (let i = 1; i <= 16; i++) {
                const path = `${basePath}/temp${i}_input`;
                const labelStr = await readFile(`${basePath}/temp${i}_label`);

                // The channel label decides where a labelled chip like
                // coretemp is concerned (package vs per-core); the chip name
                // catches label-less chips like k10temp or amdgpu.
                let raw = labelStr ? labelStr.trim() : chipName;
                let category = tempSensorCategory(raw);
                if (!category && raw !== chipName) {
                    raw = chipName;
                    category = tempSensorCategory(raw);
                }
                if (!category)
                    continue;

                // Probe readability before claiming the component, so a dead
                // channel does not block a working sibling from representing it.
                if ((await readFile(path)) === null)
                    continue;
                if (!takeSensor(category, basePath))
                    continue;

                sensors.push({
                    path,
                    name: displayName(raw),
                    isCpu: category === 'cpu',
                });
            }
        }

        // Nothing matched the curated list — exotic hardware with sensors the
        // classifier does not know. Readable thermal zones beat an empty card.
        if (sensors.length === 0) {
            for (const {basePath, raw} of fallbackZones) {
                sensors.push({
                    path: `${basePath}/temp`,
                    name: displayName(raw),
                    isCpu: false,
                });
            }
        }

        return sensors;
    }

    /**
     * Read every discovered sensor. Sensor paths are discovered once and
     * cached; only the temp files themselves are read on each refresh.
     * Returns [{ name (raw), tempC, isCpu }] sorted by temperature descending.
     */
    async getTemperatures() {
        // Cached as a promise so refreshes that overlap the first discovery
        // share one sysfs scan instead of each starting their own.
        this._tempSensors ??= this._discoverTempSensors();
        const sensors = await this._tempSensors;

        // One parallel fan-out: every sensor is its own GIO task, so the
        // refresh pays a single worker-thread round trip instead of one per
        // sensor. readFile never rejects, so neither can this.
        const readings = await Promise.all(
            sensors.map(sensor => readFile(sensor.path)));

        const temps = [];
        let stale = false;

        sensors.forEach((sensor, i) => {
            const tempStr = readings[i];
            if (tempStr === null) {
                // Sensor went away (module unloaded, device unplugged) —
                // rebuild the path list on the next refresh.
                stale = true;
                return;
            }

            const millideg = parseInt(tempStr.trim(), 10);
            if (isNaN(millideg))
                return;

            temps.push({
                name: sensor.name,
                tempC: millideg / 1000,
                isCpu: sensor.isCpu,
            });
        });

        if (stale)
            this._tempSensors = null;

        temps.sort((a, b) => b.tempC - a.tempC);
        return temps;
    }

    /**
     * Overall system temperature: prefer the CPU-package sensor,
     * otherwise fall back to the hottest valid sensor.
     * Returns { tempC, name } or null.
     */
    getOverallTemperature(temps) {
        const valid = temps.filter(t => t.tempC > 0 && t.tempC < 130);
        if (valid.length === 0)
            return null;

        const cpu = valid.find(t => t.isCpu);
        if (cpu)
            return {tempC: cpu.tempC, name: friendlyTempName(cpu.name)};

        return {tempC: valid[0].tempC, name: friendlyTempName(valid[0].name)};
    }

    /**
     * First readable path among `candidates`, or null. Drivers move these
     * files around between kernel versions, so each metric probes a list.
     */
    async _firstReadable(candidates) {
        for (const path of candidates) {
            if ((await readFile(path)) !== null)
                return path;
        }
        return null;
    }

    /**
     * Locate every GPU under /sys/class/drm and work out, per device, which
     * files (if any) report usage, VRAM, temperature and clock frequency.
     * Returns [{ card, name, integrated, driver, busyPath, idlePath,
     * vramUsedPath, vramTotalPath, tempPath, freqPath, freqDivisor,
     * freqMaxMhz, useNvidiaSmi }].
     *
     * Vendor interfaces differ:
     *  - amdgpu/radeon publish gpu_busy_percent and mem_info_vram_* directly,
     *    plus temperature and clock under a device hwmon chip.
     *  - i915/xe publish no busy file; usage is derived from the growth rate
     *    of the cumulative RC6 (sleep) residency counter. Clocks live in
     *    per-card (i915) or per-tile (xe) frequency files.
     *  - The proprietary NVIDIA driver publishes nothing in sysfs; metrics
     *    come from one `nvidia-smi` query per refresh when the tool exists.
     *  - nouveau exposes only a hwmon temperature.
     */
    async _discoverGpus() {
        const gpus = [];
        const nvidiaSmi = GLib.find_program_in_path('nvidia-smi') !== null;

        for (const cardName of listSysDir('/sys/class/drm')) {
            // Render nodes (renderD128) and connectors (card1-eDP-1) also live
            // here; only the card nodes represent devices.
            if (!/^card\d+$/.test(cardName))
                continue;

            const base = `/sys/class/drm/${cardName}`;
            const uevent = await readFile(`${base}/device/uevent`);
            if (uevent === null)
                continue; // virtual device (vgem/vkms) with no hardware behind it

            const fields = {};
            for (const line of uevent.split('\n')) {
                const eq = line.indexOf('=');
                if (eq !== -1)
                    fields[line.slice(0, eq)] = line.slice(eq + 1);
            }

            const driver = fields['DRIVER'];
            if (!driver)
                continue; // device present but not bound to any driver

            const [vendorId, deviceId] = (fields['PCI_ID'] ?? '')
                .toLowerCase().split(':');
            const vendor = GPU_VENDOR_NAMES[vendorId] ?? null;

            // Integrated vs. dedicated is a heuristic: PCI has no "integrated"
            // flag. Bus 0 is the processor's root bus, where Intel iGPUs
            // always sit. A missing PCI slot means a platform device (ARM
            // SoC), which is integrated by definition. AMD APUs can enumerate
            // on a non-zero bus, so amdgpu gets a second chance below.
            const slot = fields['PCI_SLOT_NAME'];
            let integrated = !slot || parseInt(slot.split(':')[1], 16) === 0;

            const gpu = {
                card: cardName,
                driver,
                vendor,
                integrated,
                name: friendlyGpuName(
                    await lookupPciDeviceName(vendorId, deviceId), vendor),
                busyPath: null,       // reads a 0–100 percentage directly
                idlePath: null,       // reads cumulative idle milliseconds
                vramUsedPath: null,   // bytes
                vramTotalPath: null,  // bytes
                tempPath: null,       // millidegrees Celsius
                freqPath: null,       // current clock
                freqDivisor: 1,       // divides freqPath's value into MHz
                freqMaxMhz: null,     // static ceiling, read once
                useNvidiaSmi: false,
            };

            if (driver === 'amdgpu' || driver === 'radeon') {
                gpu.busyPath = await this._firstReadable(
                    [`${base}/device/gpu_busy_percent`]);
                if ((await readFile(`${base}/device/mem_info_vram_total`)) !== null) {
                    gpu.vramUsedPath = `${base}/device/mem_info_vram_used`;
                    gpu.vramTotalPath = `${base}/device/mem_info_vram_total`;
                }

                // The APU-only thermal-cap file identifies integrated parts
                // that enumerate on a non-zero bus (recent Ryzen laptops).
                if (!gpu.integrated &&
                    (await readFile(`${base}/device/apu_thermal_cap`)) !== null)
                    gpu.integrated = true;

                // sclk levels are static; the highest one is the max clock.
                const sclk = await readFile(`${base}/device/pp_dpm_sclk`);
                if (sclk) {
                    const levels = [...sclk.matchAll(/(\d+)\s*mhz/gi)]
                        .map(m => parseInt(m[1], 10));
                    if (levels.length > 0)
                        gpu.freqMaxMhz = Math.max(...levels);
                }
            } else if (driver === 'i915' || driver === 'xe') {
                gpu.idlePath = await this._firstReadable([
                    `${base}/power/rc6_residency_ms`,
                    `${base}/gt/gt0/rc6_residency_ms`,
                    `${base}/device/tile0/gt0/gtidle/idle_residency_ms`,
                ]);
                gpu.freqPath = await this._firstReadable([
                    `${base}/gt_act_freq_mhz`,
                    `${base}/gt/gt0/rps_act_freq_mhz`,
                    `${base}/device/tile0/gt0/freq0/act_freq`,
                ]);

                const maxPath = await this._firstReadable([
                    `${base}/gt_max_freq_mhz`,
                    `${base}/gt/gt0/rps_max_freq_mhz`,
                    `${base}/device/tile0/gt0/freq0/max_freq`,
                ]);
                if (maxPath) {
                    const maxStr = await readFile(maxPath);
                    const max = parseInt(maxStr, 10);
                    if (!isNaN(max) && max > 0)
                        gpu.freqMaxMhz = max;
                }
            } else if (driver === 'nvidia') {
                gpu.useNvidiaSmi = nvidiaSmi;
            }

            // Any vendor may expose a hwmon chip with temperature (Intel Arc,
            // AMD, nouveau) and clock (amdgpu's freq1_input, in Hz). Intel
            // iGPUs expose none — their die shares the CPU package sensor.
            for (const hwmonName of listSysDir(`${base}/device/hwmon`)) {
                const hwmonBase = `${base}/device/hwmon/${hwmonName}`;
                gpu.tempPath ??= await this._firstReadable(
                    [`${hwmonBase}/temp1_input`]);
                if (!gpu.freqPath &&
                    (await readFile(`${hwmonBase}/freq1_input`)) !== null) {
                    gpu.freqPath = `${hwmonBase}/freq1_input`;
                    gpu.freqDivisor = 1e6; // Hz → MHz
                }
            }

            gpus.push(gpu);
        }

        // Panel and card lead with the GPU doing the rendering work, so
        // dedicated cards come first.
        gpus.sort((a, b) => {
            if (a.integrated !== b.integrated)
                return a.integrated ? 1 : -1;
            return a.card.localeCompare(b.card);
        });

        return gpus;
    }

    /**
     * Read every discovered GPU's metrics. Discovery runs once and is cached;
     * each refresh only reads the handful of per-GPU metric files (plus one
     * nvidia-smi call when the proprietary driver is present).
     *
     * Returns [{ name, integrated, busy, vramUsed, vramTotal, vramPercent,
     * tempC, freqMhz, freqMaxMhz }] with null for anything the hardware or
     * driver does not report. busy is also null on the first sample of an
     * idle-residency GPU — a delta needs two reads.
     */
    async getGpuUsage(cancellable = null) {
        this._gpus ??= this._discoverGpus();
        const gpus = await this._gpus;

        const now = GLib.get_monotonic_time();
        let stale = false;

        const results = await Promise.all(gpus.map(async gpu => {
            const result = {
                name: gpu.name,
                integrated: gpu.integrated,
                busy: null,
                vramUsed: null,
                vramTotal: null,
                vramPercent: null,
                tempC: null,
                freqMhz: null,
                freqMaxMhz: gpu.freqMaxMhz,
            };

            // Non-existent paths resolve to null through Promise.all
            // unchanged, so every GPU costs one parallel fan-out.
            const [busyStr, idleStr, usedStr, totalStr, tempStr, freqStr] =
                await Promise.all([
                    gpu.busyPath ? readFile(gpu.busyPath) : null,
                    gpu.idlePath ? readFile(gpu.idlePath) : null,
                    gpu.vramUsedPath ? readFile(gpu.vramUsedPath) : null,
                    gpu.vramTotalPath ? readFile(gpu.vramTotalPath) : null,
                    gpu.tempPath ? readFile(gpu.tempPath) : null,
                    gpu.freqPath ? readFile(gpu.freqPath) : null,
                ]);

            // A metric file that existed at discovery but fails now means the
            // device went away (eGPU unplug, module unload) — rediscover.
            if ((gpu.busyPath && busyStr === null) ||
                (gpu.idlePath && idleStr === null))
                stale = true;

            if (busyStr !== null) {
                const busy = parseInt(busyStr, 10);
                if (!isNaN(busy))
                    result.busy = Math.max(0, Math.min(100, busy));
            }

            if (idleStr !== null) {
                // Usage ≈ the share of wall-clock time the GPU spent out of
                // its sleep state. Slightly over-counts (idle-but-awake time
                // is "busy"), but it is the only usage signal i915/xe expose
                // without CAP_PERFMON.
                const idleMs = parseFloat(idleStr);
                const prev = this._prevGpuIdle.get(gpu.card);
                if (!isNaN(idleMs)) {
                    this._prevGpuIdle.set(gpu.card, {idleMs, timeUs: now});
                    if (prev && now > prev.timeUs) {
                        const wallMs = (now - prev.timeUs) / 1000;
                        const dIdle = Math.max(0, idleMs - prev.idleMs);
                        result.busy = Math.max(0, Math.min(100,
                            100 * (1 - dIdle / wallMs)));
                    }
                }
            }

            if (usedStr !== null && totalStr !== null) {
                const used = parseInt(usedStr, 10);
                const total = parseInt(totalStr, 10);
                if (!isNaN(used) && !isNaN(total) && total > 0) {
                    result.vramUsed = used;
                    result.vramTotal = total;
                    result.vramPercent = (used / total) * 100;
                }
            }

            if (tempStr !== null) {
                const milli = parseInt(tempStr, 10);
                if (!isNaN(milli))
                    result.tempC = milli / 1000;
            }

            if (freqStr !== null) {
                const freq = parseInt(freqStr, 10);
                if (!isNaN(freq))
                    result.freqMhz = freq / gpu.freqDivisor;
            }

            return result;
        }));

        if (stale) {
            this._gpus = null;
            this._prevGpuIdle.clear();
        }

        if (gpus.some(gpu => gpu.useNvidiaSmi))
            await this._fillNvidiaMetrics(gpus, results, cancellable);

        return results;
    }

    /**
     * Fill the result slots of NVIDIA GPUs from a single nvidia-smi query.
     * nvidia-smi reports cards in a stable minor order, matching the card
     * order within the discovery list. Fields it cannot report come back as
     * "[N/A]", which the numeric parses below turn into null.
     */
    async _fillNvidiaMetrics(gpus, results, cancellable) {
        let stdout;
        try {
            const proc = Gio.Subprocess.new(
                ['nvidia-smi',
                    '--query-gpu=name,utilization.gpu,memory.used,' +
                        'memory.total,temperature.gpu,clocks.gr',
                    '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_SILENCE);
            [stdout] = await proc.communicate_utf8_async(null, cancellable);
        } catch (_e) {
            // Cancelled at teardown, or the tool broke — leave the nulls.
            return;
        }

        const lines = stdout.split('\n').filter(l => l.trim().length > 0);
        let line = 0;

        gpus.forEach((gpu, i) => {
            if (!gpu.useNvidiaSmi || line >= lines.length)
                return;

            const parts = lines[line++].split(',').map(s => s.trim());
            if (parts.length < 6)
                return;

            const result = results[i];
            const [name, busy, usedMiB, totalMiB, temp, freq] = parts;

            if (name)
                result.name = name;
            if (!isNaN(parseFloat(busy)))
                result.busy = Math.max(0, Math.min(100, parseFloat(busy)));
            const used = parseFloat(usedMiB) * 1048576;
            const total = parseFloat(totalMiB) * 1048576;
            if (!isNaN(used) && !isNaN(total) && total > 0) {
                result.vramUsed = used;
                result.vramTotal = total;
                result.vramPercent = (used / total) * 100;
            }
            if (!isNaN(parseFloat(temp)))
                result.tempC = parseFloat(temp);
            if (!isNaN(parseFloat(freq)))
                result.freqMhz = parseFloat(freq);
        });
    }

    /**
     * The GPU the panel's single slot should report: the dedicated card doing
     * the work if its usage is known, else any GPU with a usage reading, else
     * the first one. Null only when the machine has no GPU at all.
     */
    getPrimaryGpu(gpus) {
        if (gpus.length === 0)
            return null;
        return gpus.find(g => !g.integrated && g.busy !== null) ??
            gpus.find(g => g.busy !== null) ??
            gpus[0];
    }

    destroy() {
        this._mountMonitor?.disconnectObject(this);
        this._mountMonitor = null;
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

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-cpu-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

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
        setBarWidth(this.progressBarFill, overall, 500);

        // (Re)build per-core widgets only when the core count changes.
        if (this._coreWidgets.length !== cpu.cores.length) {
            this.coresContainer.destroy_all_children();
            this._coreWidgets = [];

            for (let i = 0; i < cpu.cores.length; i += 2) {
                const row = new St.BoxLayout({style_class: 'smp-cores-row'});

                const w1 = this._createCoreWidget(i);
                row.add_child(w1.box);
                this._coreWidgets.push(w1);

                row.add_child(new St.Widget({x_expand: true}));

                if (i + 1 < cpu.cores.length) {
                    const w2 = this._createCoreWidget(i + 1);
                    row.add_child(w2.box);
                    this._coreWidgets.push(w2);
                }

                this.coresContainer.add_child(row);
            }
        }

        for (let i = 0; i < cpu.cores.length; i++) {
            const usage = cpu.cores[i];
            const w = this._coreWidgets[i];

            w.val.text = `${usage.toFixed(0)}%`;
            setBarWidth(w.barFill, usage, 150);
            setStateClass(w.barFill, 'smp-progress', thresholdClass(usage));
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

const GpuCardItem = GObject.registerClass(
class GpuCardItem extends PopupMenu.PopupBaseMenuItem {
    _init(extension) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'smp-card',
        });
        this.set_vertical(true);

        const header = new St.BoxLayout({style_class: 'smp-card-header'});
        this.add_child(header);

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/smp-gpu-symbolic.svg`),
            style_class: 'smp-card-icon smp-color-gpu',
        });
        header.add_child(icon);

        const title = new St.Label({
            text: 'GPU Usage',
            style_class: 'smp-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);

        header.add_child(new St.Widget({x_expand: true}));

        this.valueLabel = new St.Label({
            text: '—',
            style_class: 'smp-card-value smp-color-gpu',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.valueLabel);

        this.gpusContainer = new St.BoxLayout({
            style_class: 'smp-gpus-container',
            vertical: true,
        });
        this.add_child(this.gpusContainer);

        this.emptyLabel = new St.Label({
            text: 'No GPU information available',
            style_class: 'smp-no-sensors',
        });
        this.gpusContainer.add_child(this.emptyLabel);

        this._gpuRows = [];
    }

    update(gpus, primary, isFahrenheit) {
        this.valueLabel.text = primary && primary.busy !== null
            ? `${primary.busy.toFixed(1)}%` : 'N/A';

        this.emptyLabel.visible = gpus.length === 0;

        resizeRowPool(this._gpuRows, gpus.length,
            () => this._createGpuEntry());

        const suffix = isFahrenheit ? '°F' : '°C';
        const conv = t => (isFahrenheit ? celsiusToFahrenheit(t) : t);

        gpus.forEach((gpu, i) => {
            const row = this._gpuRows[i];

            row.name.text = gpu.name;
            row.badge.text = gpu.integrated ? 'iGPU' : 'dGPU';
            row.percent.text = gpu.busy !== null
                ? `${gpu.busy.toFixed(0)}%` : 'N/A';
            setBarWidth(row.barFill, gpu.busy ?? 0, 500);

            // Detail rows only appear when the driver reports the metric, so
            // an iGPU is not a column of dashes.
            const hasVram = gpu.vramTotal !== null;
            row.vram.get_parent().visible = hasVram;
            if (hasVram) {
                row.vram.text =
                    `${formatBytes(gpu.vramUsed / 1024)} / ${formatBytes(gpu.vramTotal / 1024)}` +
                    `  ·  ${Math.round(gpu.vramPercent)}%`;
            }

            const hasFreq = gpu.freqMhz !== null;
            row.freq.get_parent().visible = hasFreq;
            if (hasFreq) {
                row.freq.text = gpu.freqMaxMhz
                    ? `${Math.round(gpu.freqMhz)} / ${Math.round(gpu.freqMaxMhz)} MHz`
                    : `${Math.round(gpu.freqMhz)} MHz`;
            }

            const hasTemp = gpu.tempC !== null;
            row.temp.get_parent().visible = hasTemp;
            if (hasTemp)
                row.temp.text = `${conv(gpu.tempC).toFixed(1)}${suffix}`;
        });
    }

    _createGpuEntry() {
        const entry = new St.BoxLayout({
            style_class: 'smp-gpu-entry',
            vertical: true,
        });

        const row = new St.BoxLayout({style_class: 'smp-gpu-row'});

        const name = new St.Label({
            style_class: 'smp-gpu-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);

        const badge = new St.Label({
            style_class: 'smp-gpu-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(badge);

        row.add_child(new St.Widget({x_expand: true}));

        const percent = new St.Label({
            style_class: 'smp-gpu-percent',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        row.add_child(percent);

        entry.add_child(row);

        const barBg = new St.BoxLayout({style_class: 'smp-bar-bg'});
        const barFill = new St.Widget({style_class: 'smp-bar-fill smp-color-gpu-bg'});
        barBg.add_child(barFill);
        entry.add_child(barBg);

        const vram = addStatRow(entry, 'VRAM', '—');
        const freq = addStatRow(entry, 'Frequency', '—');
        const temp = addStatRow(entry, 'Temperature', '—');

        this.gpusContainer.add_child(entry);
        return {root: entry, name, badge, percent, barFill, vram, freq, temp};
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

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-mem-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        this.usedLabel = addStatRow(this, 'Used / Total', '—');
        this.availLabel = addStatRow(this, 'Available', '—');
        this.freeLabel = addStatRow(this, 'Free', '—');
        this.cachedLabel = addStatRow(this, 'Cached', '—');
        this.buffersLabel = addStatRow(this, 'Buffers', '—');

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

    update(mem) {
        this.valueLabel.text = `${mem.percent.toFixed(1)}%`;
        setBarWidth(this.progressBarFill, mem.percent, 220);

        this.usedLabel.text = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
        this.availLabel.text = formatBytes(mem.available);
        this.freeLabel.text = formatBytes(mem.free);
        this.cachedLabel.text = formatBytes(mem.cached);
        this.buffersLabel.text = formatBytes(mem.buffers);

        if (mem.swapTotal > 0) {
            this.swapBox.visible = true;
            this.swapValueLabel.text =
                `${Math.round(mem.swapPercent)}%  ·  ${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}`;
            setBarWidth(this.swapBarFill, mem.swapPercent, 220);
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

        this.overallLabel = new St.Label({
            text: 'Total storage used',
            style_class: 'smp-section-subtitle',
        });
        this.add_child(this.overallLabel);

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-disk-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        this.disksContainer = new St.BoxLayout({
            style_class: 'smp-disks-container',
            vertical: true,
        });
        this.add_child(this.disksContainer);

        this.emptyLabel = new St.Label({
            text: 'No mounted filesystems found',
            style_class: 'smp-no-sensors',
        });
        this.disksContainer.add_child(this.emptyLabel);

        this._diskRows = [];
    }

    update(disks, overall) {
        if (disks.length > 0) {
            this.valueLabel.text = `${overall.percent.toFixed(1)}%`;
            this.overallLabel.text =
                `Total · ${formatBytes(overall.used / 1024)} / ${formatBytes(overall.total / 1024)}`;
            setBarWidth(this.progressBarFill, overall.percent, 220);
            setStateClass(this.progressBarFill, 'smp-progress', thresholdClass(overall.percent));
        } else {
            this.valueLabel.text = 'N/A';
            this.overallLabel.text = 'Total storage used';
            this.progressBarFill.set_width(0);
        }

        const shown = disks.slice(0, 5);
        this.emptyLabel.visible = shown.length === 0;

        resizeRowPool(this._diskRows, shown.length,
            () => this._createDiskRow());

        shown.forEach((disk, i) => {
            const row = this._diskRows[i];
            row.name.text = disk.name;
            row.badge.visible = disk.isExternal;
            row.percent.text = `${Math.round(disk.percent)}%`;
            row.detail.text =
                `${formatBytes(disk.used / 1024)} / ${formatBytes(disk.total / 1024)} · ${formatBytes(disk.free / 1024)} free`;
            setBarWidth(row.barFill, disk.percent, 220);
            setStateClass(row.barFill, 'smp-progress', thresholdClass(disk.percent));
        });
    }

    _createDiskRow() {
        const entry = new St.BoxLayout({
            style_class: 'smp-disk-entry',
            vertical: true,
        });

        const row = new St.BoxLayout({style_class: 'smp-disk-row'});

        const name = new St.Label({
            style_class: 'smp-disk-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);

        const badge = new St.Label({
            text: 'EXT',
            style_class: 'smp-disk-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(badge);

        row.add_child(new St.Widget({x_expand: true}));

        const percent = new St.Label({
            style_class: 'smp-disk-percent',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        row.add_child(percent);

        entry.add_child(row);

        const barBg = new St.BoxLayout({style_class: 'smp-disk-bar-bg'});
        const barFill = new St.Widget({style_class: 'smp-disk-bar-fill'});
        barBg.add_child(barFill);
        entry.add_child(barBg);

        const detail = new St.Label({style_class: 'smp-disk-detail'});
        entry.add_child(detail);

        this.disksContainer.add_child(entry);
        return {root: entry, name, badge, percent, barFill, detail};
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

        this.overallLabel = new St.Label({
            text: 'Overall system temperature',
            style_class: 'smp-section-subtitle',
        });
        this.add_child(this.overallLabel);

        this.progressBarBg = new St.BoxLayout({style_class: 'smp-bar-bg smp-bar-bg-half'});
        this.progressBarFill = new St.Widget({style_class: 'smp-bar-fill smp-color-temp-bg'});
        this.progressBarBg.add_child(this.progressBarFill);
        this.add_child(this.progressBarBg);

        this.sensorsContainer = new St.BoxLayout({
            style_class: 'smp-sensors-container',
            vertical: true,
        });
        this.add_child(this.sensorsContainer);

        this.emptyLabel = new St.Label({
            text: 'No active temperature sensors found',
            style_class: 'smp-no-sensors',
        });
        this.sensorsContainer.add_child(this.emptyLabel);

        this._sensorRows = [];
    }

    update(temps, overall, isFahrenheit) {
        const suffix = isFahrenheit ? '°F' : '°C';
        const conv = t => (isFahrenheit ? celsiusToFahrenheit(t) : t);

        if (overall) {
            this.valueLabel.text = `${Math.round(conv(overall.tempC))}${suffix}`;
            this.overallLabel.text = `Overall · ${overall.name}`;
            setBarWidth(this.progressBarFill, (overall.tempC / 110) * 100, 220);
            setStateClass(this.progressBarFill, 'smp-progress', tempThresholdClass(overall.tempC));
        } else {
            this.valueLabel.text = 'N/A';
            this.overallLabel.text = 'Overall system temperature';
            this.progressBarFill.set_width(0);
        }

        // Build a clean, de-duplicated sensor list. Scanning both the thermal
        // and hwmon trees can surface the same physical sensor twice.
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

        this.emptyLabel.visible = rows.length === 0;

        resizeRowPool(this._sensorRows, rows.length,
            () => this._createSensorRow());

        rows.forEach((sensor, i) => {
            this._sensorRows[i].name.text = sensor.name;
            this._sensorRows[i].value.text = `${conv(sensor.tempC).toFixed(1)}${suffix}`;
        });
    }

    _createSensorRow() {
        const row = new St.BoxLayout({style_class: 'smp-sensor-row'});

        const name = new St.Label({
            style_class: 'smp-sensor-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);

        row.add_child(new St.Widget({x_expand: true}));

        const value = new St.Label({
            style_class: 'smp-sensor-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(value);

        this.sensorsContainer.add_child(row);
        return {root: row, name, value};
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

        this.downLabel = addStatRow(this, '↓  Download', '0 B/s');
        this.upLabel = addStatRow(this, '↑  Upload', '0 B/s');
        this.downLabel.style_class = 'smp-net-speed-value';
        this.upLabel.style_class = 'smp-net-speed-value';

        this.rxTotalLabel = addStatRow(this, 'Total received', '—');
        this.txTotalLabel = addStatRow(this, 'Total sent', '—');
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

        const monitorBtn = this._makeButton(
            'utilities-system-monitor-symbolic', 'System Monitor');
        monitorBtn.connect('clicked', () => {
            indicator.menu.close();
            this._launchSystemMonitor();
        });
        box.add_child(monitorBtn);

        const prefsBtn = this._makeButton(
            'preferences-system-symbolic', 'Preferences');
        prefsBtn.connect('clicked', () => {
            indicator.menu.close();
            try {
                extension.openPreferences();
            } catch (e) {
                console.error('System Monitor: openPreferences failed', e);
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
            // Recoverable: the spawn below is the real failure point.
            console.debug(`System Monitor: AppInfo launch failed: ${e}`);
        }
        // …and fall back to a raw spawn if that fails.
        try {
            GLib.spawn_command_line_async('gnome-system-monitor');
        } catch (e) {
            Main.notify('System Monitor', 'Could not launch gnome-system-monitor.');
            console.error('System Monitor: spawn launch failed', e);
        }
    }
});


/* ── Panel Indicator ──────────────────────────── */

const SystemMonitorIndicator = GObject.registerClass(
class SystemMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'System Monitor');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._metrics = new SystemMetrics();
        this._timerId = null;
        this._seedTimeoutId = null;
        this._queuedRefreshId = null;

        // Cancels in-flight filesystem queries at teardown so their callbacks
        // never touch a torn-down indicator.
        this._cancellable = new Gio.Cancellable();
        this._diskQueryPending = false;

        // Set once a refresh learns the machine exposes no GPU at all; keeps
        // the panel from pinning a permanent "N/A" slot on such machines.
        this._gpuUnavailable = false;

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

        this._gpuBox = this._createMetricBox(
            Gio.icon_new_for_string(`${extension.path}/icons/smp-gpu-symbolic.svg`), '—');
        this._panelBox.add_child(this._gpuBox.container);

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
        this.menu.connectObject(
            'open-state-changed', (_menu, isOpen) => {
                if (isOpen)
                    this._refreshAll();
            }, this);

        // Only the interval change needs to restart the timer.
        // GSettings emits 'changed' once per key, so a prefs dialog writing
        // several keys would otherwise trigger several full refreshes in a
        // row. Coalesce them into one pass on the next idle.
        this._settings.connectObject(
            'changed::refresh-interval', () => this._startTimer(),
            'changed', () => {
                this._applySettings();
                this._queueRefresh();
            }, this);

        // ── Initial settings + seed + timer ──
        this._applySettings();
        this._startTimer();

        // Seed the CPU, GPU and network deltas, then do the first real
        // refresh shortly after — a delta needs two samples. Results are
        // discarded; the timed refresh reports any real failure.
        this._metrics.getCpuUsage().catch(() => {});
        this._metrics.getNetworkSpeed().catch(() => {});
        // GPU display is off by default; don't touch its sysfs tree (or spawn
        // nvidia-smi) unless something will actually show the numbers.
        if (this._settings.get_boolean('show-gpu') ||
            this._settings.get_boolean('show-gpu-card'))
            this._metrics.getGpuUsage(this._cancellable).catch(() => {});
        this._seedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._seedTimeoutId = null;
            this._refreshAll();
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

        this._gpuCard = new GpuCardItem(this._extension);
        this.menu.addMenuItem(this._gpuCard);

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
        const showGpu = this._settings.get_boolean('show-gpu');
        const showMem = this._settings.get_boolean('show-memory');
        const showDisk = this._settings.get_boolean('show-disk');
        const showTemp = this._settings.get_boolean('show-temperature');
        const showNet = this._settings.get_boolean('show-network');
        // Dropdown menu card toggles.
        const showCpuCard = this._settings.get_boolean('show-cpu-card');
        const showGpuCard = this._settings.get_boolean('show-gpu-card');
        const showMemCard = this._settings.get_boolean('show-memory-card');
        const showDiskCard = this._settings.get_boolean('show-disk-card');
        const showTempCard = this._settings.get_boolean('show-temperature-card');
        const showNetCard = this._settings.get_boolean('show-network-card');
        const showIcons = this._settings.get_boolean('show-icons');

        this._cpuBox.container.visible = showCpu;
        this._gpuBox.container.visible = showGpu && !this._gpuUnavailable;
        this._memBox.container.visible = showMem;
        this._diskBox.container.visible = showDisk;
        this._tempBox.container.visible = showTemp;
        this._netBox.container.visible = showNet;

        for (const box of [this._cpuBox, this._gpuBox, this._memBox, this._diskBox, this._tempBox, this._netBox])
            box.icon.visible = showIcons;

        this._cpuCard.visible = showCpuCard;
        this._gpuCard.visible = showGpuCard;
        this._memCard.visible = showMemCard;
        this._diskCard.visible = showDiskCard;
        this._tempCard.visible = showTempCard;
        this._netCard.visible = showNetCard;
        // Hide each shared row entirely when neither of its cards is shown.
        this._memDiskRow.visible = showMemCard || showDiskCard;
        this._tempNetRow.visible = showTempCard || showNetCard;
    }

    _startTimer() {
        // Guard against leaking an existing source if called twice.
        this._stopTimer();
        const interval = Math.max(5, this._settings.get_int('refresh-interval'));
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

    /** Collapse a burst of settings changes into a single refresh. */
    _queueRefresh() {
        if (this._queuedRefreshId)
            return;
        this._queuedRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._queuedRefreshId = null;
            this._refreshAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _isVisible(box, card) {
        return box.container.visible || (card.visible && this.menu.isOpen);
    }

    _shouldUpdateCard(card) {
        return card.visible && this.menu.isOpen;
    }

    // Each metric refreshes independently and concurrently, with its own
    // error handling, so a slow or failing one never blocks the others.
    _refreshAll() {
        const metrics = [
            ['CPU', this._cpuBox, this._cpuCard, () => this._refreshCpu()],
            ['GPU', this._gpuBox, this._gpuCard, () => this._refreshGpu()],
            ['memory', this._memBox, this._memCard, () => this._refreshMemory()],
            ['disk', this._diskBox, this._diskCard, () => this._refreshDisk()],
            ['temperature', this._tempBox, this._tempCard, () => this._refreshTemperature()],
            ['network', this._netBox, this._netCard, () => this._refreshNetwork()],
        ];

        for (const [name, box, card, refresh] of metrics) {
            if (!this._isVisible(box, card))
                continue;
            refresh().catch(e => {
                console.error(`System Monitor: ${name} refresh failed`, e);
            });
        }
    }

    async _refreshCpu() {
        const cpu = await this._metrics.getCpuUsage();
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;

        const overall = Math.round(cpu.overall);
        this._cpuBox.label.text = `${overall}%`;
        setStateClass(this._cpuBox.label, 'smp-label', thresholdClass(overall));

        if (this._shouldUpdateCard(this._cpuCard))
            this._cpuCard.update(cpu);
    }

    async _refreshGpu() {
        const isFahrenheit = this._settings.get_string('temperature-unit') === 'fahrenheit';

        const gpus = await this._metrics.getGpuUsage(this._cancellable);
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;

        // No GPU on this machine: give the panel slot back rather than pin a
        // permanent "N/A" there. The card stays and says so explicitly.
        const unavailable = gpus.length === 0;
        if (unavailable !== this._gpuUnavailable) {
            this._gpuUnavailable = unavailable;
            this._gpuBox.container.visible =
                this._settings.get_boolean('show-gpu') && !unavailable;
        }

        const primary = this._metrics.getPrimaryGpu(gpus);

        if (primary && primary.busy !== null) {
            const busy = Math.round(primary.busy);
            this._gpuBox.label.text = `${busy}%`;
            setStateClass(this._gpuBox.label, 'smp-label', thresholdClass(busy));
        } else {
            this._gpuBox.label.text = 'N/A';
            setStateClass(this._gpuBox.label, 'smp-label', thresholdClass(0));
        }

        if (this._shouldUpdateCard(this._gpuCard))
            this._gpuCard.update(gpus, primary, isFahrenheit);
    }

    async _refreshMemory() {
        const mem = await this._metrics.getMemoryUsage();
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;

        const percent = Math.round(mem.percent);
        this._memBox.label.text = `${percent}%`;
        setStateClass(this._memBox.label, 'smp-label', thresholdClass(percent));

        if (this._shouldUpdateCard(this._memCard))
            this._memCard.update(mem);
    }

    async _refreshDisk() {
        // statfs runs on a worker thread, so a tick can land while the previous
        // set of queries is still outstanding on a slow mount. Skip it rather
        // than pile up overlapping queries.
        if (this._diskQueryPending)
            return;

        const includeExternal = this._settings.get_boolean('show-external-disks');
        this._diskQueryPending = true;

        try {
            const disks = await this._metrics.getDiskUsage(
                includeExternal, this._cancellable);
            if (!this._cancellable || this._cancellable.is_cancelled())
                return;

            const overall = this._metrics.getOverallDiskUsage(disks);

            if (disks.length > 0) {
                const percent = Math.round(overall.percent);
                this._diskBox.label.text = `${percent}%`;
                setStateClass(this._diskBox.label, 'smp-label', thresholdClass(percent));
            } else {
                this._diskBox.label.text = 'N/A';
                setStateClass(this._diskBox.label, 'smp-label', thresholdClass(0));
            }

            if (this._shouldUpdateCard(this._diskCard))
                this._diskCard.update(disks, overall);
        } finally {
            this._diskQueryPending = false;
        }
    }

    async _refreshTemperature() {
        const isFahrenheit = this._settings.get_string('temperature-unit') === 'fahrenheit';

        const temps = await this._metrics.getTemperatures();
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;

        const overall = this._metrics.getOverallTemperature(temps);

        if (overall) {
            const displayTemp = isFahrenheit ? celsiusToFahrenheit(overall.tempC) : overall.tempC;
            const suffix = isFahrenheit ? '°F' : '°C';
            this._tempBox.label.text = `${Math.round(displayTemp)}${suffix}`;
            setStateClass(this._tempBox.label, 'smp-label', tempThresholdClass(overall.tempC));
        } else {
            this._tempBox.label.text = 'N/A';
            setStateClass(this._tempBox.label, 'smp-label', thresholdClass(0));
        }

        if (this._shouldUpdateCard(this._tempCard))
            this._tempCard.update(temps, overall, isFahrenheit);
    }

    async _refreshNetwork() {
        const useBits = this._settings.get_string('network-unit') === 'bits';

        const net = await this._metrics.getNetworkSpeed();
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;

        this._netBox.label.text =
            `↓${formatSpeedCompact(net.rxSpeed, useBits)} ↑${formatSpeedCompact(net.txSpeed, useBits)}`;
        // Network has no percentage scale, so keep the panel label neutral.
        setStateClass(this._netBox.label, 'smp-label', thresholdClass(0));

        if (this._shouldUpdateCard(this._netCard))
            this._netCard.update(net, useBits);
    }

    destroy() {
        this._stopTimer();

        // Outstanding statfs callbacks would otherwise fire against a
        // half-torn-down indicator.
        this._cancellable.cancel();
        this._cancellable = null;

        if (this._seedTimeoutId) {
            GLib.source_remove(this._seedTimeoutId);
            this._seedTimeoutId = null;
        }

        if (this._queuedRefreshId) {
            GLib.source_remove(this._queuedRefreshId);
            this._queuedRefreshId = null;
        }

        this.menu.disconnectObject(this);
        this._settings.disconnectObject(this);

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
 *
 * `_leftBox`/`_rightBox` are private Shell internals. addToStatusArea() takes a
 * public box name, but only as an insertion point — it cannot re-place an
 * indicator whose role is already claimed, and expressing "append" needs the
 * box's child count. Both require the box actor itself, so there is no public
 * route to these four positions today.
 *
 * If a future Shell renames them, _applyPosition() bails and the indicator
 * stays where addToStatusArea() put it, losing the setting but nothing else.
 */
const PANEL_POSITIONS = {
    'far-left': {box: '_leftBox', index: 0},
    'left': {box: '_leftBox', index: null},
    'right': {box: '_rightBox', index: 0},
    'far-right': {box: '_rightBox', index: null},
};

export default class SystemMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SystemMonitorIndicator(this);

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._applyPosition();

        this._settings.connectObject(
            'changed::panel-position', () => this._applyPosition(), this);
    }

    _applyPosition() {
        if (!this._indicator)
            return;

        const key = this._settings.get_string('panel-position');
        const {box, index} = PANEL_POSITIONS[key] ?? PANEL_POSITIONS['right'];

        const targetBox = Main.panel[box];
        if (!targetBox) {
            console.error(
                `System Monitor: this GNOME Shell no longer exposes ` +
                `Main.panel.${box}; keeping the default panel position.`);
            return;
        }

        const container = this._indicator.container;
        container.get_parent()?.remove_child(container);
        targetBox.insert_child_at_index(
            container, index ?? targetBox.get_n_children());
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
