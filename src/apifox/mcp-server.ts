/**
 * Apifox Extra MCP Server — stdio-based MCP server exposing Apifox capabilities
 * that the official apifox-mcp-server does not provide.
 *
 * The official server only exposes `export-openapi`, which Apifox forces to return
 * the MERGED main + sprint-branch spec ("To ensure data integrity, this export will
 * include the merged content of the current sprint branch and the main branch").
 * There is no way to isolate a sprint branch's own (new/modified) endpoints through it.
 *
 * This server wraps Apifox's `api-tree-list` endpoint, which DOES respect the
 * `X-Branch-Id` header and returns only the branch's own tree — matching the
 * Apifox sidebar view exactly.
 *
 * Spawned by Claude Code as a child process via .mcp.json configuration.
 *
 * Environment variables:
 * - APIFOX_ACCESS_TOKEN: Apifox Open API personal token (the `afxp_...` value). REQUIRED.
 * - APIFOX_PROJECT_ID:   default project id used when a call omits `project_id`. Optional.
 * - APIFOX_API_BASE_URL: base url (default: https://api.apifox.com)
 * - APIFOX_API_VERSION:  X-Apifox-Api-Version header value (default: 2024-03-28)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ACCESS_TOKEN = process.env['APIFOX_ACCESS_TOKEN'] ?? '';
const DEFAULT_PROJECT_ID = process.env['APIFOX_PROJECT_ID'] ?? '';
const BASE_URL = process.env['APIFOX_API_BASE_URL'] ?? 'https://api.apifox.com';
const API_VERSION = process.env['APIFOX_API_VERSION'] ?? '2024-03-28';

interface ApiNode {
  type: string;
  name: string;
  children?: ApiNode[];
  api?: { method?: string; path?: string; name?: string; status?: string };
}

/** Walk the api-tree-list response, flattening folders → endpoints. */
function flattenTree(nodes: ApiNode[], folder: string | null, out: string[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'apiDetailFolder') {
      out.push(`\n## ${node.name}`);
      count += flattenTree(node.children ?? [], node.name, out);
    } else if (node.type === 'apiDetail' && node.api) {
      const { method = '', path = '', name = '' } = node.api;
      out.push(`${method.toUpperCase().padEnd(7)} ${path}  # ${name}`);
      count++;
    } else if (node.children?.length) {
      // Non-folder grouping node (e.g. schema folders) — recurse but don't print a header.
      count += flattenTree(node.children, folder, out);
    }
  }
  return count;
}

async function listBranchApis(args: Record<string, unknown>): Promise<string> {
  if (!ACCESS_TOKEN) {
    return 'Error: APIFOX_ACCESS_TOKEN is not configured for this MCP server.';
  }
  const projectId = String(args['project_id'] ?? DEFAULT_PROJECT_ID).trim();
  if (!projectId) {
    return 'Error: no project_id provided and APIFOX_PROJECT_ID is not set.';
  }
  const branchId = args['branch_id'] != null ? String(args['branch_id']).trim() : '';
  const locale = String(args['locale'] ?? 'en-US');

  const url = `${BASE_URL}/api/v1/projects/${projectId}/api-tree-list?locale=${encodeURIComponent(locale)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'X-Apifox-Api-Version': API_VERSION,
  };
  // Omitting X-Branch-Id defaults to the main branch; present scopes to that sprint branch.
  if (branchId) headers['X-Branch-Id'] = branchId;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return `Error: request to Apifox failed: ${(err as Error).message}`;
  }
  if (!res.ok) {
    return `Error: Apifox returned HTTP ${res.status} ${res.statusText}`;
  }
  const body = (await res.json()) as { success?: boolean; data?: ApiNode[]; errorMessage?: string };
  if (!body.success || !Array.isArray(body.data)) {
    return `Error: Apifox response not successful: ${body.errorMessage ?? JSON.stringify(body).slice(0, 300)}`;
  }

  const lines: string[] = [];
  const total = flattenTree(body.data, null, lines);
  const header = `Apifox project ${projectId}${branchId ? `, branch ${branchId}` : ' (main branch)'} — ${total} endpoints`;
  return `${header}\n${lines.join('\n')}`;
}

const server = new Server(
  { name: 'apifox-extra', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'apifox_branch_api_list',
      description:
        "List the API endpoints in an Apifox project, scoped to a specific sprint branch. " +
        "Unlike the official apifox export (which always merges the branch with main), this " +
        "returns ONLY the branch's own tree via the api-tree-list endpoint, matching the " +
        "Apifox sidebar. Omit branch_id to list the main branch.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          branch_id: {
            type: 'string',
            description:
              "Sprint branch id (the numeric id shown in 'Manage Sprint Branches', e.g. 8261046). " +
              'Omit to query the main branch.',
          },
          project_id: {
            type: 'string',
            description: 'Apifox project id. Defaults to APIFOX_PROJECT_ID if omitted.',
          },
          locale: {
            type: 'string',
            description: 'Response locale (default: en-US).',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result: string;
  switch (name) {
    case 'apifox_branch_api_list':
      result = await listBranchApis(args ?? {});
      break;
    default:
      result = `Unknown tool: ${name}`;
  }
  return { content: [{ type: 'text', text: result }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Apifox Extra MCP server failed to start:', err);
  process.exit(1);
});
