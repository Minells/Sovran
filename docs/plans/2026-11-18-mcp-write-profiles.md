# Reviewed MCP write profiles

## Goal and baseline

Continue `feat/mcp-observability-terraform` from `da8615e`. Enable useful operations on
Sentry, Grafana, Terraform and external OpenSearch while preserving existing read profiles,
stored connections, browser presets and credential bindings. No existing connection gains
write access automatically. Each managed write requires approval, including in Auto mode
and when an imported settings entry lists it under `allowedTools`.

## Upstream contract review

Use the same reviewed versions as the read integration; no runtime upgrades or dependencies.

| Service / new profile              | Selected write tools                                                                | Upstream launch/configuration                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry 0.49.0 / `collaboration`    | `update_issue`, `add_issue_note`                                                    | `--skills inspect,triage`; API token needs `event:write` in addition to read scopes                                                                       |
| Grafana 2.3.0 / `collaboration`    | `update_dashboard`, `create_annotation`, `update_annotation`, `delete_annotation`   | Use `--disable-write=false` only for collaboration, restrict enabled categories and enforce the exact host allowlist; add full dashboard/annotation reads |
| Terraform 1.4.1 / `hcp-operations` | `create_workspace`, `update_workspace`, `create_run`, `action_run`                  | Exact `--tools` allowlist and `ENABLE_TF_OPERATIONS=true`; TFE endpoint and SecretStorage token required                                                  |
| OpenSearch external / `operations` | `GenericOpenSearchApiTool`, constrained by Sovran to selected index/document routes | Operator enables upstream write support (`OPENSEARCH_SETTINGS_ALLOW_WRITE=true`); cluster auth and dynamic-connection restrictions remain server-side     |

