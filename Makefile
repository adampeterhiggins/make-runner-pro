SHELL := /bin/zsh

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
VSIX_NAME := make-runner-pro-$(VERSION).vsix
CURSOR := cursor
EXTENSION_ID := make-runner-pro.make-runner-pro
FORCE ?= 0
YES ?= 0

.PHONY: install compile package vsix tag-version check-version ensure-version prepare-release cursor-install clean

install:
	npm install

compile:
	npm run compile

package: $(VSIX_NAME)

vsix: $(VSIX_NAME)
	@echo "Built $(VSIX_NAME)"

$(VSIX_NAME): compile
	npm run package

tag-version:
	@git rev-parse --git-dir >/dev/null 2>&1
	@git tag -f "$(TAG)" HEAD
	@echo "Tagged current commit as $(TAG)"

check-version: check-version-$(VERSION)

check-version-%:
	@git rev-parse --git-dir >/dev/null 2>&1
	@CURRENT_TAG="v$*"; \
	CURRENT_TAG_COMMIT="$$(git rev-list -n 1 "$$CURRENT_TAG" 2>/dev/null || true)"; \
	HEAD_COMMIT="$$(git rev-parse HEAD)"; \
	LATEST_TAG="$$(git tag --sort=-v:refname | head -n 1)"; \
	TAG_VERSION="$${LATEST_TAG#v}"; \
	LATEST_VSIX_VERSION="$$(find . -maxdepth 1 -type f -name 'make-runner-pro-*.vsix' -print | sed -E 's|^\./make-runner-pro-([0-9]+\.[0-9]+\.[0-9]+)\.vsix$$|\1|' | sort -V | tail -n 1)"; \
	LATEST_VERSION="$$(printf '%s\n%s\n' "$$TAG_VERSION" "$$LATEST_VSIX_VERSION" | awk 'NF' | sort -V | tail -n 1)"; \
	if [ "$(FORCE)" = "1" ]; then \
		echo "FORCE=1 set; skipping version gate (requested version: $*)"; \
	elif [ -n "$$CURRENT_TAG_COMMIT" ] && [ "$$CURRENT_TAG_COMMIT" = "$$HEAD_COMMIT" ]; then \
		echo "Current HEAD is already tagged as $$CURRENT_TAG; allowing retry for $*"; \
	elif [ -z "$$LATEST_VERSION" ]; then \
		echo "No existing tags or local VSIX builds found; version gate passed for $*"; \
	else \
		HIGHEST="$$(printf '%s\n%s\n' "$*" "$$LATEST_VERSION" | sort -V | tail -n 1)"; \
		if [ "$*" = "$$LATEST_VERSION" ] || [ "$$HIGHEST" != "$*" ]; then \
			echo "Version gate failed: package.json version ($*) must be greater than latest known release version ($$LATEST_VERSION)."; \
			echo "Use FORCE=1 to override for a forced rebuild."; \
			exit 1; \
		fi; \
		echo "Version gate passed: $* > $$LATEST_VERSION"; \
	fi

