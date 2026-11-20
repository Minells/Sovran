# Remote service MCPs and third-party licensing

Branch: `feat/mcp-remote-licensing`, from `origin/main` (`c0d2ee8`).

## Scope and decisions

- Remove Sentry from the active catalog and its reviewed tools. Retain only enough legacy provenance to show an actionable retirement message and remove old settings safely.
- Grafana and Terraform connect exclusively to operator-managed Streamable HTTP MCP endpoints. The product API URL is not the MCP endpoint. No executable discovery, Node, npm or browser is needed for these connections.
- Use a new catalog connection revision (`remote-v1`). Keep the reviewed upstream versions in documentation; do not claim to enforce remote executable versions. Preserve host-side tool allowlists, argument restrictions and mandatory approvals.
- MCP proxy bearer credentials are distinct from Grafana/TFE credentials held by the operator. Bind credentials to the full connection; never migrate product tokens to a new endpoint.
- Disable legacy service configurations in memory, preserve their fields in settings, explain replacement/removal, and never silently convert them to unrestricted custom servers.
- Add explicit license/source/terms/permission metadata and expose it in the catalog and native connection/install confirmations. These are disclosures, not a claim of universal legal compliance or legal consent.
- Inventory locked browser dependencies separately from VSIX dependencies. Preserve and inventory actual package license/NOTICE files after installation, including notices in bundled dependencies. Extend bundled notices generation to retain multiple legal files.

## Implementation sequence

1. Update catalog, persistence compatibility and managed launch validation; remove preinstalled service launcher and Sentry write contracts.
2. Update native setup, credential handling, migration feedback and catalog disclosures.
3. Implement third-party inventories/notices, package them, and document operator deployment/permissions and privacy responsibilities.
4. Update regression tests for migration, remote authentication/destination validation, read/write boundaries and UI disclosures. Exercise real HTTP transport and representative released servers when local artifacts are available.
5. Run formatting, typecheck, lint, tests, build and VSIX verification. Review the final diff and commit on the feature branch.

## Upstream references

- Grafana 2.3.0: https://github.com/grafana/mcp-grafana/tree/v2.3.0 (Streamable HTTP, caller bearer token, separate Grafana credentials; Apache-2.0).
- Terraform 1.4.1: https://github.com/hashicorp/terraform-mcp-server/tree/v1.4.1 (Streamable HTTP; MPL-2.0). Protect remote deployment with an authenticating gateway and configure TFE credentials server-side.
- Apache redistribution: https://www.apache.org/licenses/LICENSE-2.0
- MPL obligations: https://www.mozilla.org/en-US/MPL/2.0/FAQ/
- Hosted services remain subject to provider terms; connecting remotely does not waive server license obligations.

## Validation outcomes

- Completed all five implementation steps. Active catalog has eight entries; only Playwright and Chrome DevTools retain managed npm installation.
- `npm run check` passed with both optional released-service fixtures enabled: **869 passed, 2 skipped**. The two skips are the pre-existing opt-in browser runtime checks.
- Released Grafana 2.3.0 and Terraform 1.4.1 binaries were started by the test harness in HTTP mode against local product API fixtures. Both authenticated writes succeeded and upstream failures stayed errors. The Terraform test gateway replaces the caller bearer token with a separate backend credential; native Terraform HTTP does not treat an unrelated bearer token as gateway authentication.
- New default HTTP tests cover Grafana/Terraform write profiles, mandatory Ask despite saved Allow, blocked unreviewed tools and rejected Terraform destroy requests. Migration tests cover disabled legacy settings, refusal before secret lookup, removal and remote replacement UI.
- Real locked npm installs with scripts disabled produced 7 legal files for Playwright and 2 for DevTools, plus DevTools' bundled package inventory. Original legal files remained intact.
- Production build and VSIX verification passed: 30 packaged files, exact lockfiles and both legal documents, no MCP/browser binaries or node_modules.
- Installed VSIX smoke passed in VS Code **1.146.0**, using a fresh profile and a temporary dummy X display. The first attempt encountered a missing display; rerunning with the temporary display passed. The minimum VS Code smoke remains part of the existing CI workflow.
- `git diff --check` passed. The pre-existing untracked feasibility document was left unchanged.

## Operational limits

The administrator must deploy reachable HTTPS MCP endpoints and configure backend permissions, gateway authentication and telemetry. Terraform requires token translation at the gateway to keep its MCP caller credential separate from TFE credentials. This branch does not deploy infrastructure or claim legal clearance for an operator's actual server/version/service agreement. Runtime reference versions describe reviewed contracts rather than enforcing remote binary provenance.