Reviewed sources: [Sentry triage](https://github.com/getsentry/toolkit/tree/cli%400.49.0/packages/mcp-core/src/tools/catalog),
[Grafana write filters](https://github.com/grafana/mcp-grafana/tree/v2.3.0),
[Terraform tools](https://github.com/hashicorp/terraform-mcp-server/tree/v1.4.1/pkg/tools/tfe),
[OpenSearch generic API](https://github.com/opensearch-project/opensearch-mcp-server-py/blob/ec714bb377372cb66f140143d8376fb452ab7975/src/tools/generic_api_tool.py).
Pinned upstream sources and prior downloaded release artifacts are available locally.

OpenSearch's reviewed server uses a generic API tool for document/index writes; inventing
dedicated upstream tool names would produce a nonfunctional integration. Expose that tool
only in the operations profile with a narrowed model-facing schema, reviewed description,
and host validation before approval and again before dispatch. Permit index creation,
mapping updates, individual document creation/replacement, partial document updates and
single-document deletion. Reject arbitrary endpoints/methods, custom headers, URL/query
injection, wildcard/system index targets, scripted updates, bulk operations and unknown options.
Optimistic-concurrency query parameters must be paired and typed correctly.

Terraform's upstream `create_run` defaults to `plan_and_apply` and has additional destructive
run types when operations are enabled. Require an explicit `plan_only` or `plan_and_apply`;
the latter sets AutoApply=false upstream. Reject auto-approval/destroy/refresh run types.
Reject enabling workspace auto-apply. `action_run` targets one immutable run ID with an
explicit apply/cancel/discard action. The model is instructed to review that run's plan
before requesting apply approval; the host enforces the explicit action/run ID and per-call
approval. Infrastructure changes in an approved plan can create, change or delete
resources. No workspace deletion, forced unlock, variable/secret editing or local CLI access.

## Implementation sequence

1. Add write-tool contracts, labels and profile metadata; extend runtime and settings schemas.
   Keep old profile flags, tool allowlists, defaults and configuration shapes unchanged.
2. Add argument guards and reviewed descriptions/schema where upstream is broader than the
   managed capability. Reuse the existing prepare/dispatch checks and mandatory approval
   mechanism; preserve Off precedence, trust, Plan mode, exclusions and cancellation.
3. Extend native setup/consent and webview copy to show capabilities and credential needs.
   Existing connections remain unchanged; users explicitly configure a separate write profile.
4. Test valid mutations, rejected argument variants, denied approvals, malicious annotations,
   forced Ask despite Allow settings, profile downgrade/reconnect, stale tools and token binding.
   Exercise actual released servers against local API fixtures, never production writes.
5. Run full checks, production build and real VS Code smoke where available. Update user
   guide, architecture and changelog; record evidence and limitations here, then commit locally.

## Validation results

Implementation is complete on the existing feature branch. No package/server version or
dependency was changed. Read profiles keep their canonical arguments and tool bounds;
new operation profiles are configured separately with destination-bound credentials.

### Findings resolved during implementation

- Grafana 2.3.0 accepts `--enable-write-tools`, but its dashboard and annotation registrars
  still check the global write flag. A release-artifact discovery test caught the missing
  writes. Collaboration therefore uses `--disable-write=false` with only the selected
  categories; Sovran's independent allowlist excludes other registered tools, including
  datasource mutations. Read-only still uses its original `--disable-write` command.
- OpenSearch's documented operator setting is `OPENSEARCH_SETTINGS_ALLOW_WRITE=true`;
  credentials and connection overrides remain server-side. The model receives a narrowed
  API schema with only approved method/path combinations, JSON bodies and document options.
- Terraform's real released server was checked against an API fixture with workspace
  auto-apply enabled. `plan_and_apply` still sends `auto-apply: false` for the new run;
  a separate `action_run` call is needed to request apply. Success is described as action
  submission, with a follow-up read to establish the final run outcome.
- Managed writes carry a host `managed-write` classification, rather than trusting an
  upstream `readOnlyHint` or attributing host review to the server. The UI removes Allow
  for these tools, and the host rejects attempts to set it. Imported Allow settings also
  resolve to Ask. Targets are ordered before large payloads in approval previews, including
  dashboard identity/version inside full JSON; actual dispatched arguments are unchanged.

### Automated coverage

The final `npm run check` passed with the three released service executables enabled:
**870 tests passed, 2 existing browser smoke tests skipped** (41 passing test files and
1 skipped file). Typecheck and ESLint passed. Production `npm run build` and
`git diff --check` passed. Ordinary test runs require no external service executables;
the three release checks skip unless their explicit environment variables are configured.

New coverage includes explicit profile setup/cancellation, token destination binding,
read-to-write opt-in, canonical flags, schema narrowing, every new write requiring Ask,
Off precedence, false upstream read-only claims, denied approvals, trust revocation,
profile downgrade, stale tool-list removal, cancellation, and bounded approval previews.
OpenSearch tests cover concrete writes and refusal of wildcard/encoded/system targets,
arbitrary methods/endpoints/headers, connection credentials, raw/bulk/scripted updates,
index deletion and malformed concurrency parameters. Real Streamable HTTP tests verify
rejection before network dispatch and preservation of upstream `isError` responses.

### Real released server checks against local API fixtures

`tests/integration/managedServiceWrites.test.ts` is opt-in and never downloads software,
uses production credentials or mutates a real tenant. Set these executable paths to run it:

```sh
SOVRAN_TEST_SENTRY_MCP=/absolute/path/to/sentry-mcp \
SOVRAN_TEST_GRAFANA_MCP=/absolute/path/to/mcp-grafana \
SOVRAN_TEST_TERRAFORM_MCP=/absolute/path/to/terraform-mcp-server \
npx vitest run tests/integration/managedServiceWrites.test.ts
```

The pinned Linux artifacts used for the read integration were reused. All three checks
passed: selected writes are discovered; a Sentry issue note and Grafana annotation reach
the local fixture with the token in a bearer header; Terraform creates a run with automatic
apply disabled and applies only in a separate call. Simulated HTTP 403 responses remain
tool errors. Unreviewed writes are absent from the offered tool list.

Real VS Code 1.146.0 Linux smoke passed using the project's standard runner on the existing
isolated dummy display. Tenant credentials, production operations and native Windows/macOS/
SSH/WSL/container execution were not available. OpenSearch uses an SDK Streamable HTTP
fixture, not a running Python MCP server/cluster. These checks establish local integration
behavior and do not certify tenant permissions or final infrastructure outcomes.
