# MCP catalog: Sentry, Grafana, Terraform and external OpenSearch

## Baseline and scope

Branch `feat/mcp-observability-terraform` starts at `origin/main` (`2e4bc32`). The existing
untracked feasibility analysis is reference material and is preserved. Main has five
catalog entries, a locked npm installer for two browsers, a shared stdio/Streamable HTTP
client, SecretStorage, discovery/dispatch allowlists and explicit connection consent.
There is no MCP OAuth flow. Browser installation and Chrome prerequisites must remain
unchanged. The Code Mode prototype is on a different branch and is outside this change.

## Upstream review (18 November 2026)

| Integration | Reviewed contract                                                                         | Delivery and authentication                                                                                                                   | Initial tools                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry      | `@sentry/mcp-server` 0.49.0, tag `cli@0.49.0`, `89e5973ee008087b6ce2f612bb419bff70b99cd9` | Externally installed `sentry-mcp`, Node >=22.15; `SENTRY_AUTH_TOKEN` via SecretStorage, explicit `SENTRY_HOST`; telemetry disabled            | Direct issue/event, organization, project and release reads; no generic executor, mutations, Seer or AI search agents                                   |
| Grafana     | v2.3.0, `c8cafb67854c45e79f8f9b5fca7d9b3a403f1771`                                        | Externally installed `mcp-grafana`, `GRAFANA_URL` and service account token via env; stdio, `--disable-write`, `--usage-stats=disabled`       | Datasources, dashboards, Prometheus and Loki reads with an independent exact allowlist                                                                  |
| Terraform   | v1.4.1, `3781509a674482ca7e2821fab8159a25e3b29bdf`                                        | Externally installed `terraform-mcp-server`; public Registry without token; HCP/TFE with explicit `TFE_ADDRESS` and SecretStorage `TFE_TOKEN` | Separate public Registry and HCP/TFE read profiles, exact `--tools`; no apply/destroy or workspace mutations                                            |
| OpenSearch  | Python server source 0.12.0, `ec714bb377372cb66f140143d8376fb452ab7975`                   | Existing external Streamable HTTP endpoint, optional proxy bearer token; cluster credentials and AWS signing stay server-side                 | ListIndexTool, IndexMappingTool, SearchIndexTool, CountTool, MsearchTool, ClusterHealthTool, GetShardsTool; block connection/auth overrides at dispatch |

