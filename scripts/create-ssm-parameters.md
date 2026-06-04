# create-ssm-parameters.sh

Moves the values in `provider.environment` out of the committed `serverless.yml`
and into **AWS SSM Parameter Store**, then rewrites the committed file so each
variable resolves from SSM via the Serverless Framework's native `${ssm:...}`
syntax. Secrets stop living in git; the Lambda keeps running unchanged.

## TL;DR

```bash
# Preview dev (read-only, no AWS writes, no file edits)
./scripts/create-ssm-parameters.sh --dry-run --diff

# Apply dev: create/update SSM params + rewrite serverless.yml provider.environment
./scripts/create-ssm-parameters.sh

# Same flow for prod (derives scripts/serverless-prod.yml + /drinkbuy/wss-lambda/prod)
./scripts/create-ssm-parameters.sh --stage prod --dry-run --diff
./scripts/create-ssm-parameters.sh --stage prod

# Deploy as usual — Serverless reads SSM at deploy time
./deploy-dev.sh
```

## Does the Lambda have permission to read SSM today? (and does it need it?)

**Today the Lambda has _no_ SSM permission.** The execution role in
`serverless.yml` (`provider.iam.role.statements`) grants only DynamoDB actions
on `ConnectionsTable` and `execute-api:ManageConnections` — there is no
`ssm:GetParameter*` anywhere.

**It does not need one with this approach, and nothing changes at runtime.**
`${ssm:/path}` is resolved by the **Serverless Framework at deploy time**, using
the *deployer's* AWS credentials (the `drink-root` profile in `deploy-dev.sh`),
not the Lambda's. Serverless fetches the value during `serverless deploy`
(auto-decrypting `SecureString` on framework v3) and bakes it into the Lambda's
plain environment variables in the generated CloudFormation — exactly where the
hardcoded defaults used to land. At runtime the function still just reads
`process.env.X` (see `src/env.ts`); it never calls SSM.

So:

- **Lambda execution role** — needs nothing new. Leave it as is.
- **Deployer credentials** — need `ssm:GetParameters` (read at deploy) plus
  `kms:Decrypt` on `alias/aws/ssm` for the `SecureString` entries. The
  `drink-root` profile already has admin, so this is covered.
- **Whoever runs this script** — needs `ssm:PutParameter`,
  `ssm:GetParametersByPath`, `ssm:DeleteParameters`, and `kms:Encrypt/Decrypt`
  on `alias/aws/ssm`.

> If you ever switch to **runtime** SSM reads (the Lambda calling
> `GetParameter` itself via the AWS SDK), that's a different design: you'd add
> `ssm:GetParameter` + `kms:Decrypt` to the execution role **and** change the
> code in `src/env.ts` to fetch asynchronously. This script intentionally does
> *not* do that, because the requirement is "the Lambda keeps working exactly as
> it does today" — and deploy-time resolution achieves that with zero code and
> zero IAM changes.

## How it works

There is one source-of-truth file **per stage** and one committed deploy file:

| File | Role | Git |
| ---- | ---- | --- |
| `scripts/serverless-dev.yml`  | **Source of truth (dev)**  — holds the decrypted dev values under `provider.environment`. Read by this script when `--stage dev` (default). | **gitignored** |
| `scripts/serverless-prod.yml` | **Source of truth (prod)** — same shape, prod values. Read when `--stage prod`. | **gitignored** |
| `serverless.yml` (repo root)  | **Deployed config** — its `provider.environment` is rewritten to `${ssm:...}` references. Read by Serverless at deploy. | committed |

The `--stage <stage>` flag (default `dev`) drives the defaults for both
`--file` (`scripts/serverless-<stage>.yml`) and `--prefix`
(`/drinkbuy/wss-lambda/<stage>`). Passing `--file`/`--prefix` explicitly still
overrides the derivation.

For each run the script:

1. Reads `provider.environment` from the source file (`--file`).
2. Classifies every variable (see *What gets externalized* below).
3. Writes each externalized value to SSM under `--prefix`, as `String` or
   `SecureString` depending on `SENSITIVE_PARAMS`. Idempotent — unchanged
   entries are skipped, only new/changed ones are written.
4. Deletes stale parameters (present under the prefix but no longer in the
   source) so SSM never drifts ahead of the source.
5. **Surgically rewrites** only the matching value lines in the root
   `serverless.yml` `provider.environment` block. Comments, blank lines, flow
   maps and every other section stay byte-for-byte identical — no full-file
   reformat.

### Rewrite shape

The `${env:NAME, ...}` override chain is **kept on purpose** — `deploy-dev.sh`
exports a few of these (`API_GW_WS_ENDPOINT`, `WEBSOCKET_DOMAIN`), and that
override must still win. SSM becomes the fallback:

