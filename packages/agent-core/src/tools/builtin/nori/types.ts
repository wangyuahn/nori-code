/** Provider interfaces for nori tools - injected via AgentOptions. */

export interface NoriMemoryNote {
  title: string;
  path: string;
  score?: number;
  excerpt?: string;
  content?: string;
  /** Write/create instant as ISO-8601 UTC from note frontmatter. */
  created_at?: string;
  /** Last edit instant as ISO-8601 UTC from frontmatter or file mtime. */
  updated_at?: string;
  /** UTC calendar date (`YYYY-MM-DD`) when only legacy date metadata exists. */
  date?: string;
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
