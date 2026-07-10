UUID    = system-monitor-panel@naimur
SRC     = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall enable disable pack check logs prefs clean

all: schemas

# Compiles schemas in place so `make check` and local installs see gschemas.compiled.
schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	glib-compile-schemas --strict $(SRC)/schemas/

install: schemas
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(SRC)/. $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Now log out and back in (Wayland), then: make enable"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Syntax-checks every module without a running shell.
check:
	@for f in $(SRC)/*.js; do \
		node --check "$$f" >/dev/null 2>&1 && echo "ok   $$f" || { echo "FAIL $$f"; node --check "$$f"; exit 1; }; \
	done
	@glib-compile-schemas --strict --dry-run $(SRC)/schemas/ && echo "ok   schemas"
	@python3 -c "import json;json.load(open('$(SRC)/metadata.json'))" && echo "ok   metadata.json"

pack: schemas
	rm -f $(UUID).shell-extension.zip
	gnome-extensions pack $(SRC) \
		--extra-source=icons \
		--extra-source="$(CURDIR)/LICENSE" \
		--schema=schemas/org.gnome.shell.extensions.system-monitor-panel.gschema.xml \
		--force

# Live extension logs. Ctrl-C to stop.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "system-monitor-panel\|SystemMonitorPanel"

clean:
	rm -f $(SRC)/schemas/gschemas.compiled $(UUID).shell-extension.zip