```yaml
# before
MONGODB_URI: ${env:MONGODB_URI, "mongodb+srv://drinkbuy.pxmj6.mongodb.net/..."}
# after
MONGODB_URI: ${env:MONGODB_URI, ssm:/drinkbuy/wss-lambda/dev/MONGODB_URI}
```

Resolution order at deploy: exported env var → else the SSM parameter.

> **Syntax note (v3):** the fallback chain lives inside a *single* `${...}` with
> comma-separated sources — the `ssm:` fallback has **no braces of its own**. The
> doubly-wrapped form `${env:X, ${ssm:Y}}` is rejected by the v3 resolver with
> "Invalid variable source", and a bare literal fallback must be quoted
> (`${env:X, "default"}`).

## What gets externalized vs left untouched

The script decides per variable in `provider.environment`:

| Source form | Action |
| ----------- | ------ |
| `${env:NAME, "literal"}` | Push `literal` to SSM; rewrite to `${env:NAME, ssm:.../KEY}`. |
| `${env:NAME, "base/${sls:stage}"}` | Push only the **static base** to SSM; rewrite to `${env:NAME, "${ssm:.../KEY}/${sls:stage}"}` — the dynamic tail is rebuilt in the yaml (e.g. `WEBSOCKET_API_ENDPOINT`). |
| bare literal, no `${...}` (e.g. `foo`) | Push value to SSM; rewrite to `${env:KEY, ssm:.../KEY}`. |
| empty value | **Left untouched** (e.g. `DDB_LOCAL_ENDPOINT:`). |
| bare value with `${...}` (no `${env:}` wrapper) | **Left untouched** (e.g. `CONNECTIONS_TABLE`, `WEBSOCKET_STAGE`). |

With today's `serverless.yml` that means **8 externalized** and **3 left as-is**:

| Externalized → SSM | Skipped (stays in serverless.yml) |
| ------------------ | --------------------------------- |
| `MONGODB_URI` (SecureString) | `DDB_LOCAL_ENDPOINT` (empty) |
| `MONGODB_USER` (SecureString) | `CONNECTIONS_TABLE` (bare `${sls:stage}`) |
| `MONGODB_PASS` (SecureString) | `WEBSOCKET_STAGE` (bare `${opt:stage}`) |
| `JWT_SECRET` (SecureString) | |
| `SOCKET_CORS_ORIGIN` (String) | |
| `API_GW_WS_ENDPOINT` (String) | |
| `WEBSOCKET_DOMAIN` (String) | |
| `WEBSOCKET_API_ENDPOINT` (String — base only; `/${sls:stage}` re-appended in yaml) | |

A variable with a `${...}` directive is only externalized when it's wrapped in
`${env:NAME, ...}` **and** has a static prefix before the directive: the static
part goes to SSM and the directive is rebuilt in the yaml. A **bare** value with
`${...}` (no `${env:}` wrapper, like `CONNECTIONS_TABLE`) is left as-is — it's a
stage-derived name, not externalizable config. Storing literal `${sls:stage}` in
SSM would ship a broken value (Serverless does not re-resolve SSM values after
fetch).

## Sensitivity → encryption

Edit `SENSITIVE_PARAMS` at the top of the script to control which keys are
stored as `SecureString` (KMS-encrypted at rest) vs `String`. Default:

```
JWT_SECRET, MONGODB_URI, MONGODB_USER, MONGODB_PASS
```

Both types resolve identically through `${ssm:...}` at deploy time — the only
difference is at-rest encryption in SSM. Add any new secret's name here before
running.

## Requirements

```bash
brew install awscli yq jq
aws sts get-caller-identity --profile drink-root   # confirm credentials
```

`yq` must be the mikefarah Go build (v4+). `aws`, `yq`, `jq` are all required.

## Usage

```bash
# Preview dev vs current SSM (read-only)
./scripts/create-ssm-parameters.sh --dry-run --diff

# Apply dev (writes changed/new SSM entries; rewrites root serverless.yml)
./scripts/create-ssm-parameters.sh

# Apply dev with a visible per-name diff
./scripts/create-ssm-parameters.sh --diff

# Same flow against prod — --stage derives file + prefix
./scripts/create-ssm-parameters.sh --stage prod --dry-run --diff
./scripts/create-ssm-parameters.sh --stage prod

# Clean slate: backup + wipe + recreate from source (per stage)
./scripts/create-ssm-parameters.sh --reset
./scripts/create-ssm-parameters.sh --stage prod --reset

# Manually override file / prefix (the --stage derivation is just the default)
./scripts/create-ssm-parameters.sh \
  --file scripts/serverless-staging.yml \
  --prefix /drinkbuy/wss-lambda/staging
```

