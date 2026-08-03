/* ============================================
   System Monitor — prefs.js
   GNOME 50 Preferences UI (libadwaita)
   ============================================

   SPDX-FileCopyrightText: 2026 Naimur Rahman
   SPDX-License-Identifier: GPL-2.0-or-later
*/

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { PANEL_METRICS, sanitizePanelOrder } from './panelMetrics.js';


export default class SystemMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // The reorder rows below keep reading this object after
        // fillPreferencesWindow() returns; anchoring it to the window ties its
        // lifetime to theirs instead of to this call's scope.
        window._settings = settings;

        window.set_default_size(780, 780);

        // ── General Page ──
        // Adw.PreferencesPage has no padding property; margins inset its
        // content so the groups sit further from the window edges.
        const page = new Adw.PreferencesPage({
            title: 'System Monitor',
            icon_name: 'utilities-system-monitor-symbolic',
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 32,
            margin_end: 32,
        });
        window.add(page);

        // ── General Settings Group ──
        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'General monitoring settings',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to update metrics automatically (2–300 seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 300,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const tempUnitRow = new Adw.ActionRow({
            title: 'Temperature Unit',
            subtitle: 'Choose between Celsius and Fahrenheit',
        });

        const tempUnitDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Celsius (°C)', 'Fahrenheit (°F)']),
            valign: Gtk.Align.CENTER,
        });

        const currentUnit = settings.get_string('temperature-unit');
        tempUnitDropdown.set_selected(currentUnit === 'fahrenheit' ? 1 : 0);

        tempUnitDropdown.connect('notify::selected', (dropdown) => {
            const idx = dropdown.get_selected();
            settings.set_string('temperature-unit', idx === 1 ? 'fahrenheit' : 'celsius');
        });

        tempUnitRow.add_suffix(tempUnitDropdown);
        tempUnitRow.set_activatable_widget(tempUnitDropdown);
        generalGroup.add(tempUnitRow);

        const netUnitRow = new Adw.ActionRow({
            title: 'Network Speed Unit',
            subtitle: 'Choose between bytes per second and bits per second',
        });

        const netUnitDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Bytes (KB/s, MB/s)', 'Bits (kbps, Mbps)']),
            valign: Gtk.Align.CENTER,
        });

        const currentNetUnit = settings.get_string('network-unit');
        netUnitDropdown.set_selected(currentNetUnit === 'bits' ? 1 : 0);

        netUnitDropdown.connect('notify::selected', (dropdown) => {
            const idx = dropdown.get_selected();
            settings.set_string('network-unit', idx === 1 ? 'bits' : 'bytes');
        });

        netUnitRow.add_suffix(netUnitDropdown);
        netUnitRow.set_activatable_widget(netUnitDropdown);
        generalGroup.add(netUnitRow);

        const launchCommandRow = new Adw.ActionRow({
            title: 'System Monitor App',
            subtitle: 'Desktop entry ID or command line to open when the button is pressed. Leave empty for the desktop default.',
        });

        const launchCommandEntry = new Gtk.Entry({
            text: settings.get_string('system-monitor-command') || '',
            valign: Gtk.Align.CENTER,
            hexpand: true,
            placeholder_text: 'org.gnome.SystemMonitor.desktop',
        });

        launchCommandEntry.connect('changed', () => {
            settings.set_string('system-monitor-command', launchCommandEntry.get_text().trim());
        });

        launchCommandRow.add_suffix(launchCommandEntry);
        launchCommandRow.set_activatable_widget(launchCommandEntry);
        generalGroup.add(launchCommandRow);

        // ── Top Panel Visibility Group ──
        const visGroup = new Adw.PreferencesGroup({
            title: 'Top Panel',
            description: 'Choose where the indicator sits and which metrics appear',
        });
        page.add(visGroup);

        // Panel position. Order matches the on-screen left-to-right order.
        const POSITION_VALUES = ['far-left', 'left', 'right', 'far-right'];

        const positionRow = new Adw.ActionRow({
            title: 'Panel Position',
            subtitle: 'Where the indicator appears in the top panel',
        });

        const positionDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Far Left', 'Left', 'Right', 'Far Right']),
            valign: Gtk.Align.CENTER,
        });

        // Set current value, falling back to 'right' for an unknown string.
        const currentPos = POSITION_VALUES.indexOf(settings.get_string('panel-position'));
        positionDropdown.set_selected(currentPos === -1
            ? POSITION_VALUES.indexOf('right')
            : currentPos);

        positionDropdown.connect('notify::selected', (dropdown) => {
            settings.set_string('panel-position', POSITION_VALUES[dropdown.get_selected()]);
        });

        positionRow.add_suffix(positionDropdown);
        positionRow.set_activatable_widget(positionDropdown);
        visGroup.add(positionRow);

        const cpuRow = new Adw.SwitchRow({
            title: 'Show CPU Usage',
            subtitle: 'Display CPU usage percentage in the panel',
        });
        settings.bind(
            'show-cpu',
            cpuRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(cpuRow);

        const gpuRow = new Adw.SwitchRow({
            title: 'Show GPU Usage',
            subtitle: 'Display GPU usage percentage in the panel (hidden when no GPU is detected)',
        });
        settings.bind(
            'show-gpu',
            gpuRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(gpuRow);

        const memRow = new Adw.SwitchRow({
            title: 'Show Memory Usage',
            subtitle: 'Display memory usage percentage in the panel',
        });
        settings.bind(
            'show-memory',
            memRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(memRow);

        const diskRow = new Adw.SwitchRow({
            title: 'Show Disk Usage',
            subtitle: 'Display total disk usage percentage in the panel',
        });
        settings.bind(
            'show-disk',
            diskRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(diskRow);

        const tempRow = new Adw.SwitchRow({
            title: 'Show Temperature',
            subtitle: 'Display device temperature in the panel',
        });
        settings.bind(
            'show-temperature',
            tempRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(tempRow);

        const netRow = new Adw.SwitchRow({
            title: 'Show Network Speed',
            subtitle: 'Display network download/upload speed in the panel',
        });
        settings.bind(
            'show-network',
            netRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        visGroup.add(netRow);

        // Keyed by metric id so the reorder rows below can mirror each
        // metric's visibility without re-reading GSettings.
        const panelSwitches = new Map([
            ['cpu', cpuRow],
            ['gpu', gpuRow],
            ['memory', memRow],
            ['disk', diskRow],
            ['temperature', tempRow],
            ['network', netRow],
        ]);

        // ── Panel Order Group ──
        const orderGroup = new Adw.PreferencesGroup({
            title: 'Panel Order',
            description: 'Arrange the metrics inside the indicator. ' +
                'The top of this list is the leftmost item in the panel.',
        });
        page.add(orderGroup);

        // A list box of the group's own rather than rows added straight to it:
        // Gtk.ListBox.insert() moves an existing row to a new position, so the
        // arrows carry each row — and the keyboard focus sitting on it —
        // instead of tearing the list down and rebuilding it under the user.
        const orderList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        orderList.add_css_class('boxed-list');
        orderGroup.add(orderList);

        const order = sanitizePanelOrder(settings.get_strv('panel-order'));
        const orderRows = new Map();

        // Only the ends of the list change what is possible, so sensitivity is
        // the one thing a move has to recompute.
        const updateArrows = () => {
            order.forEach((id, index) => {
                const {up, down} = orderRows.get(id);
                up.sensitive = index > 0;
                down.sensitive = index < order.length - 1;
            });
        };

        const moveMetric = (id, delta) => {
            const from = order.indexOf(id);
            const to = from + delta;
            if (to < 0 || to >= order.length)
                return;

            order.splice(from, 1);
            order.splice(to, 0, id);

            const {row, up, down} = orderRows.get(id);
            orderList.remove(row);
            orderList.insert(row, to);

            settings.set_strv('panel-order', order);
            updateArrows();

            // Unparenting the row drops the focus the click or keypress left
            // on its arrow. Hand it straight back — to the opposite arrow when
            // the move landed at an end — so a metric can be walked across the
            // panel with repeated presses.
            const pressed = delta < 0 ? up : down;
            const focused = pressed.sensitive ? pressed : (delta < 0 ? down : up);
            focused.grab_focus();
        };

        for (const id of order) {
            const metric = PANEL_METRICS.find(m => m.id === id);
            const row = new Adw.ActionRow({title: metric.title});

            const arrows = new Gtk.Box({
                spacing: 6,
                valign: Gtk.Align.CENTER,
            });

            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: `Move ${metric.title} left in the panel`,
            });
            up.add_css_class('flat');
            up.connect('clicked', () => moveMetric(id, -1));
            arrows.append(up);

            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: `Move ${metric.title} right in the panel`,
            });
            down.add_css_class('flat');
            down.connect('clicked', () => moveMetric(id, 1));
            arrows.append(down);

            row.add_suffix(arrows);
            orderList.append(row);

            orderRows.set(id, {row, up, down});

            // A metric switched off keeps its place in the order; saying so
            // here stops the list from looking out of step with the panel.
            const switchRow = panelSwitches.get(id);
            const syncSubtitle = () => {
                row.subtitle = switchRow.active ? '' : 'Hidden in the panel';
            };
            syncSubtitle();
            switchRow.connect('notify::active', syncSubtitle);
        }

        updateArrows();

        // ── Dropdown Menu Cards Group ──
        const cardGroup = new Adw.PreferencesGroup({
            title: 'Menu',
            description: 'Choose which detail cards appear in the menu',
        });
        page.add(cardGroup);

        const cpuCardRow = new Adw.SwitchRow({
            title: 'Show CPU Card',
            subtitle: 'Display the CPU usage card in the menu',
        });
        settings.bind(
            'show-cpu-card',
            cpuCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(cpuCardRow);

        const gpuCardRow = new Adw.SwitchRow({
            title: 'Show GPU Card',
            subtitle: 'Display the GPU usage card in the menu',
        });
        settings.bind(
            'show-gpu-card',
            gpuCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(gpuCardRow);

        const memCardRow = new Adw.SwitchRow({
            title: 'Show Memory Card',
            subtitle: 'Display the memory usage card in the menu',
        });
        settings.bind(
            'show-memory-card',
            memCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(memCardRow);

        const diskCardRow = new Adw.SwitchRow({
            title: 'Show Disk Card',
            subtitle: 'Display the disk usage card in the menu',
        });
        settings.bind(
            'show-disk-card',
            diskCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(diskCardRow);

        // Show External Disks — only meaningful while the disk card is shown.
        const externalDisksRow = new Adw.SwitchRow({
            title: 'Show External Disks',
            subtitle: 'Include removable and USB drives in the disk card',
        });
        settings.bind(
            'show-external-disks',
            externalDisksRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            'show-disk-card',
            externalDisksRow,
            'sensitive',
            Gio.SettingsBindFlags.GET
        );
        cardGroup.add(externalDisksRow);

        const tempCardRow = new Adw.SwitchRow({
            title: 'Show Temperature Card',
            subtitle: 'Display the temperature card in the menu',
        });
        settings.bind(
            'show-temperature-card',
            tempCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(tempCardRow);

        const netCardRow = new Adw.SwitchRow({
            title: 'Show Network Card',
            subtitle: 'Display the network speed card in the menu',
        });
        settings.bind(
            'show-network-card',
            netCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(netCardRow);

        // ── Display Group ──
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display Options',
            description: 'Customize how metrics are shown',
        });
        page.add(displayGroup);

        const iconsRow = new Adw.SwitchRow({
            title: 'Show Icons',
            subtitle: 'Display icons next to metric values',
        });
        settings.bind(
            'show-icons',
            iconsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(iconsRow);
    }
}
