#!/usr/bin/env bash
# Pre-release gate for arunika-landing. Spec and severity policy:
# arunika_app/openspec/changes/add-prerelease-security-gate
#
# Usage: scripts/prerelease_check.sh [--allow-missing] [--skip-dast] [--write-baselines]
#   --allow-missing    a missing tool is a warning instead of a failure
#   --skip-dast        skip the OWASP ZAP baseline scan
#   --write-baselines  re-record lighthouse-baseline.json after an intentional change
#
# The site is served from a stock nginx container. Response headers in
# production come from the hosting provider, so ZAP header findings here are
# "verify on host", not blockers — re-run against the real URL once deployed.
set -uo pipefail
cd "$(dirname "$0")/.."

REPORT_DIR=prerelease-reports
LH_BASELINE=lighthouse-baseline.json
ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:stable
PORT="${LANDING_PORT:-3098}"
ALLOW_MISSING=false SKIP_DAST=false WRITE_BASELINES=false
for arg in "$@"; do
  case "$arg" in
    --allow-missing) ALLOW_MISSING=true ;;
    --skip-dast) SKIP_DAST=true ;;
    --write-baselines) WRITE_BASELINES=true ;;
    *) echo "unknown option: $arg"; sed -n 5,8p "$0"; exit 2 ;;
  esac
done
mkdir -p "$REPORT_DIR"

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
FAILED=() SKIPPED=()
section() { echo -e "\n${YELLOW}==> $1${NC}"; }
ok()      { echo -e "${GREEN}  ✓ $1${NC}"; }
fail()    { echo -e "${RED}  ✗ $1${NC}"; FAILED+=("$1"); }
skip()    { echo -e "  - skipped: $1"; SKIPPED+=("$1"); }

# need TOOL INSTALL_HINT — succeeds when TOOL is on PATH. A missing tool fails
# the gate unless --allow-missing, so an unscanned repo never looks clean.
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  if $ALLOW_MISSING; then skip "$1 not installed ($2)"; else fail "$1 not installed — $2"; fi
  return 1
}

# check NAME REPORT CMD... — runs CMD with output to REPORT; pass/fail on exit code.
check() {
  local name="$1" report="$REPORT_DIR/$2"; shift 2
  if "$@" >"$report" 2>&1; then ok "$name"; else fail "$name — see $report"; fi
}

section "Secrets"
if need gitleaks "brew install gitleaks"; then
  check "gitleaks: git history" gitleaks-history.txt \
    gitleaks git --no-banner --redact --report-path "$REPORT_DIR/gitleaks-history.json" .
  # History covers committed files; this covers edits and new files not yet committed.
  changed=$(git ls-files -mo --exclude-standard | grep -v "^$REPORT_DIR/")
  if [ -n "$changed" ]; then
    leaks=0
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      gitleaks dir --no-banner --redact "$f" >>"$REPORT_DIR/gitleaks-worktree.txt" 2>&1 || leaks=1
    done <<<"$changed"
    if [ "$leaks" = 0 ]; then ok "gitleaks: uncommitted changes"
    else fail "gitleaks: uncommitted changes — see $REPORT_DIR/gitleaks-worktree.txt"; fi
  else
    ok "gitleaks: uncommitted changes (none)"
  fi
fi

if ! need docker "https://docs.docker.com/get-docker/"; then
  skip "ZAP and Lighthouse: no server to scan without Docker"
else
  net=arunika-landing-prerelease-$$
  site=$net-site
  docker network create "$net" >/dev/null
  docker run -d --rm --name "$site" --network "$net" -p "$PORT:80" \
    -v "$PWD:/usr/share/nginx/html:ro" nginx:1.27-alpine >/dev/null
  for _ in $(seq 1 20); do curl -fs -o /dev/null "http://localhost:$PORT/" && break; sleep 0.5; done

  section "DAST: OWASP ZAP baseline"
  if $SKIP_DAST; then
    skip "ZAP baseline (--skip-dast)"
  else
    # zap-baseline exit codes: 0 clean, 1 FAIL alerts, 2 WARN alerts only, 3 error.
    docker run --rm --network "$net" -v "$PWD/$REPORT_DIR:/zap/wrk:rw" "$ZAP_IMAGE" \
      zap-baseline.py -t "http://$site" -r zap-report.html -J zap-report.json \
      >"$REPORT_DIR/zap.txt" 2>&1
    case $? in
      0) ok "ZAP baseline: no alerts" ;;
      # Alert lines end in "[rule id] x count"; the summary line doesn't.
      1|2) warns=$(grep -cE "^WARN-NEW: .*\[[0-9]+\]" "$REPORT_DIR/zap.txt")
           fails=$(grep -cE "^FAIL-NEW: .*\[[0-9]+\]" "$REPORT_DIR/zap.txt")
           if [ "$fails" -gt 0 ]; then fail "ZAP baseline: $fails failing alerts — see $REPORT_DIR/zap-report.html"
           else ok "ZAP baseline: $warns warnings to triage (headers: verify on host) — see $REPORT_DIR/zap-report.html"; fi ;;
      *) fail "ZAP baseline did not complete — see $REPORT_DIR/zap.txt" ;;
    esac
  fi

  section "Performance: Lighthouse"
  if need npx "install Node.js"; then
    if npx --yes lighthouse "http://localhost:$PORT/" --quiet --only-categories=performance \
      --output=json --output-path="$REPORT_DIR/lighthouse.json" \
      --chrome-flags="--headless=new" >"$REPORT_DIR/lighthouse.txt" 2>&1; then
      score=$(python3 -c "import json;print(round(json.load(open('$REPORT_DIR/lighthouse.json'))['categories']['performance']['score']*100))")
      if $WRITE_BASELINES || [ ! -f "$LH_BASELINE" ]; then
        echo "{ \"performance\": $score }" >"$LH_BASELINE"
        ok "Lighthouse performance $score: baseline recorded"
      else
        base=$(grep -oE '[0-9]+' "$LH_BASELINE")
        if [ "$score" -ge $((base - 10)) ]; then ok "Lighthouse performance $score (baseline $base)"
        else fail "Lighthouse performance dropped >10 points: $score vs baseline $base"; fi
      fi
    else
      fail "Lighthouse did not complete — see $REPORT_DIR/lighthouse.txt"
    fi
  fi

  docker rm -f "$site" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
fi

section "Summary"
echo "Failures: ${#FAILED[@]}   Skipped: ${#SKIPPED[@]}   Reports: $REPORT_DIR/"
for f in ${FAILED[@]+"${FAILED[@]}"}; do echo -e "  ${RED}✗${NC} $f"; done
for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do echo "  - $s"; done
echo "Triage every finding in arunika_app/docs/prerelease-triage.md before release."
[ "${#FAILED[@]}" -eq 0 ]