If your credentials live behind a profile, prefix the command with
`AWS_PROFILE=drink-root`.

## Day-to-day workflow

1. Add/edit/remove a variable in **`scripts/serverless-<stage>.yml`**
   `provider.environment` (the gitignored source — put the real value there).
2. `./scripts/create-ssm-parameters.sh [--stage prod] --dry-run --diff` to preview.
3. `./scripts/create-ssm-parameters.sh [--stage prod]` to apply.
4. `git diff serverless.yml` to review the regenerated `${ssm:...}` references.
5. Commit the code + the updated root `serverless.yml`. The SSM write and the
   git push are independent — SSM values take effect on the **next deploy**.
6. Deploy: `./deploy-dev.sh`.

> **Order matters:** run this script **before** the first deploy that relies on
> a new `${ssm:...}` reference. If Serverless resolves `${ssm:/.../X}` and the
> parameter doesn't exist (and no overriding env var is exported), the deploy
> fails. The `${env:...}` fallback only saves you when that env var is set.

## When to use `--reset`

Use it once after a structural change (renaming a variable, changing a prefix).
It writes a local `ssm-backup-YYYYMMDD-HHMMSS.json` with every current value
before deleting, then recreates from source. The backup is plaintext — keep it
out of git and rotate it through your secret store afterwards. Also note:
`put-parameter --overwrite` cannot flip a parameter's `Type`, so a
`String → SecureString` change only takes effect after a `--reset` (or a manual
delete + recreate).

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--stage <stage>` | `dev` | Drives the defaults for `--file` (`scripts/serverless-<stage>.yml`) and `--prefix` (`/drinkbuy/wss-lambda/<stage>`). |
| `--file <path>` | `scripts/serverless-<stage>.yml` | Source YAML read for `provider.environment` values. Overrides the stage-derived default. |
| `--root <path>` | `serverless.yml` | Committed config whose `provider.environment` is rewritten. |
| `--prefix <path>` | `/drinkbuy/wss-lambda/<stage>` | SSM prefix to write under. Overrides the stage-derived default. |
| `--region <region>` | `us-east-1` | AWS region. |
| `--dry-run` | off | Skip every AWS write and root-yaml edit; print only. |
| `--diff` | off | Print which params are new/changed/same vs current SSM. |
| `--reset` | off | Backup + delete every parameter under the prefix before writing. |

## Verifying after a run

```bash
# List the parameters
aws ssm get-parameters-by-path --region us-east-1 \
  --path /drinkbuy/wss-lambda/dev/ --recursive \
  --query 'Parameters[].[Name,Type]' --output table

# Inspect one (decrypted)
aws ssm get-parameter --region us-east-1 --with-decryption \
  --name /drinkbuy/wss-lambda/dev/JWT_SECRET \
  --query 'Parameter.Value' --output text

# Confirm Serverless resolves them (prints the fully-resolved config)
npx serverless print --stage dev --aws-profile drink-root | grep -A12 'environment:'
```

## Notes & gotchas

- **Deploy-time, not runtime.** `${ssm:...}` is resolved during
  `serverless deploy` and frozen into the Lambda's env vars. Changing a value in
  SSM does **not** affect a running Lambda until the next deploy.
- **SecureString → plaintext env var.** On framework v3, `${ssm:/path}`
  auto-decrypts `SecureString` and the decrypted value ends up as a plain Lambda
  environment variable. That's the same exposure as the old hardcoded defaults —
  fine for this migration, but don't treat it as runtime secrecy.
- **Source must stay plaintext.** The script reads values from `--file`. If you
  point `--file` at the already-rewritten root `serverless.yml`, there are no
  literals left to extract — the script refuses when `--file` and `--root` are
  the same path.
- **The override fallback is real.** `deploy-dev.sh` exports
  `API_GW_WS_ENDPOINT` and `WEBSOCKET_DOMAIN`; those exported values win over
  SSM at deploy time. Unset them (or update `deploy-dev.sh`) if you want SSM to
  be the source for those two.
- **Local offline.** `serverless offline` (see `deploy-local.sh`) resolves
  `${ssm:...}` too, so running fully offline needs either valid AWS credentials
  or the corresponding env var exported locally. `deploy-local.sh` already
  exports `CONNECTIONS_TABLE`/`AWS_REGION`; export any others you need for a
  no-network run.
- **Stale cleanup is automatic.** Parameters under the prefix that are no longer
  produced from the source are deleted on each run. Keep unrelated parameters
  under a different prefix.
- **Idempotent.** Re-running with no source changes makes no SSM writes and
  produces an identical `serverless.yml` — safe to run repeatedly.