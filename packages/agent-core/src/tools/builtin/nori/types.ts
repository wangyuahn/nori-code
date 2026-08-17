/** Provider interfaces for nori tools - injected via AgentOptions. */

export interface NoriMemoryNote {
  title: string;
  path: string;
  score?: number;
  excerpt?: string;
  content?: string;
}

export interface NoriMemoryProvider {
  multiRetrieve(
    keywords: string[],
    options?: {
      top_k?: number;
      type_filter?: string[];
      weights?: { embedding: number; fulltext: number; graph: number };
      link_depth?: number;
    },
  ): Promise<NoriMemoryNote[]>;
  writeNote(params: {
    note_type: string;
    title: string;
    content: string;
    links?: string[];
    tags?: string[];
  }): Promise<{ path: string }>;
  removeNote(title: string): Promise<boolean>;
}

export interface NoriSwarmProvider {
  launchDag(
    templateName: string,
    params: Record<string, unknown>,
    depth: number,
  ): Promise<{ swarm_id: string }>;
  getStatus(swarmId: string): Promise<{
    status: string;
    results?: Record<string, unknown>;
  }>;
  getResult(swarmId: string): Promise<{
    status: string;
    task_results: Record<string, { status: string; output?: { analysis_summary?: string } }>;
  }>;
}
