# Our Roots / Nasze Korzenie — a private family archive
#
# The live site deploys from GitHub Actions on every push to main, so `make release` pushes rather
# than deploying by hand: one path to production, and it runs the checks first.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Read from your own wrangler.toml, which is git-ignored: this file names no site.
DB      := $(shell sed -n 's/^database_name *= *"\(.*\)"/\1/p' wrangler.toml 2>/dev/null)
BUCKET  := $(shell sed -n 's/^bucket_name *= *"\(.*\)"/\1/p' wrangler.toml 2>/dev/null)
SITE    := $(shell sed -n 's/^APP_ORIGIN *= *"\(.*\)"/\1/p' wrangler.toml 2>/dev/null)
# The remote and the branch it calls default, detected rather than assumed: a clone whose remote is
# not called origin still releases. Override either on the command line.
REMOTE  ?= $(shell git remote | grep -qx origin && echo origin || git remote | head -1)
BRANCH  ?= $(shell git symbolic-ref --quiet --short refs/remotes/$(REMOTE)/HEAD | cut -d/ -f2-)

# Where a copy of the git-ignored config is kept, so a lost working tree does not take the only one
# with it. Named after this directory, so a second checkout does not overwrite the first one's copy.
CONFIG_STORE ?= $(HOME)/.secrets/$(notdir $(CURDIR))

# What a public copy would contain: everything except the working notes and this project's own list.
PUBLIC_PATHS := . ":(exclude)docs" ":(exclude)TODO.md"

.PHONY: help
help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install:  ## Install dependencies exactly as the CI does
	npm ci

.PHONY: test
test:  ## Run the test suite
	npx vitest run

# Correctness only, no formatting rules: the formatting here is deliberate in places, and a tool
# that rewrote it would bury the next real change in noise.
.PHONY: lint
lint:  ## Lint for correctness (unused names, undefined names, unreachable code)
	npx eslint .

.PHONY: verify
verify:  ## Run the repository checks (self-containment, i18n parity, no stray secrets)
	scripts/verify.sh

.PHONY: check
check: verify lint test  ## Everything CI runs, in the same order

.PHONY: dev
dev:  ## Run the Worker locally
	npx wrangler dev

.PHONY: tail
tail:  ## Follow the live Worker's logs
	npx wrangler tail

.PHONY: version
version:  ## Print the version stamp the live site is serving
	@curl -fsS $(SITE)/app/version.json && echo

.PHONY: health
health:  ## Print the live health endpoint
	@curl -fsS $(SITE)/api/health && echo

.PHONY: migrations
migrations:  ## List D1 migrations and whether they have been applied remotely
	npx wrangler d1 migrations list $(DB) --remote

.PHONY: migrate
migrate:  ## Apply pending D1 migrations to the live database (CI does this on deploy)
	npx wrangler d1 migrations apply $(DB) --remote

.PHONY: deploy-status
deploy-status:  ## Show the most recent deploy runs
	gh run list --workflow=Deploy --limit 5

# The archive is what outlives the author; taking one by hand should be one word.
.PHONY: backup
backup:  ## Download a backup ZIP (needs an admin session cookie in $$COOKIE)
	@test -n "$${COOKIE:-}" || { echo "set COOKIE to an admin session cookie: make backup COOKIE=...=..."; exit 1; }
	curl -fsS --cookie "$$COOKIE" -o "backup-$$(date -u +%Y-%m-%d).zip" $(SITE)/api/admin/backup
	@ls -lh backup-*.zip | tail -1

# Publishing is irreversible, so the scrub is a target rather than a checklist somebody remembers.
.PHONY: scrub-check
scrub-check:  ## Look for real names and addresses in what would actually be published
	@echo "== files that would be published =="
	@git ls-files $(PUBLIC_PATHS) | wc -l | xargs printf '  %s files\n'
	@echo "== real e-mail addresses =="
	@git grep -nI -E "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|pl|eu|org|net)" -- $(PUBLIC_PATHS) \
		| grep -viE "@([a-z0-9.-]+\.)?(x\.org|example\.(org|com|net))" || echo "  none"
	@echo "== names from .scrub-names (git-ignored) =="
	@test -s .scrub-names && (git grep -nI -f .scrub-names -- $(PUBLIC_PATHS) ":(exclude)LICENSE" \
		| grep -v "github\.com/[^/]*/[^/ )\"]*" || echo "  none (LICENSE names the copyright holder, and the repository's own URL names the account)") \
		|| echo "  no .scrub-names file: put the surnames to look for in it, one per line"
	@echo "== files that must never be tracked =="
	@git ls-files | grep -E "^(docs/|TODO\.md|scripts/out/)|\.dev\.vars|^wrangler\.toml$$" \
		| sed 's/^/  excluded from public: /' || true
	@echo "== licence present =="
	@test -f LICENSE && echo "  LICENSE" || echo "  MISSING"

# A release is a tag, so the About card, `make version` and whoever reads a backup years from now
# all name the same point in history. CalVer, because a family archive publishes no API and so a
# version number says nothing a date does not. Annotated, so one push carries the tag with the commit.
.PHONY: release
release: check save-config  ## Run the checks, tag the commit, then push so Actions deploys it
	@test -n "$(REMOTE)" || { echo "no git remote configured"; exit 1; }
	@test -n "$(BRANCH)" || { echo "cannot tell $(REMOTE)'s default branch; run: git remote set-head $(REMOTE) --auto"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "working tree is dirty; commit first"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "$(BRANCH)" || { echo "not on $(BRANCH)"; exit 1; }
	@existing="$$(git tag --points-at HEAD)"; test -z "$$existing" \
		|| { echo "HEAD is already released as $$existing; push it with: git push $(REMOTE) $(BRANCH) --follow-tags"; exit 1; }
	@base="v$$(date -u +%Y.%m.%d)"; tag="$$base"; n=1; \
	while git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; do tag="$$base.$$n"; n=$$((n+1)); done; \
	git tag -a "$$tag" -m "Release $$tag"; \
	echo "  tagged $$tag"
	git push $(REMOTE) $(BRANCH) --follow-tags
	@echo "pushed; watch it with: make deploy-status"

# The config is git-ignored and names the site, so it exists in exactly one place unless something
# copies it. Releasing is the moment worth copying at: the tree is clean and the config is one that
# actually deployed. Old versions are kept because the mistake you want to undo is an edit, not a loss.
.PHONY: save-config
save-config:  ## Copy wrangler.toml to the config store, keeping the last 5 versions
	@if [ ! -f wrangler.toml ]; then echo "  no wrangler.toml here; nothing to save"; exit 0; fi; \
	mkdir -p "$(CONFIG_STORE)/versions"; \
	if cmp -s wrangler.toml "$(CONFIG_STORE)/wrangler.toml"; then \
		echo "  unchanged: $(CONFIG_STORE)/wrangler.toml"; \
	else \
		cp wrangler.toml "$(CONFIG_STORE)/versions/wrangler.toml.$$(date -u +%Y%m%dT%H%M%SZ)"; \
		cp wrangler.toml "$(CONFIG_STORE)/wrangler.toml"; \
		echo "  saved: $(CONFIG_STORE)/wrangler.toml"; \
	fi; \
	( cd "$(CONFIG_STORE)/versions" && ls -1 | sort -r | tail -n +6 | while read -r old; do rm -- "$$old"; done ); \
	chmod 700 "$(CONFIG_STORE)" "$(CONFIG_STORE)/versions"; \
	chmod 600 "$(CONFIG_STORE)/wrangler.toml" "$(CONFIG_STORE)"/versions/* 2>/dev/null || true
