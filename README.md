# System Monitor Panel

A GNOME Shell extension that shows **CPU usage, memory usage, network speed, and device temperature** right in the top panel, with a rich dropdown dashboard for detailed stats.

## Features

- **At-a-glance panel indicators** for CPU, memory, network, and temperature, with color-coded values (normal / warning / critical).
- **Detailed dropdown dashboard** with cards for each metric:
  - **CPU** — overall usage plus a per-core usage grid.
  - **Memory** — used/free/cached breakdown and swap usage.
  - **Network** — live download/upload speeds.
  - **Temperature** — readings from available hardware sensors.
- **Configurable refresh interval** (1–300 seconds).
- **Celsius or Fahrenheit** temperature display.
- **Toggle any metric** on or off, both in the panel and in the dropdown, plus options to hide icons or text labels.
- **Manual refresh** button in the dropdown footer.

## Requirements

- **GNOME Shell 50** (see `shell-version` in [metadata.json](metadata.json)).
- `glib-compile-schemas` (ships with GLib / `glib2-devel`), used to compile the settings schema.

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

### Option 3 — from the packaged zip

A prebuilt `system-monitor-panel@naimur.shell-extension.zip` is included:

```bash
gnome-extensions install --force system-monitor-panel@naimur.shell-extension.zip
gnome-extensions enable system-monitor-panel@naimur
```

## Applying changes / reloading

After installing you need to restart GNOME Shell so it picks up the extension:

- **Wayland:** log out and log back in (GNOME Shell cannot be restarted in place on Wayland).
- **X11:** press `Alt`+`F2`, type `r`, and press `Enter`.

## Configuration

Open the preferences UI to adjust the refresh interval, temperature unit, and which metrics are shown:

```bash
gnome-extensions prefs system-monitor-panel@naimur
```

## Troubleshooting

View the extension's logs live:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
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

See repository for license details.
