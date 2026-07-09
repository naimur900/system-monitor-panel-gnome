/* ============================================
   System Monitor Panel — prefs.js
   GNOME 50 Preferences UI (libadwaita)
   ============================================ */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class SystemMonitorPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(780, 780);

        // ── General Page ──
        // Adw.PreferencesPage has no padding property; margins inset its
        // content so the groups sit further from the window edges.
        const page = new Adw.PreferencesPage({
            title: 'System Monitor Panel',
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

        // Refresh interval
        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to update metrics automatically (1–300 seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
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

        // Temperature unit
        const tempUnitRow = new Adw.ActionRow({
            title: 'Temperature Unit',
            subtitle: 'Choose between Celsius and Fahrenheit',
        });

        const tempUnitDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Celsius (°C)', 'Fahrenheit (°F)']),
            valign: Gtk.Align.CENTER,
        });

        // Set current value
        const currentUnit = settings.get_string('temperature-unit');
        tempUnitDropdown.set_selected(currentUnit === 'fahrenheit' ? 1 : 0);

        tempUnitDropdown.connect('notify::selected', (dropdown) => {
            const idx = dropdown.get_selected();
            settings.set_string('temperature-unit', idx === 1 ? 'fahrenheit' : 'celsius');
        });

        tempUnitRow.add_suffix(tempUnitDropdown);
        tempUnitRow.set_activatable_widget(tempUnitDropdown);
        generalGroup.add(tempUnitRow);

        // Network unit
        const netUnitRow = new Adw.ActionRow({
            title: 'Network Speed Unit',
            subtitle: 'Choose between bytes per second and bits per second',
        });

        const netUnitDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(['Bytes (KB/s, MB/s)', 'Bits (kbps, Mbps)']),
            valign: Gtk.Align.CENTER,
        });

        // Set current value
        const currentNetUnit = settings.get_string('network-unit');
        netUnitDropdown.set_selected(currentNetUnit === 'bits' ? 1 : 0);

        netUnitDropdown.connect('notify::selected', (dropdown) => {
            const idx = dropdown.get_selected();
            settings.set_string('network-unit', idx === 1 ? 'bits' : 'bytes');
        });

        netUnitRow.add_suffix(netUnitDropdown);
        netUnitRow.set_activatable_widget(netUnitDropdown);
        generalGroup.add(netUnitRow);

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

        // Show CPU
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

        // Show Memory
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

        // Show Disk
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

        // Show Temperature
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

        // Show Network
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

        // ── Dropdown Menu Cards Group ──
        const cardGroup = new Adw.PreferencesGroup({
            title: 'Menu',
            description: 'Choose which detail cards appear in the menu',
        });
        page.add(cardGroup);

        // Show CPU Card
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

        // Show Memory Card
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

        // Show Disk Card
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

        // Show Temperature Card
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

        // Show Network Card
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

        // Show Icons
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

        // Show Labels
        // const labelsRow = new Adw.SwitchRow({
        //     title: 'Show Text Labels',
        //     subtitle: 'Display text values next to icons',
        // });
        // settings.bind(
        //     'show-labels',
        //     labelsRow,
        //     'active',
        //     Gio.SettingsBindFlags.DEFAULT
        // );
        // displayGroup.add(labelsRow);
    }
}
