/**
 * Memory MCP Server — stdio-based MCP server exposing memory tools.
 *
 * Spawned by Claude Code as a child process via .mcp.json configuration.
 * Each Claude Code subprocess gets its own instance.
 *
 * Environment variables:
 * - NEOCLAW_MEMORY_DIR: path to the memory directory (default: ~/.neoclaw/memory)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KNOWLEDGE_TOPICS, MemoryManager } from './manager.js';
import { MemoryStore } from './store.js';

const memoryDir = process.env['NEOCLAW_MEMORY_DIR'] ?? join(homedir(), '.neoclaw', 'memory');
const store = new MemoryStore(join(memoryDir, 'index.sqlite'));
const manager = new MemoryManager(memoryDir, store);
manager.reindex();

const server = new Server(
  { name: 'neoclaw-memory', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_read',
      description:
        'Read the full content of a specific memory entry by id. Use memory_list to discover available ids.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description:
              'Memory entry id (file name without .md extension, e.g. "SOUL", "owner-profile", "preferences")',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_search',
      description: 'Search through stored memories (identity, knowledge base, and episode history)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query text' },
          category: {
            type: 'string',
            enum: ['identity', 'episode', 'knowledge'],
            description: 'Optional: filter by category',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_save',
      description:
        'Save information to memory. Use category="identity" to update identity/SOUL.md, or omit/use "knowledge" for the knowledge base.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: {
            type: 'string',
            enum: Object.keys(KNOWLEDGE_TOPICS),
            description:
              'Fixed knowledge slot (required for knowledge, ignored for identity): owner-profile (personal info), preferences (habits/workflow), people (contacts), projects (tech decisions), notes (misc)',
          },
          content: { type: 'string', description: 'Markdown content to save' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization',
          },
          category: {
            type: 'string',
            enum: ['identity', 'knowledge'],
            description:
              'Target category. "identity" writes identity/SOUL.md, "knowledge" (default) writes to knowledge/',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_list',
      description: 'List all stored memory entries',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            enum: ['identity', 'episode', 'knowledge'],
            description: 'Optional: filter by category',
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
    case 'memory_read':
      result = await manager.handleRead(args ?? {});
      break;
    case 'memory_search':
      result = await manager.handleSearch(args ?? {});
      break;
    case 'memory_save':
      result = await manager.handleSave(args ?? {});
      break;
    case 'memory_list':
      result = await manager.handleList(args ?? {});
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
  console.error('Memory MCP server failed to start:', err);
  process.exit(1);
});
