/**
 * MCP Resources (W41)
 *
 * Defines read-only resources that Claude Code can access.
 */

import type { MnemoClient } from './mnemo-client.js';

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: (client: MnemoClient) => Promise<string>;
}

export const resources: ResourceDefinition[] = [
  {
    uri: 'mnemo://briefing/latest',
    name: 'Latest Briefing',
    description: 'The most recent morning briefing',
    mimeType: 'application/json',
    handler: async (client) => {
      const briefing = await client.getBriefing();
      return JSON.stringify(briefing, null, 2);
    },
  },
  {
    uri: 'mnemo://insights/active',
    name: 'Active Insights',
    description: 'Currently active AI-generated insights',
    mimeType: 'application/json',
    handler: async (client) => {
      const insights = await client.getInsights(20);
      return JSON.stringify(insights, null, 2);
    },
  },
];
