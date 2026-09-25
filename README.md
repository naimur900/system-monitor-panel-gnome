# System Monitor

A GNOME Shell extension that shows **CPU usage, memory usage, disk usage, network speed, and device temperature** right in the top panel, with a rich dropdown dashboard for detailed stats.

<p align="center">
  <a href="https://extensions.gnome.org/extension/10372/system-monitor-panel/">
    <img src="public/gnome-logo.png"
         alt="Install from GNOME Extensions"
         width="260">
  </a>
</p>

<p align="center">
  <a href="https://extensions.gnome.org/extension/10372/system-monitor-panel/"><strong>Install from GNOME Extensions →</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME-48--50-4A86CF?logo=gnome&logoColor=white" alt="GNOME Shell">
  <img src="https://img.shields.io/badge/License-GPL--2.0-green.svg" alt="License">
</p>

<p align="center">
  <img src="public/img-1.png" alt="The top panel showing CPU usage, memory usage and temperature indicators" width="700">
</p>
<p align="center"><em>The at-a-glance indicators in the top panel.</em></p>

## Features

- **At-a-glance panel indicators** for CPU, GPU, memory, disk, network, and temperature, with color-coded values (normal / warning / critical), in whatever left-to-right order you arrange them.
- **Detailed dropdown dashboard** with cards for each metric:
  - **CPU** — overall usage plus a per-core usage grid.
  - **GPU** — one entry per card, badged `iGPU`/`dGPU`, with usage, VRAM, clock and temperature wherever the driver reports them.
  - **Memory** — used/available/free/cached/buffers breakdown and swap usage.
  - **Disk** — combined usage plus a per-filesystem breakdown, with removable drives optionally included and badged `EXT`.
  - **Network** — live download/upload speeds and cumulative totals since boot.
  - **Temperature** — readings from the significant hardware sensors (CPU, GPU, chipset, motherboard, drives, Wi-Fi), one per component, with the CPU package sensor preferred for the headline value.
- **Configurable refresh interval** (2–300 seconds).
- **Reorderable panel items** — arrange the metrics left to right however you like.
- **Celsius or Fahrenheit** temperature display.
- **Bytes or bits** network speed display (MB/s or Mbps).
- **Configurable panel position** — either end of the left or right panel box.
- **Toggle any metric** on or off, both in the panel and in the dropdown, plus an option to hide icons.
- **Configurable System Monitor app** from the footer button, using either a desktop default or a user-selected app ID/command.
- **Manual refresh** button in the dropdown footer.

<p align="center">
  <img src="public/img-2.png" alt="The dropdown dashboard with cards for CPU, memory, disk, temperature and network" width="600">
</p>
<p align="center"><em>The dropdown dashboard, with a card per metric.</em></p>

## Requirements

- GNOME Shell 48, 49 or 50
- `glib-compile-schemas` (ships with GLib / `glib2-devel`), used to compile the settings schema

Temperature and disk readings come from `/sys/class/thermal`, `/sys/class/hwmon`, and `/proc/mounts`. Machines that expose no readable sensor show `N/A` rather than failing.

GPU metrics come from whatever the loaded driver publishes, which differs by vendor:

| Driver               | Usage                | VRAM | Clock | Temperature |
| -------------------- | -------------------- | ---- | ----- | ----------- |
| `amdgpu` / `radeon`  | yes                  | yes  | yes   | yes         |
| `i915` / `xe`        | yes (idle residency) | —    | yes   | discrete cards only |
| `nvidia` proprietary | yes, via `nvidia-smi`| yes  | yes   | yes         |
| `nouveau`            | —                    | —    | —     | yes         |

Utilization is the one metric with no shared kernel interface. `nouveau` publishes none at all, and the proprietary NVIDIA driver only answers through `nvidia-smi`, so the GPU card names the driver standing in the way instead of showing a bare `N/A`. Intel integrated graphics have no temperature sensor of their own — their die shares the CPU package sensor.

## Install

```sh
make install
```

Then log out and back in — GNOME Shell only scans for new extensions at startup,
and on Wayland it cannot be restarted in place. After logging back in:

```sh
make enable
make prefs     # open the preferences window
```

Or install directly from the official GNOME Extensions website:

**https://extensions.gnome.org/extension/10372/system-monitor-panel/**

## Development

```sh
make check     # syntax-check the JS, schema and metadata
make schemas   # compile the GSettings schema
make pack      # build a distributable zip for extensions.gnome.org
make logs      # follow this extension's shell log output
make uninstall
```

Note that changes to an already-loaded extension also require a log out and back
in on Wayland, because the shell caches ES modules for the life of the process.

Do not add a `version` field to [src/metadata.json](src/metadata.json) — extensions.gnome.org
assigns version numbers itself.

## Settings

| Setting                                                        | Default   | Description                                   |
| -------------------------------------------------------------- | --------- | --------------------------------------------- |
| `refresh-interval`                                             | `30`      | Seconds between updates (2–300)               |
| `temperature-unit`                                             | `celsius` | `celsius` or `fahrenheit`                     |
| `network-unit`                                                 | `bytes`   | `bytes` (MB/s) or `bits` (Mbps)               |
| `panel-position`                                               | `right`   | `far-left`, `left`, `right`, or `far-right`   |
| `panel-order`                                                  | `cpu`, `gpu`, `memory`, `disk`, `temperature`, `network` | Left-to-right order of the panel indicators |
| `show-cpu` / `-memory` / `-disk` / `-temperature` / `-network` | on        | Panel indicator for each metric               |
| `show-gpu` / `show-gpu-card`                                   | off       | GPU indicator and card (hidden when no GPU reports usage) |
| `show-*-card`                                                  | on        | Dropdown card for each metric                 |
| `show-external-disks`                                          | off       | Include removable/USB drives in the disk card |
| `system-monitor-command`                                       | empty     | Override the footer button's app launch target; leave empty to use the desktop default System Monitor app |
| `show-icons`                                                   | on        | Icons in the panel                            |

Settings apply immediately; no reload is needed.

## Layout

| File                                 | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| [src/extension.js](src/extension.js) | Panel indicators, dropdown dashboard, metric collection |
| [src/prefs.js](src/prefs.js)         | Preferences window                                      |
| [src/panelMetrics.js](src/panelMetrics.js) | Panel metric ids and order, shared by both of the above |
| [src/icons/](src/icons/)             | Symbolic panel icons                                    |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

This is the license required for submission to
[extensions.gnome.org](https://extensions.gnome.org).

## Notes

The extension runs inside the GNOME Shell compositor process, so everything it does on a timer is on the critical path for desktop responsiveness. A few consequences shape the code in [src/extension.js](src/extension.js):

- **All file IO is asynchronous.** `statfs` blocks in uninterruptible sleep on a device that has stopped responding — a drive unplugged without unmounting, say — so a synchronous call would freeze the whole desktop. `query_filesystem_info_async` hands the syscall to a GIO worker thread instead, and the `/proc` and `/sys` readings go through `load_contents_async` the same way, keeping every read off the compositor thread.
- **Static metadata is cached.** Sensor paths are discovered once; mount points and each device's removable flag are cached and invalidated by `GioUnix.MountMonitor`. Only the values themselves are re-read on each refresh.
- **Nothing is collected for pixels that will not be drawn.** A metric is read only when its panel label is visible, or its card is visible and the dropdown is actually open. Dropdown rows are reused across refreshes rather than rebuilt.

Together these keep a short refresh interval (2–5 seconds) about as cheap as the 30-second default: a sweep of every metric costs roughly 2.6 ms of CPU, or about 0.26% of one core at the 2-second floor.
