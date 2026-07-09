# System Monitor Panel

A GNOME Shell extension that shows **CPU usage, memory usage, disk usage, network speed, and device temperature** right in the top panel, with a rich dropdown dashboard for detailed stats.

## Features

- **At-a-glance panel indicators** for CPU, memory, disk, network, and temperature, with color-coded values (normal / warning / critical).
- **Detailed dropdown dashboard** with cards for each metric:
  - **CPU** — overall usage plus a per-core usage grid.
  - **Memory** — used/available/free/cached/buffers breakdown and swap usage.
  - **Disk** — combined usage plus a per-filesystem breakdown, with removable drives optionally included and badged `EXT`.
  - **Network** — live download/upload speeds and cumulative totals since boot.
  - **Temperature** — readings from available hardware sensors, with the CPU package sensor preferred for the headline value.
- **Configurable refresh interval** (1–300 seconds).
- **Celsius or Fahrenheit** temperature display.
- **Bytes or bits** network speed display (MB/s or Mbps).
- **Configurable panel position** — either end of the left or right panel box.
- **Toggle any metric** on or off, both in the panel and in the dropdown, plus an option to hide icons.
- **Manual refresh** button in the dropdown footer.

## Requirements

- **GNOME Shell 50** (see `shell-version` in [metadata.json](metadata.json)).
- `glib-compile-schemas` (ships with GLib / `glib2-devel`), used to compile the settings schema.

Temperature and disk readings come from `/sys/class/thermal`, `/sys/class/hwmon`, and `/proc/mounts`. Machines that expose no readable sensor show `N/A` rather than failing.

## Installation

### Option 1 — install script (recommended for development)

The included [install.sh](install.sh) compiles the settings schema and symlinks this folder into your local extensions directory:

```bash
./install.sh
```

Then enable the extension:

```bash
gnome-extensions enable system-monitor-panel@naimur
```

### Option 2 — manual install

```bash
# 1. Compile the GSettings schema
glib-compile-schemas schemas/

# 2. Copy (or symlink) into the extensions directory
cp -r . ~/.local/share/gnome-shell/extensions/system-monitor-panel@naimur

# 3. Enable it
gnome-extensions enable system-monitor-panel@naimur
```

### Option 3 — from extensions.gnome.org

Install from the extension's page on [extensions.gnome.org](https://extensions.gnome.org/).

## Packaging for extensions.gnome.org

Build the upload bundle with the official packer, which compiles the schema and
excludes development files:

```bash
gnome-extensions pack --force \
  --extra-source=icons \
  --extra-source=LICENSE \
  --schema=schemas/org.gnome.shell.extensions.system-monitor-panel.gschema.xml
```

This writes `system-monitor-panel@naimur.shell-extension.zip`, ready to upload.
Do not add a `version` field to [metadata.json](metadata.json) — the site assigns
version numbers itself.

## Applying changes / reloading

After installing you need to restart GNOME Shell so it picks up the extension:

- **Wayland:** log out and log back in (GNOME Shell cannot be restarted in place on Wayland).
- **X11:** press `Alt`+`F2`, type `r`, and press `Enter`.

Editing `extension.js` while the extension is enabled has no effect until the Shell reloads — disabling and re-enabling the extension is not enough.

## Configuration

Open the preferences UI to adjust settings:

```bash
gnome-extensions prefs system-monitor-panel@naimur
```

| Setting | Default | Notes |
|---------|---------|-------|
| `refresh-interval` | `30` | Seconds between updates (1–300). |
| `temperature-unit` | `celsius` | `celsius` or `fahrenheit`. |
| `network-unit` | `bytes` | `bytes` (MB/s) or `bits` (Mbps). |
| `panel-position` | `right` | `far-left`, `left`, `right`, or `far-right`. |
| `show-cpu` / `-memory` / `-disk` / `-temperature` / `-network` | `true` | Panel indicator for each metric. |
| `show-*-card` | `true` | Dropdown card for each metric. |
| `show-external-disks` | `false` | Include removable/USB drives in the disk card. |
| `show-icons` | `true` | Hide icons in the panel. |

Settings apply immediately; no reload is needed.

## Implementation notes

The extension runs inside the GNOME Shell compositor process, so everything it does on a timer is on the critical path for desktop responsiveness. A few consequences shape the code in [extension.js](extension.js):

- **Filesystem usage is queried asynchronously.** `statfs` blocks in uninterruptible sleep on a device that has stopped responding — a drive unplugged without unmounting, say — so a synchronous call would freeze the whole desktop. `query_filesystem_info_async` hands the syscall to a GIO worker thread instead.
- **Static metadata is cached.** Sensor paths are discovered once; mount points and each device's removable flag are cached and invalidated by `GioUnix.MountMonitor`. Only the values themselves are re-read on each refresh.
- **Nothing is collected for pixels that will not be drawn.** A metric is read only when its panel label is visible, or its card is visible and the dropdown is actually open. Dropdown rows are reused across refreshes rather than rebuilt.

Together these keep a short refresh interval (1–5 seconds) about as cheap as the 30-second default.

## Troubleshooting

View the extension's logs live:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Check that the extension loaded and is active:

```bash
gnome-extensions info system-monitor-panel@naimur
```

## Project structure

| File | Purpose |
|------|---------|
| [extension.js](extension.js) | Main extension logic — panel indicators, dropdown, metric collection. |
| [prefs.js](prefs.js) | libadwaita preferences window. |
| [stylesheet.css](stylesheet.css) | Panel and dropdown styling. |
| [metadata.json](metadata.json) | Extension metadata (UUID, name, shell version). |
| [schemas/](schemas/) | GSettings schema for user preferences. |
| [icons/](icons/) | Symbolic panel icons. |
| [install.sh](install.sh) | Compiles the schema and installs via symlink. |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
