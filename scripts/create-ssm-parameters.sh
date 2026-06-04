#!/usr/bin/env bash
#
# Syncs AWS SSM Parameter Store from the `provider.environment` block of a
# local source serverless.yml, then rewrites the committed root serverless.yml
# so each externalized variable points at its SSM parameter.
#
# Why this exists:
#   The committed root serverless.yml used to carry plaintext defaults
#   (Mongo URI, JWT secret, …) right inside `provider.environment`. This script
#   moves those values into SSM and leaves the committed file referencing them
#   via Serverless' native `${ssm:...}` resolver — so secrets stop living in git.
#
# How the Lambda keeps working (no code / no IAM change):
#   `${ssm:/path}` is resolved by the Serverless Framework AT DEPLOY TIME
#   (v3 auto-decrypts SecureString). The fetched value is baked into the
#   Lambda's plain environment variables in CloudFormation, exactly like the
#   hardcoded defaults were before. The function code keeps reading
#   `process.env.X` (see src/env.ts) and the Lambda execution role needs NO
#   ssm:* permission at runtime — the deployer's credentials do the read.
#   (The current role in serverless.yml has only DynamoDB + execute-api, and
#   that stays correct.)
#
# Rewrite shape (override chain is preserved on purpose):
#   Before:  MONGODB_URI: ${env:MONGODB_URI, "mongodb+srv://..."}
#   After:   MONGODB_URI: ${env:MONGODB_URI, ssm:/drinkbuy/wss-lambda/dev/MONGODB_URI}
#   The leading ${env:NAME, ...} is kept so an exported env var still wins
#   (deploy-dev.sh exports a few of these); SSM is the fallback when it isn't.
#   NOTE the v3 chain syntax: comma-separated sources inside ONE ${...} —
#   the fallback "ssm:" has NO braces of its own. The doubly-wrapped form
#   ${env:X, ${ssm:Y}} is rejected by the v3 resolver ("Invalid variable source").
#
# What gets externalized vs left alone (per variable in provider.environment):
#   - `${env:NAME, "literal"}`        -> push "literal" to SSM, rewrite to use ${ssm}.
#   - `${env:NAME, "base/${sls:stage}"}` -> push only the static base to SSM,
#                                        rewrite to "${ssm:.../KEY}/${sls:stage}"
#                                        (e.g. WEBSOCKET_API_ENDPOINT).
#   - bare literal (no ${...})        -> push value to SSM, rewrite to ${env:KEY, ssm:...}.
#   - empty value                     -> left untouched (e.g. DDB_LOCAL_ENDPOINT).
#   - bare value with ${...}          -> left untouched (CONNECTIONS_TABLE, WEBSOCKET_STAGE).
#
# Source-of-truth file (--file, default scripts/serverless-<stage>.yml) holds the
# decrypted values and is gitignored. The root file (--root, default
# serverless.yml) is committed and only its `provider.environment` value lines
# are rewritten — comments, blank lines and the rest of the file are preserved
# byte-for-byte.
#
# Usage:
#   ./scripts/create-ssm-parameters.sh [--stage dev|prod] \
#     [--file scripts/serverless-<stage>.yml] [--root serverless.yml] \
#     [--prefix /drinkbuy/wss-lambda/<stage>] [--region us-east-1] \
#     [--dry-run] [--diff] [--reset]
#
# Flags:
#   --stage <stage>   Stage that drives the defaults for --file and --prefix
#                     (default: dev). Pass `prod` to target the prod source +
#                     prefix in one go.
#   --file <path>     Source serverless.yml read for `provider.environment`
#                     values (default: scripts/serverless-<stage>.yml).
#   --root <path>     Committed serverless.yml whose `provider.environment` is
#                     rewritten to ${ssm:...} references (default: serverless.yml).
#   --prefix <path>   SSM prefix (default: /drinkbuy/wss-lambda/<stage>).
#   --region <region> AWS region (default: us-east-1).
#   --dry-run         Skip every AWS write and root-yaml edit; print only.
#   --diff            Show per-name diff vs current SSM state.
#   --reset           Backup + delete every parameter under PREFIX before
#                     writing (writes ssm-backup-YYYYMMDD-HHMMSS.json locally).
#
# Requires: aws CLI, yq (mikefarah Go-based), jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Empty so we can tell apart "user passed --file/--prefix" from
# "fall back to the stage-derived default" once arg parsing is done.
STAGE="prod"
YAML_FILE=""
ROOT_YAML=""
PREFIX=""
REGION="us-east-1"
DRY_RUN=false
SHOW_DIFF=false
RESET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)    STAGE="$2"; shift 2 ;;
    --file)     YAML_FILE="$2"; shift 2 ;;
    --root)     ROOT_YAML="$2"; shift 2 ;;
    --prefix)   PREFIX="$2"; shift 2 ;;
    --region)   REGION="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --diff)     SHOW_DIFF=true; shift ;;
    --reset)    RESET=true; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Stage-derived defaults — explicit --file/--prefix/--root still win.
