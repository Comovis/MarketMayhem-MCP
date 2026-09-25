#!/usr/bin/env node
/** `npx @marketmayhem/mcp` — the server on stdio, for Claude, Cursor and any MCP client. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const server = await createServer();
await server.connect(new StdioServerTransport());
