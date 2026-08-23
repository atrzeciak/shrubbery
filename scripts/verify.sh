#!/usr/bin/env bash
# Asserts the durability and privacy rules for the served files in public/.
# Exit 0 when all hold; prints FAIL: lines and exits 1 otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly PUBLIC=public
readonly PAGES=("$PUBLIC/index.html" "$PUBLIC/en/index.html")
readonly REQUIRED=(
  "$PUBLIC/index.html"
  "$PUBLIC/en/index.html"
  "$PUBLIC/style.css"
  "$PUBLIC/robots.txt"
  "$PUBLIC/404.html"
  "$PUBLIC/_headers"
  "$PUBLIC/app/index.html"
  "$PUBLIC/app/app.css"
  "$PUBLIC/app/app.js"
  "$PUBLIC/app/api.js"
  "$PUBLIC/app/i18n.js"
  "$PUBLIC/app/dom.js"
  "$PUBLIC/app/crop.js"
  "$PUBLIC/app/i18n/pl.json"
  "$PUBLIC/app/i18n/en.json"
  "$PUBLIC/app/views/login.js"
  "$PUBLIC/app/views/join.js"
  "$PUBLIC/app/views/news.js"
  "$PUBLIC/app/views/account.js"
  "$PUBLIC/app/views/admin.js"
  "$PUBLIC/app/graph.js"
  "$PUBLIC/app/tree-layout.js"
  "$PUBLIC/app/people.js"
  "$PUBLIC/app/sheet.js"
  "$PUBLIC/app/person-card.js"
  "$PUBLIC/app/person-editor.js"
  "$PUBLIC/app/views/members.js"
  "$PUBLIC/app/person-form.js"
  "$PUBLIC/app/views/me.js"
  "$PUBLIC/app/views/tree.js"
  "$PUBLIC/app/views/gathering.js"
  "$PUBLIC/app/events.js"
  "$PUBLIC/app/media-gallery.js"
  "$PUBLIC/app/viewer.js"
)
failures=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

check_required_files() {
  local f
  for f in "${REQUIRED[@]}"; do
    [[ -f "$f" ]] || fail "missing $f"
  done
}

check_no_runtime_deps() {
  if [[ -f package.json ]]; then
    grep -q '"dependencies"' package.json && fail "package.json declares runtime dependencies"
  fi
  [[ -e "$PUBLIC/node_modules" ]] && fail "node_modules inside $PUBLIC"
  return 0
}

check_relative_imports() {
  # Served modules may import only relative paths — no bare specifiers, no URLs.
  local bad
  bad=$(grep -rhoE "(^|[^a-zA-Z_])import[^;]*from[[:space:]]*['\"][^'\"]+['\"]|import\(['\"][^'\"]+['\"]\)" \
        --include='*.js' "$PUBLIC" 2>/dev/null | grep -vE "['\"]\.\.?/" || true)
  [[ -z "$bad" ]] || { printf '%s\n' "$bad" >&2; fail "non-relative import in served JS"; }
}

check_no_external_requests() {
  # Any absolute URL or protocol-relative URL in served HTML/CSS/JS is a third-party request.
  # The SVG namespace URI is a fixed XML identifier, never fetched — exempt it.
  local hits
  hits=$(grep -rEn --include='*.html' --include='*.css' --include='*.js' --include='*.json' \
      'https?://|url\([^#]|@import|//[a-z0-9-]+\.[a-z]{2,}' "$PUBLIC" 2>/dev/null \
      | grep -v 'http://www.w3.org/2000/svg' || true)
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits" >&2
    fail "external reference in served files"
  fi
}

check_landing_pages() {
  local p
  for p in "${PAGES[@]}"; do
    [[ -f "$p" ]] || continue
    grep -qi '<script' "$p" && fail "$p contains a script"
    grep -qi '<form' "$p" && fail "$p contains a form"
    grep -qi 'mailto:' "$p" && fail "$p contains an email link"
    grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$p" && fail "$p contains an email address"
    grep -qi '<img' "$p" && fail "$p contains an image"
    grep -q 'name="viewport" content="width=device-width, initial-scale=1"' "$p" || fail "$p lacks viewport meta"
    grep -q 'name="robots" content="noindex, nofollow"' "$p" || fail "$p lacks noindex meta"
    grep -qE 'href="/app/(\?lang=(pl|en))?"' "$p" || fail "$p lacks the /app/ link"
  done
  [[ -f "$PUBLIC/index.html" ]] && { grep -q '<html lang="pl">' "$PUBLIC/index.html" || fail "index.html is not lang=pl"; }
  [[ -f "$PUBLIC/index.html" ]] && { grep -q 'href="/en/"' "$PUBLIC/index.html" || fail "index.html lacks link to /en/"; }
  [[ -f "$PUBLIC/en/index.html" ]] && { grep -q '<html lang="en">' "$PUBLIC/en/index.html" || fail "en/index.html is not lang=en"; }
  [[ -f "$PUBLIC/en/index.html" ]] && { grep -q 'href="/"' "$PUBLIC/en/index.html" || fail "en/index.html lacks link to /"; }
  return 0
}

check_robots() {
  [[ -f "$PUBLIC/robots.txt" ]] || return 0
  grep -q '^User-agent: \*$' "$PUBLIC/robots.txt" || fail "robots.txt lacks 'User-agent: *'"
  grep -q '^Disallow: /$' "$PUBLIC/robots.txt" || fail "robots.txt lacks 'Disallow: /'"
}

check_valid_html() {
  local h status
  # macOS ships HTML Tidy from 2006, which rejects HTML5. Require the 5.x line.
  # Without it, skip locally with a warning; CI sets VERIFY_STRICT=1 and fails instead.
  if ! command -v tidy >/dev/null || ! tidy -v | grep -qE 'version 5\.'; then
    if [[ "${VERIFY_STRICT:-0}" == 1 ]]; then
      fail "HTML Tidy 5.x required (brew install tidy-html5 / apt-get install tidy)"
    else
      printf 'WARN: HTML Tidy 5.x not found; HTML validation skipped (brew install tidy-html5)\n' >&2
    fi
    return 0
  fi
  for h in "${PAGES[@]}" "$PUBLIC/404.html" "$PUBLIC/app/index.html"; do
    [[ -f "$h" ]] || continue
    status=0
    tidy -q -e "$h" >/dev/null 2>&1 || status=$?
    # tidy: 0 = clean, 1 = warnings only, 2 = errors
    [[ "$status" -lt 2 ]] || fail "$h has HTML errors (tidy -e $h)"
  done
}

main() {
  check_required_files
  check_no_runtime_deps
  check_relative_imports
  check_no_external_requests
  check_landing_pages
  check_robots
  check_valid_html
  if [[ "$failures" -gt 0 ]]; then
    printf '%d check(s) failed\n' "$failures" >&2
    exit 1
  fi
  printf 'verify: all checks passed\n'
}

main "$@"