[[ -z "$YAML_FILE" ]] && YAML_FILE="$SCRIPT_DIR/serverless-${STAGE}.yml"
[[ -z "$ROOT_YAML" ]] && ROOT_YAML="$REPO_ROOT/serverless.yml"
[[ -z "$PREFIX"    ]] && PREFIX="/drinkbuy/wss-lambda/${STAGE}"

for bin in aws yq jq; do
  command -v "$bin" >/dev/null || {
    echo "Error: '$bin' not found in PATH." >&2; exit 1
  }
done

if [[ ! -f "$YAML_FILE" ]]; then
  echo "Error: source file '$YAML_FILE' not found." >&2
  echo "Tip: this file is gitignored and holds the decrypted values for stage" >&2
  echo "     '$STAGE'. Create it from the current serverless.yml before running" >&2
  echo "     (or pass --file <path> / --stage <stage> to point elsewhere)." >&2
  exit 1
fi

if [[ "$(cd "$(dirname "$YAML_FILE")" && pwd)/$(basename "$YAML_FILE")" == \
      "$(cd "$(dirname "$ROOT_YAML")" && pwd)/$(basename "$ROOT_YAML")" ]] 2>/dev/null; then
  echo "Error: --file and --root point at the same file. The source must keep" >&2
  echo "       the plaintext values; the root is rewritten to \${ssm:...} refs." >&2
  exit 1
fi

# A variable is stored as SecureString iff its name is listed here; otherwise
# String. Both resolve identically through ${ssm:...} at deploy time — the only
# difference is at-rest encryption in SSM.
SENSITIVE_PARAMS=(
  JWT_SECRET
  MONGODB_URI
  MONGODB_USER
  MONGODB_PASS
)

is_sensitive() {
  local n="$1"
  for s in "${SENSITIVE_PARAMS[@]}"; do
    [[ "$s" == "$n" ]] && return 0
  done
  return 1
}

