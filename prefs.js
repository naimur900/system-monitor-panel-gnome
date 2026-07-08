/* ============================================
   System Monitor Panel — prefs.js
   GNOME 50 Preferences UI (libadwaita)
   ============================================ */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class SystemMonitorPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(480, 560);

        // ── General Page ──
        const page = new Adw.PreferencesPage({
            title: 'System Monitor Panel',
            icon_name: 'utilities-system-monitor-symbolic',
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

        // ── Top Panel Visibility Group ──
        const visGroup = new Adw.PreferencesGroup({
            title: 'Top Panel',
            description: 'Choose which metrics appear in the top panel',
        });
        page.add(visGroup);

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
            title: 'Dropdown Menu Cards',
            description: 'Choose which detail cards appear in the dropdown menu',
        });
        page.add(cardGroup);

        // Show CPU Card
        const cpuCardRow = new Adw.SwitchRow({
            title: 'Show CPU Card',
            subtitle: 'Display the CPU usage card in the dropdown',
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
            subtitle: 'Display the memory usage card in the dropdown',
        });
        settings.bind(
            'show-memory-card',
            memCardRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        cardGroup.add(memCardRow);

        // Show Temperature Card
        const tempCardRow = new Adw.SwitchRow({
            title: 'Show Temperature Card',
            subtitle: 'Display the temperature card in the dropdown',
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
            subtitle: 'Display the network speed card in the dropdown',
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
        const labelsRow = new Adw.SwitchRow({
            title: 'Show Text Labels',
            subtitle: 'Display text values next to icons',
        });
        settings.bind(
            'show-labels',
            labelsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(labelsRow);
    }
}
