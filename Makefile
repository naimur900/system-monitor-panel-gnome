UUID    = system-monitor-panel@naimur
SRC     = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP     = $(UUID).shell-extension.zip

# Throwaway virtualenv for the shexli static analyzer. Kept out of the repo and
# reused across runs, since building it hits the network.
SHEXLI_VENV = .shexli-venv

.PHONY: all schemas install uninstall enable disable pack check shexli clean-shexli logs prefs clean

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

# Static analysis for extensions.gnome.org packaging and review issues. Runs
# against a freshly packed zip — the actual submission artifact.
shexli: pack | $(SHEXLI_VENV)/.installed
	@$(SHEXLI_VENV)/bin/shexli "$(CURDIR)/$(ZIP)"

# Build the analyzer's virtualenv once, then reuse it. `virtualenv` is not
# assumed present, so the stdlib venv module is used. tree-sitter is held below
# 0.26, which segfaults against shexli's 0.25 JavaScript grammar. The sentinel
# is written only on success, so a failed install is retried rather than left
# half-built. `make clean-shexli` forces a full rebuild.
$(SHEXLI_VENV)/.installed:
	python3 -m venv $(SHEXLI_VENV)
	$(SHEXLI_VENV)/bin/pip install --upgrade pip
	$(SHEXLI_VENV)/bin/pip install --upgrade shexli 'tree-sitter<0.26'
	@touch $@
	@echo "shexli environment ready in $(SHEXLI_VENV)"

clean-shexli:
	rm -rf $(SHEXLI_VENV)

pack: schemas
	rm -f $(ZIP)
	gnome-extensions pack $(SRC) \
		--extra-source=icons \
		--extra-source="$(CURDIR)/LICENSE" \
		--schema=schemas/org.gnome.shell.extensions.system-monitor-panel.gschema.xml \
		--force

# Live extension logs. Ctrl-C to stop.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "system-monitor-panel\|SystemMonitor"

clean:
	rm -f $(SRC)/schemas/gschemas.compiled $(ZIP)



# make shexli          # pack a fresh zip + run shexli against it
# make check shexli    # your literal phrasing: syntax-check, then shexli
# make clean-shexli    # delete the analyzer env to force a rebuild