strip_quotes() {
  local s="$1"
  [[ "$s" == '"'*'"' ]] && { s="${s#\"}"; s="${s%\"}"; }
  [[ "$s" == \'*\' ]] && { s="${s#\'}"; s="${s%\'}"; }
  printf '%s' "$s"
}

# Classify one provider.environment entry.
# Sets globals: CLS_STATUS (ext|ext-concat|skip-empty|skip-nodefault|skip-dynamic),
#               CLS_ENVNAME (env var that overrides SSM),
#               CLS_VALUE   (value stored in SSM),
#               CLS_TAIL    (dynamic suffix re-appended in the yaml, ext-concat only).
#
# ext-concat handles a ${env:NAME, "literal"} whose literal carries a trailing
# Serverless directive, e.g. "wss://host/${sls:stage}". We can't store ${sls:stage}
# in SSM (it would ship verbatim), so we store only the static base ("wss://host")
# and rebuild the value in the yaml as "${ssm:.../KEY}/${sls:stage}". Bare values
# with ${...} (no ${env:} wrapper, e.g. CONNECTIONS_TABLE) are still left as-is.
classify_var() {
  local key="$1" val="$2" envprefix='${env:'
  CLS_ENVNAME=""; CLS_VALUE=""; CLS_TAIL=""
  if [[ -z "$val" || "$val" == "null" ]]; then CLS_STATUS="skip-empty"; return; fi
  if [[ "$val" == "$envprefix"* ]]; then
    local inner="${val#"$envprefix"}"; inner="${inner%\}}"
    local name def
    if [[ "$inner" == *", "* ]]; then
      name="${inner%%, *}"; def="${inner#*, }"
    elif [[ "$inner" == *","* ]]; then
      name="${inner%%,*}"; def="${inner#*,}"; def="${def# }"
    else
      name="$inner"; def=""
    fi
    def="$(strip_quotes "$def")"
    CLS_ENVNAME="$name"
    if [[ -z "$def" ]]; then CLS_STATUS="skip-nodefault"; return; fi
    if [[ "$def" == *'${'* ]]; then
      # Split at the first ${...}: static base + dynamic tail.
      local static="${def%%'${'*}" tail
      tail="${def#"$static"}"
      if [[ -z "$static" ]]; then CLS_STATUS="skip-dynamic"; return; fi
      # Keep the path separator in the tail so the SSM base stays clean.
      if [[ "$static" == */ ]]; then static="${static%/}"; tail="/$tail"; fi
      CLS_STATUS="ext-concat"; CLS_VALUE="$static"; CLS_TAIL="$tail"; return
    fi
    CLS_STATUS="ext"; CLS_VALUE="$def"; return
  fi
  if [[ "$val" == *'${'* ]]; then CLS_STATUS="skip-dynamic"; return; fi
  CLS_STATUS="ext"; CLS_ENVNAME="$key"; CLS_VALUE="$(strip_quotes "$val")"
}

ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query Account --output text)
if [[ -z "$ACCOUNT_ID" || "$ACCOUNT_ID" == "None" ]]; then
  echo "Error: could not resolve AWS account id (check credentials)." >&2
  exit 1
fi

echo "Stage:        $STAGE"
echo "Source file:  $YAML_FILE"
echo "Root yaml:    $ROOT_YAML"
echo "Prefix:       $PREFIX"
echo "Region:       $REGION"
echo "Account:      $ACCOUNT_ID"
echo "Dry-run:      $DRY_RUN"
echo "Diff:         $SHOW_DIFF"
echo "Reset:        $RESET"
echo

# -- Parse provider.environment into a name->raw-value JSON map ---------------
SOURCE_JSON=$(yq -o=json '.provider.environment // {}' "$YAML_FILE")
NUM_SOURCE=$(jq 'length' <<< "$SOURCE_JSON")
if [[ "$NUM_SOURCE" -eq 0 ]]; then
  echo "Error: $YAML_FILE has no entries under provider.environment" >&2
  exit 1
fi
echo "provider.environment has $NUM_SOURCE variable(s)."

# -- Build the target layout -------------------------------------------------
# TARGETS_JSON = [{key, envName, value, type}, ...] for externalized vars only.
# SKIPPED_JSON = [{key, reason}, ...] for everything left untouched.
TARGETS_JSON='[]'
SKIPPED_JSON='[]'

while IFS= read -r key; do
  val=$(jq -r --arg k "$key" '.[$k] // ""' <<< "$SOURCE_JSON")
  classify_var "$key" "$val"
  if [[ "$CLS_STATUS" == "ext" || "$CLS_STATUS" == "ext-concat" ]]; then
    ssm_type="String"; is_sensitive "$key" && ssm_type="SecureString"
    TARGETS_JSON=$(jq \
      --arg k "$key" --arg e "$CLS_ENVNAME" --arg v "$CLS_VALUE" \
      --arg t "$ssm_type" --arg tail "$CLS_TAIL" \
      '. + [{key:$k, envName:$e, value:$v, type:$t, tail:$tail}]' <<< "$TARGETS_JSON")
  else
    SKIPPED_JSON=$(jq --arg k "$key" --arg r "$CLS_STATUS" \
      '. + [{key:$k, reason:$r}]' <<< "$SKIPPED_JSON")
  fi
done < <(jq -r 'keys_unsorted[]' <<< "$SOURCE_JSON")

NUM_TARGETS=$(jq 'length' <<< "$TARGETS_JSON")
NUM_SKIPPED=$(jq 'length' <<< "$SKIPPED_JSON")
NUM_SECURE=$(jq '[.[] | select(.type == "SecureString")] | length' <<< "$TARGETS_JSON")
NUM_PLAIN=$(jq '[.[] | select(.type == "String")] | length' <<< "$TARGETS_JSON")

echo "Externalizing: $NUM_TARGETS var(s) — $NUM_SECURE SecureString + $NUM_PLAIN String"
echo "Leaving as-is: $NUM_SKIPPED var(s)"
if [[ "$NUM_SKIPPED" -gt 0 ]]; then
  while IFS= read -r row; do
    k=$(jq -r '.key' <<< "$row"); r=$(jq -r '.reason' <<< "$row")
    echo "  . $k ($r)"
  done < <(jq -c '.[]' <<< "$SKIPPED_JSON")
fi
echo

# -- Read current SSM state --------------------------------------------------
echo "Reading current SSM state under $PREFIX/ ..."
CURRENT_JSON=$(aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "$PREFIX/" \
  --recursive \
  --with-decryption \
  --query 'Parameters[].{name: Name, value: Value, type: Type}' \
  --output json)
NUM_CURRENT=$(jq 'length' <<< "$CURRENT_JSON")
echo "Found $NUM_CURRENT existing parameter(s) in SSM."
echo

current_value() {
  jq -r --arg prefix "$PREFIX/" --arg k "$1" '
    map({(.name | sub("^" + $prefix; "")): .value}) | add // {} | .[$k] // ""
  ' <<< "$CURRENT_JSON"
}

# -- Optional reset (backup + wipe) ------------------------------------------
if [[ "$RESET" == true ]]; then
  BACKUP_FILE="ssm-backup-$(date +%Y%m%d-%H%M%S).json"
  echo "=== RESET: backing up to $BACKUP_FILE ==="
  echo "$CURRENT_JSON" > "$BACKUP_FILE"
  echo "  $NUM_CURRENT parameter(s) backed up."

  EXISTING_NAMES=$(jq -r '.[].name' <<< "$CURRENT_JSON")
  if [[ -n "$EXISTING_NAMES" ]]; then
    batch=()
    flush_batch() {
      [[ ${#batch[@]} -eq 0 ]] && return
      if [[ "$DRY_RUN" == true ]]; then
        echo "  [dry-run] delete-parameters batch (${#batch[@]})"
      else
        echo "  -> delete-parameters batch (${#batch[@]})"
        aws ssm delete-parameters --region "$REGION" --names "${batch[@]}" >/dev/null
      fi
      batch=()
    }
    while IFS= read -r n; do
      batch+=("$n")
      [[ ${#batch[@]} -ge 10 ]] && flush_batch
    done <<< "$EXISTING_NAMES"
    flush_batch
  fi
  CURRENT_JSON='[]'
  echo
fi

# -- Write each target to SSM -------------------------------------------------
echo "=== Writing parameters to SSM ==="
while IFS= read -r row; do
  key=$(jq -r '.key' <<< "$row")
  value=$(jq -r '.value' <<< "$row")
  ssm_type=$(jq -r '.type' <<< "$row")
  full="${PREFIX}/${key}"
  prev=$(current_value "$key")

  change="changed"
  if [[ "$prev" == "$value" ]]; then change="same"
  elif [[ -z "$prev" ]]; then change="new"
  fi

  if [[ "$SHOW_DIFF" == true ]]; then
    case "$change" in
      same)    echo "  = $key ($ssm_type)" ;;
      new)     echo "  + $key ($ssm_type, new)" ;;
      changed) echo "  ~ $key ($ssm_type, value changed)" ;;
    esac
  fi

  if [[ "$change" == "same" && "$RESET" != true ]]; then continue; fi

  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] put $full ($ssm_type)"
  else
    echo "  -> put $full ($ssm_type)"
    aws ssm put-parameter \
      --region "$REGION" \
      --name "$full" \
      --type "$ssm_type" \
      --value "$value" \
      --overwrite >/dev/null
  fi
done < <(jq -c '.[]' <<< "$TARGETS_JSON")
echo

# -- Remove stale params (under prefix but no longer externalized) ------------
TARGET_NAMES=$(jq -r '.[].key' <<< "$TARGETS_JSON" | sort -u)
CURRENT_NAMES=$(jq -r --arg prefix "$PREFIX/" '.[].name | sub("^" + $prefix; "")' <<< "$CURRENT_JSON" | sort -u)
STALE_NAMES=$(comm -23 <(echo "$CURRENT_NAMES") <(echo "$TARGET_NAMES") || true)
if [[ -n "$STALE_NAMES" ]]; then
  echo "=== Cleaning up stale SSM parameters (removed from source) ==="
  batch=()
  flush_stale() {
    [[ ${#batch[@]} -eq 0 ]] && return
    if [[ "$DRY_RUN" == true ]]; then
      echo "  [dry-run] delete stale: ${batch[*]}"
    else
      echo "  -> delete stale: ${batch[*]}"
      aws ssm delete-parameters --region "$REGION" --names "${batch[@]}" >/dev/null
    fi
    batch=()
  }
  while IFS= read -r short; do
    [[ -z "$short" ]] && continue
    batch+=("${PREFIX}/${short}")
    [[ ${#batch[@]} -ge 10 ]] && flush_stale
  done <<< "$STALE_NAMES"
  flush_stale
  echo
fi

# -- Rewrite provider.environment in the root yaml ---------------------------
# Surgical, line-level edit: only the value of each externalized key inside the
# `provider.environment` block is replaced. Comments, blank lines, flow maps
# and every other section stay byte-for-byte identical (yq -i would reflow them).
if [[ ! -f "$ROOT_YAML" ]]; then
  echo "Warning: $ROOT_YAML not found — skipping root yaml sync." >&2
else
  echo "=== Syncing provider.environment in $ROOT_YAML ==="
  MAP_FILE="$(mktemp)"
  trap 'rm -f "$MAP_FILE"' EXIT
  while IFS= read -r row; do
    key=$(jq -r '.key' <<< "$row")
    envName=$(jq -r '.envName' <<< "$row")
    tail=$(jq -r '.tail' <<< "$row")
    # Tab-delimited: KEY \t new value to place after "KEY: ".
    if [[ -z "$tail" ]]; then
      # v3 fallback-chain: ${env:NAME, ssm:/path} — ssm fallback carries no ${}.
      printf '%s\t${env:%s, ssm:%s/%s}\n' "$key" "$envName" "$PREFIX" "$key" >> "$MAP_FILE"
    else
      # Dynamic suffix: the fallback is a QUOTED literal that interpolates the
      # SSM base plus the preserved tail, e.g. "${ssm:/path}/${sls:stage}".
      printf '%s\t${env:%s, "${ssm:%s/%s}%s"}\n' "$key" "$envName" "$PREFIX" "$key" "$tail" >> "$MAP_FILE"
    fi
  done < <(jq -c '.[]' <<< "$TARGETS_JSON")

  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] would rewrite $NUM_TARGETS value line(s):"
    while IFS=$'\t' read -r k v; do echo "    $k: $v"; done < "$MAP_FILE"
  else
    TMP_OUT="$(mktemp)"
    awk -v mapfile="$MAP_FILE" '
      BEGIN {
        while ((getline line < mapfile) > 0) {
          t = index(line, "\t")
          if (t > 0) repl[substr(line, 1, t-1)] = substr(line, t+1)
        }
      }
      {
        if ($0 ~ /^  environment:[[:space:]]*$/) { in_env=1; print; next }
        if (in_env && ($0 ~ /^  [A-Za-z_]/ || $0 ~ /^[A-Za-z_]/)) in_env=0
        if (in_env && $0 ~ /^    [A-Za-z_][A-Za-z0-9_]*:/) {
          rest = substr($0, 5)
          ci = index(rest, ":")
          key = substr(rest, 1, ci-1)
          if (key in repl) { print "    " key ": " repl[key]; next }
        }
        print
      }
    ' "$ROOT_YAML" > "$TMP_OUT" && mv "$TMP_OUT" "$ROOT_YAML"
    echo "  $ROOT_YAML provider.environment now references $NUM_TARGETS SSM parameter(s)."
  fi
fi

echo
echo "Done."