ensure-version:
	@git rev-parse --git-dir >/dev/null 2>&1
	@CURRENT_VERSION="$$(node -p 'require("./package.json").version')"; \
	CURRENT_TAG="v$$CURRENT_VERSION"; \
	CURRENT_TAG_COMMIT="$$(git rev-list -n 1 "$$CURRENT_TAG" 2>/dev/null || true)"; \
	HEAD_COMMIT="$$(git rev-parse HEAD)"; \
	LATEST_TAG="$$(git tag --sort=-v:refname | head -n 1)"; \
	TAG_VERSION="$${LATEST_TAG#v}"; \
	LATEST_VSIX_VERSION="$$(find . -maxdepth 1 -type f -name 'make-runner-pro-*.vsix' -print | sed -E 's|^\./make-runner-pro-([0-9]+\.[0-9]+\.[0-9]+)\.vsix$$|\1|' | sort -V | tail -n 1)"; \
	LATEST_VERSION="$$(printf '%s\n%s\n' "$$TAG_VERSION" "$$LATEST_VSIX_VERSION" | awk 'NF' | sort -V | tail -n 1)"; \
	if [ "$(FORCE)" = "1" ]; then \
		echo "FORCE=1 set; skipping version gate (current version: $$CURRENT_VERSION)"; \
	elif [ -n "$$CURRENT_TAG_COMMIT" ] && [ "$$CURRENT_TAG_COMMIT" = "$$HEAD_COMMIT" ]; then \
		echo "Current HEAD is already tagged as $$CURRENT_TAG; allowing retry for $$CURRENT_VERSION"; \
	elif [ -z "$$LATEST_VERSION" ]; then \
		echo "No existing tags or local VSIX builds found; version gate passed for $$CURRENT_VERSION"; \
	else \
		HIGHEST="$$(printf '%s\n%s\n' "$$CURRENT_VERSION" "$$LATEST_VERSION" | sort -V | tail -n 1)"; \
		if [ "$$CURRENT_VERSION" = "$$LATEST_VERSION" ] || [ "$$HIGHEST" != "$$CURRENT_VERSION" ]; then \
			NEXT_VERSION="$$(LATEST_VERSION="$$LATEST_VERSION" node -e 'const p=(process.env.LATEST_VERSION||"").split(".").map(Number); if (p.length < 3 || p.some(Number.isNaN)) { process.exit(1); } p[2] += 1; process.stdout.write(p.join("."));')"; \
			if [ "$(YES)" = "1" ]; then \
				CONFIRM="Y"; \
			elif [ ! -t 0 ]; then \
				echo "Version gate failed: package.json version ($$CURRENT_VERSION) is not greater than latest known release version ($$LATEST_VERSION)."; \
				echo "Run in an interactive shell, pass YES=1 to auto-accept, bump manually, or use FORCE=1."; \
				exit 1; \
			else \
				printf "package.json version ($$CURRENT_VERSION) is not greater than $$LATEST_VERSION. Bump to $$NEXT_VERSION? [Y/n]: "; \
				read -r CONFIRM; \
			fi; \
			if [ -z "$$CONFIRM" ] || [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ]; then \
				npm version "$$NEXT_VERSION" --no-git-tag-version >/dev/null; \
				echo "Updated package.json/package-lock.json to $$NEXT_VERSION"; \
			else \
				echo "Version bump declined. Aborting release."; \
				exit 1; \
			fi; \
		else \
			echo "Version gate passed: $$CURRENT_VERSION > $$LATEST_VERSION"; \
		fi; \
	fi

prepare-release: prepare-release-$(VERSION)

prepare-release-%: check-version-%
	@git rev-parse --git-dir >/dev/null 2>&1
	@if [ -n "$$(git status --porcelain)" ]; then \
		DEFAULT_MSG="$*"; \
		INPUT_MSG=""; \
		if [ "$(YES)" = "1" ]; then \
			INPUT_MSG="$$DEFAULT_MSG"; \
		elif [ -t 0 ]; then \
			printf "Working tree is dirty. Commit message [$$DEFAULT_MSG]: "; \
			read -r INPUT_MSG; \
		fi; \
		COMMIT_MSG="$${INPUT_MSG:-$$DEFAULT_MSG}"; \
		git add -A; \
		git restore --staged .vscode/*.code-workspace >/dev/null 2>&1 || true; \
		if [ -n "$$(git diff --cached --name-only)" ]; then \
			git commit -m "$$COMMIT_MSG"; \
			echo "Committed changes with message: $$COMMIT_MSG"; \
		else \
			echo "No releasable changes staged after filtering local workspace files."; \
		fi; \
	else \
		echo "Working tree is clean."; \
	fi; \
	git tag -f "v$*" HEAD; \
	echo "Tagged current commit as v$*"

cursor-install: ensure-version
	@CURRENT_VERSION="$$(node -p 'require("./package.json").version')"; \
	$(MAKE) cursor-install-$$CURRENT_VERSION FORCE=$(FORCE) YES=$(YES)

cursor-install-%: prepare-release-%
	@$(MAKE) make-runner-pro-$*.vsix YES=$(YES) FORCE=$(FORCE)
	@VSIX_FILE="make-runner-pro-$*.vsix"; \
	EXPECTED_VERSION="$*"; \
	$(CURSOR) --uninstall-extension "$(EXTENSION_ID)" >/dev/null 2>&1 || true; \
	$(CURSOR) --install-extension "$$VSIX_FILE" --force; \
	INSTALLED_VERSION="$$( $(CURSOR) --list-extensions --show-versions | awk -F@ '/^$(EXTENSION_ID)@/{print $$2; exit}' )"; \
	if [ "$$INSTALLED_VERSION" != "$$EXPECTED_VERSION" ]; then \
		echo "Install verification failed: expected $(EXTENSION_ID)@$$EXPECTED_VERSION, got $(EXTENSION_ID)@$$INSTALLED_VERSION"; \
		exit 1; \
	fi; \
	echo "Reinstalled $(EXTENSION_ID)@$$EXPECTED_VERSION from $$VSIX_FILE into Cursor"; \
	echo "Reload Cursor window to activate the new extension process."

clean:
	rm -rf out
	rm -f ./*.vsix
