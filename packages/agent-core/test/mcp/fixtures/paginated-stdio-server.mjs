import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'paginated-stdio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
  if (params?.cursor === undefined) {
    return {
      tools: [
        {
          name: 'page_one',
          description: 'First page',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      nextCursor: 'page-2',
    };
  }
  return {
    tools: [
      {
        name: 'page_two',
        description: 'Second page',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
