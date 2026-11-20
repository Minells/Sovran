/** Version-specific disclosures. A server license does not replace the connected service's terms. */
import type { IntegrationId } from './catalog';

export interface IntegrationLegal {
  license?: { name: string; url: string };
  source: string;
  terms: { name: string; url: string }[];
  permissions: string;
}

export const MCP_DATA_DISCLOSURE =
  'Tool results may contain personal or confidential data and are sent to your configured model. Use only authorized accounts and resources; review your organization’s data and service agreements.';

export const INTEGRATION_LEGAL: Readonly<Record<Exclude<IntegrationId, 'sentry'>, IntegrationLegal>> = {
  playwright: {
    license: { name: 'Apache-2.0', url: 'https://github.com/microsoft/playwright-mcp/blob/v0.0.84/LICENSE' },
    source: 'https://github.com/microsoft/playwright-mcp/tree/v0.0.84',
    terms: [],
    permissions:
      'Browser access can read and change websites available to the extension host. Site terms and account permissions apply.',
  },
  devtools: {
    license: {
      name: 'Apache-2.0',
      url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.12.0/LICENSE',
    },
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/chrome-devtools-mcp-v1.12.0',
    terms: [],
    permissions:
      'Browser inspection may reveal session, network and page data. Site terms and account permissions apply.',
  },
  grafana: {
    license: { name: 'Apache-2.0', url: 'https://github.com/grafana/mcp-grafana/blob/v2.3.0/LICENSE' },
    source: 'https://github.com/grafana/mcp-grafana/tree/v2.3.0',
    terms: [{ name: 'Grafana service terms', url: 'https://grafana.com/legal/' }],
    permissions:
      'The operator grants Grafana datasource/dashboard reads and, for collaboration, dashboard/annotation writes. Your MCP caller token is separate from those service credentials.',
  },
  terraform: {
    license: {
      name: 'MPL-2.0',
      url: 'https://github.com/hashicorp/terraform-mcp-server/blob/v1.4.1/LICENSE',
    },
    source: 'https://github.com/hashicorp/terraform-mcp-server/tree/v1.4.1',
    terms: [{ name: 'HashiCorp service terms', url: 'https://www.hashicorp.com/en/terms-of-service' }],
    permissions:
      'The operator configures HCP/TFE workspace/run access and a gateway that replaces Authorization with the authorized backend TFE token. Operations can change infrastructure. Your MCP gateway token is separate from the TFE API token; Registry still needs gateway authentication.',
  },
  opensearch: {
    license: {
      name: 'Apache-2.0',
      url: 'https://github.com/opensearch-project/opensearch-mcp-server-py/blob/ec714bb377372cb66f140143d8376fb452ab7975/LICENSE.txt',
    },
    source:
      'https://github.com/opensearch-project/opensearch-mcp-server-py/tree/ec714bb377372cb66f140143d8376fb452ab7975',
    terms: [],
    permissions:
      'The operator controls cluster credentials and index/document access. Use an MCP proxy token, not cluster credentials. Your hosting provider or enterprise agreement may add terms.',
  },
  github: {
    source: 'https://github.com/github/github-mcp-server',
    terms: [
      {
        name: 'GitHub service terms',
        url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
      },
    ],
    permissions:
      'Use a PAT restricted to selected repositories and the read/write operations you need. Hosted service access and plan restrictions apply.',
  },
  gitlab: {
    source: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
    terms: [{ name: 'GitLab service terms', url: 'https://about.gitlab.com/terms/' }],
    permissions:
      'Use a fine-grained PAT with MCP tool Execute and access only to the projects you need. Your instance, license and account determine available operations.',
  },
  context7: {
    source: 'https://github.com/upstash/context7',
    terms: [
      { name: 'Upstash service terms', url: 'https://upstash.com/trust/terms.pdf' },
      { name: 'Context7 addendum', url: 'https://upstash.com/trust/context7addendum.pdf' },
    ],
    permissions:
      'Only send public documentation queries. Hosted service quotas, privacy policy and terms apply even without an API key.',
  },
};

export function integrationLegal(id: IntegrationId): IntegrationLegal | undefined {
  return id === 'sentry' ? undefined : INTEGRATION_LEGAL[id];
}

export function integrationLegalSummary(id: IntegrationId): string {
  const legal = integrationLegal(id);
  if (!legal) return '';
  return [
    legal.license
      ? `Reference server license: ${legal.license.name} — ${legal.license.url}.`
      : 'Hosted service terms apply.',
    ...legal.terms.map((term) => `${term.name}: ${term.url}.`),
    legal.permissions,
    'Third-party integration; Sovran’s MIT license does not replace third-party licenses or service agreements.',
  ].join('\n');
}
