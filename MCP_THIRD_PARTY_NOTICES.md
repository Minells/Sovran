# Optional MCP Package Notices

Generated from Sovran's locked MCP manifests by `scripts/mcp-third-party-notices.mjs`. These servers and their dependencies are **not bundled in the VSIX**. They are downloaded from npm only after the user chooses Install.

The table records declared licenses and immutable artifact provenance. It is not a complete license clearance: dependencies embedded inside a published bundle may have additional notices and licenses absent from npm dependency metadata.

Sovran preserves original legal files. Each new installation also contains `third-party-inventory.json` (locked packages, provenance and legal-file paths) and `THIRD_PARTY_NOTICES.txt` (the actual LICENSE, COPYING, NOTICE and third-party notices found in the downloaded files, including nested bundled directories). Both are saved in the versioned installation directory under VS Code extension global storage, alongside `node_modules`. Existing installations can be explicitly reinstalled to generate these files.

Apache-2.0 permits commercial use and distribution subject to its conditions, including supplying the license and applicable notices. See https://www.apache.org/licenses/LICENSE-2.0. The MIT license for Sovran does not replace these terms. Website/account terms also apply to browser interactions. Chrome itself is installed separately and is not downloaded by this installer.

## playwright

| Package | Version | Declared license |
|---|---|---|
| @playwright/mcp | 0.0.84 | Apache-2.0 |

Source artifact: https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.84.tgz

Integrity: `sha512-weqLrA7/D8MJzNV9/t3Hnjp100tS2sxFXKeb2gH6Nhktqmdfvx5qRA9AZ5Mhjnre1jY0wltsrRK5VZS5NBgcvw==`

| Package | Version | Declared license |
|---|---|---|
| playwright | 1.65.0-alpha-2026-10-30 | Apache-2.0 |

Source artifact: https://registry.npmjs.org/playwright/-/playwright-1.65.0-alpha-2026-10-30.tgz

Integrity: `sha512-dmAJMVHKzHvMQjn+XDcaq/pxaZ0W6n8i78rwTM+VGRtQ3WBF5ZiSdB1yL/cyoYUGUMwg3jxN65KqC9cERaCbIg==`

| Package | Version | Declared license |
|---|---|---|
| playwright-core | 1.65.0-alpha-2026-10-30 | Apache-2.0 |

Source artifact: https://registry.npmjs.org/playwright-core/-/playwright-core-1.65.0-alpha-2026-10-30.tgz

Integrity: `sha512-LPMw8B/HRQKMcJeXTqWSrkB/AfCKKmbDQMbu0p7zg8MgibOWaKMjZWR/StAtrQkOxvOmZEju1o1TnPgdoOCwrg==`

## devtools

| Package | Version | Declared license |
|---|---|---|
| chrome-devtools-mcp | 1.12.0 | Apache-2.0 |

Source artifact: https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.12.0.tgz

Integrity: `sha512-lAGpH0zXT1ZdaPefP1KK/MvxwihOlu7VGQ7p4wbhD9OhN17vUC4KWk/ImUYR9DE4s+7r4r0ySV4xr2OkTa7ZMA==`

## Remote integrations

GitHub, GitLab and Context7 use external services. Grafana, Terraform and OpenSearch use operator-managed MCP endpoints. Sovran does not download or redistribute these servers. Their reference licenses, sources, service terms and required permissions are available in Browse Catalog. Operators remain responsible for their deployment, licenses, authentication, service agreements and data handling. Remote access does not waive those obligations.
