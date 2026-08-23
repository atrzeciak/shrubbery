# Nasze Korzenie / Our Roots — a private family archive
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
REMOTE  := origin

# What a public copy would contain: everything except the working notes and this project's own list.
PUBLIC_PATHS := . ":(exclude)docs" ":(exclude)TODO.md"
BRANCH  := main

.PHONY: help install test verify check dev tail deploy-status version health migrate migrations backup release scrub-check

help:  ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies exactly as the CI does
	npm ci

test:  ## Run the test suite
	npx vitest run

verify:  ## Run the repository checks (self-containment, i18n parity, no stray secrets)
	scripts/verify.sh

check: verify test  ## Everything CI runs, in the same order

dev:  ## Run the Worker locally
	npx wrangler dev

tail:  ## Follow the live Worker's logs
	npx wrangler tail

version:  ## Print the version stamp the live site is serving
	@curl -fsS $(SITE)/app/version.json && echo

health:  ## Print the live health endpoint
	@curl -fsS $(SITE)/api/health && echo

migrations:  ## List D1 migrations and whether they have been applied remotely
	npx wrangler d1 migrations list $(DB) --remote

migrate:  ## Apply pending D1 migrations to the live database (CI does this on deploy)
	npx wrangler d1 migrations apply $(DB) --remote

deploy-status:  ## Show the most recent deploy runs
	gh run list --workflow=Deploy --limit 5

# The archive is what outlives the author; taking one by hand should be one word.
backup:  ## Download a backup ZIP (needs an admin session cookie in $$COOKIE)
	@test -n "$${COOKIE:-}" || { echo "set COOKIE to an admin session cookie: make backup COOKIE=...=..."; exit 1; }
	curl -fsS --cookie "$$COOKIE" -o "backup-$$(date -u +%Y-%m-%d).zip" $(SITE)/api/admin/backup
	@ls -lh backup-*.zip | tail -1

# Publishing is irreversible, so the scrub is a target rather than a checklist somebody remembers.
scrub-check:  ## Look for real names and addresses in what would actually be published
	@echo "== files that would be published =="
	@git ls-files $(PUBLIC_PATHS) | wc -l | xargs printf '  %s files\n'
	@echo "== real e-mail addresses =="
	@git grep -nI -E "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|pl|eu|org|net)" -- $(PUBLIC_PATHS) \
		| grep -viE "@([a-z0-9.-]+\.)?(x\.org|example\.(org|com|net))" || echo "  none"
	@echo "== names from .scrub-names (git-ignored) =="
	@test -s .scrub-names && (git grep -nI -f .scrub-names -- $(PUBLIC_PATHS) ":(exclude)LICENSE" || echo "  none (LICENSE names the copyright holder on purpose)") \
		|| echo "  no .scrub-names file: put the surnames to look for in it, one per line"
	@echo "== files that must never be tracked =="
	@git ls-files | grep -E "^(docs/|TODO\.md|scripts/out/)|\.dev\.vars|^wrangler\.toml$$" \
		| sed 's/^/  excluded from public: /' || true
	@echo "== licence present =="
	@test -f LICENSE && echo "  LICENSE" || echo "  MISSING"

release: check  ## Run the checks, then push main so Actions deploys it
	@test -z "$$(git status --porcelain)" || { echo "working tree is dirty; commit first"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "$(BRANCH)" || { echo "not on $(BRANCH)"; exit 1; }
	git push $(REMOTE) $(BRANCH)
	@echo "pushed; watch it with: make deploy-status"