Sources: [Sentry stdio](https://github.com/getsentry/toolkit/blob/cli%400.49.0/packages/mcp-server/README.md),
[Sentry authentication](https://github.com/getsentry/toolkit/blob/cli%400.49.0/docs/operations/stdio-auth.md),
[Grafana](https://github.com/grafana/mcp-grafana/tree/v2.3.0),
[Terraform](https://github.com/hashicorp/terraform-mcp-server/tree/v1.4.1),
[OpenSearch user guide](https://github.com/opensearch-project/opensearch-mcp-server-py/blob/ec714bb377372cb66f140143d8376fb452ab7975/USER_GUIDE.md).
Sources and published Sentry artifact were inspected directly. Upstream main branches
have moved since the prior analysis; contracts above use release tags where available.
Licenses: Sentry FSL-1.1-ALv2, Grafana/OpenSearch Apache-2.0, Terraform MPL-2.0.
These server artifacts are installed separately by users, not bundled or downloaded by Sovran.

## Implementation sequence

1. Extend metadata/schema with externally installed executables, service instance URLs,
   configurable MCP endpoint and Terraform Registry/HCP profiles. Validate versions,
   profiles, URLs and launch configuration; bind credentials to new connection destinations.
2. Add a separate preinstalled executable launch path. Resolve outside workspace roots,
   check the exact release with `--version`, set reviewed flags/env and use extension storage
   as cwd. Do not run installers, inspect Chrome or expose secrets in argv/version probes.
3. Add explicit per-profile tool allowlists. Reject OpenSearch connection overrides even
   if upstream hides them from schemas; keep generic API/executor tools unavailable.
   Preserve the shared MCP client, error semantics, cancellation and output limits.
4. Add native configuration prompts and accurate catalog/status descriptions. Configure
   disconnected; retain existing explicit token and Connect actions. Distinguish a
   Grafana/Sentry/TFE service URL from the external OpenSearch MCP URL.
5. Verify schema round trips, credential destination changes, tampered launches, missing
   and wrong-version executables, no-Chrome launches, discovery/reconnect/dispatch limits,
   errors and cancellation. Run typecheck, lint, full tests, production build and the
   available VS Code smoke suite; document any environment limitations honestly.
6. Update README, user guide, architecture and release notes with prerequisites, supported
   profiles, external OpenSearch deployment and verification evidence.

## Acceptance boundaries

No OAuth implementation, remote Sentry login, server auto-installers, extra integrations,
multimodal pipeline or new Code Mode eligibility. Public Registry is useful without HCP.
OpenSearch requires an operator-preconfigured cluster with dynamic connections disabled;
HTTPS or loopback HTTP only, no URL credentials/query/fragment. Read profiles are an
upper bound regardless of server annotations or per-tool Allow. Live authenticated service
validation requires credentials/instances absent from this workspace; local protocol and
fixture checks must be reported separately from live integration results.

## Execution and validation

All six implementation steps are complete. Existing catalog entries and browser package
versions are unchanged. No dependencies or upstream server artifacts were added to the
extension. The prior feasibility document remains untracked and untouched.

- Metadata, persisted settings and package configuration include the four integrations and
  Registry/HCP profiles. One canonical connection builder is shared by configuration and
  launch validation. Native setup saves disconnected and cancellation saves nothing.
- A dedicated preinstalled launcher checks executable resolution (including symlink targets)
  outside workspace roots, exact release output, fixed args/env and credential placement.
  Windows npm Sentry launchers use their known bundle through Node without a shell probe.
  Browser prerequisites and locked npm installation remain on their original path.
- New credentials are scoped to the persisted connection, and looked up only after managed
  validation; runtime command/cwd substitutions do not change the SecretStorage lookup.
- Independent allowlists cover discovery, tool-list changes and direct dispatch. OpenSearch
  connection/auth overrides fail before HTTP. Generic executors and mutation tools remain
  unavailable even if upstream labels them read-only. Missing HCP tools produce an explicit
  error, including when upstream successfully initializes with only Registry tools.
- Catalog copy distinguishes optional proxy tokens, preinstalled binaries and service/MCP
  endpoints. On-demand routing recognizes all four integrations. README, user guide,
  architecture and changelog document setup and supported boundaries.

### Automated checks

- `npm run check`: typecheck, lint and full Vitest suite passed, **789 tests passed,
  2 skipped** (39 passing test files, 1 skipped).
- Production `npm run build` and `git diff --check` passed.
- After tightening the tool-list refresh assertion, typecheck/lint and the 43 affected
  observability/routing tests passed again; production build passed with the final sources.
- Real VS Code **1.146.0** Linux extension smoke suite passed in a fresh test profile.
  The cloud host had no display/Xvfb initially; an isolated Xorg dummy display under `/tmp`
  allowed the standard project runner to complete. Only temporary cache/config folders and
  the test runner's ignored VS Code download were used. No project test runner changes.
- New tests cover destination credential binding, cancellation during setup, exact versions,
  tampered args/env/auth, missing/workspace executables, absence of Chrome/npm launches,
  Registry token independence, HCP fallback failure, schema round trips, UI profile selection,
  optional OpenSearch tokens, real Streamable HTTP filtering and override rejection,
  tool-list refresh/reconnect and direct dispatch.

### Published-artifact protocol checks

The real released Linux x86_64 binaries/bundle were launched through Sovran's managed
launcher, transport and hub. Sentry/Grafana initialized and enumerated their selected tools
without real account credentials; this verifies the protocol/contract, not account access.
Terraform HCP used a local simulated `/api/v2/ping` endpoint, not an HCP account.

| Artifact | Initialization and filtered discovery |
| --- | --- |
| Sentry npm 0.49.0 | Sentry MCP 0.49.0; 14 direct read tools |
| Grafana v2.3.0 Linux x86_64 | mcp-grafana 2.3.0; 15 dashboard/datasource/Prometheus/Loki tools |
| Terraform 1.4.1 Linux amd64, Registry | terraform-mcp-server 1.4.1; 9 public Registry tools |
| Terraform 1.4.1 Linux amd64, HCP/TFE fixture | 15 tools: Registry plus 6 workspace/run/plan reads |
| OpenSearch external endpoint | SDK HTTP fixture, anonymous and proxy bearer modes; only reviewed tools offered |

A real public Registry call also succeeded through the managed Terraform process:
`get_latest_provider_version({namespace: "hashicorp", name: "aws"})` returned a version
with `isError: false` and no HCP token. This is a live public read, separate from the HCP fixture.

Sentry's npm integrity matched its published metadata. Grafana's archive SHA256 matched
the published checksum (`f808ea13d236e549a9fffa14b28398d30b5393623141307c916e26f5e7746671`),
as did Terraform's archive (`8b2526451162e16d803ab014f7070f0f412962cdffffdcf446e70a846362481b`).
Artifacts and temporary smoke tooling remain outside the repository.

### Remaining validation limits

Authenticated Sentry/Grafana/HCP/TFE queries and a real operator-managed OpenSearch deployment
were not available. Windows/macOS/SSH/WSL/container execution was not exercised on those
platforms; Windows launcher handling is implemented but still needs a native smoke check.
The public protocol/fixture checks do not certify account permissions, rate limits, upstream
availability or every tenant-specific data source. No live service credentials were used.
