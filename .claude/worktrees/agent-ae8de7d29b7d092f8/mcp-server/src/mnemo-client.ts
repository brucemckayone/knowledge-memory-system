/**
 * Mnemo API Client (W41)
 *
 * HTTP client for communicating with the Mnemo platform API.
 */

export interface MnemoClientConfig {
  baseUrl: string;
  apiKey?: string;
}

export class MnemoClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: MnemoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async search(query: string, limit = 10): Promise<unknown> {
    const url = `${this.baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
    return resp.json();
  }

  async hybridSearch(query: string, limit = 10): Promise<unknown> {
    const url = `${this.baseUrl}/api/hybrid-search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Hybrid search failed: ${resp.status}`);
    return resp.json();
  }

  async ingest(content: string, options: { contentType?: string; metadata?: Record<string, unknown> } = {}): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}/api/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        content,
        contentType: options.contentType || 'text',
        source: 'mcp-server',
        metadata: options.metadata,
      }),
    });
    if (!resp.ok) throw new Error(`Ingest failed: ${resp.status}`);
    return resp.json();
  }

  async getEntities(query: string, limit = 10): Promise<unknown> {
    const url = `${this.baseUrl}/api/entities?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Entity search failed: ${resp.status}`);
    return resp.json();
  }

  async getFacts(query: string, limit = 10): Promise<unknown> {
    const url = `${this.baseUrl}/api/facts?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Facts search failed: ${resp.status}`);
    return resp.json();
  }

  async getInsights(limit = 10): Promise<unknown> {
    const url = `${this.baseUrl}/api/insights?limit=${limit}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Insights fetch failed: ${resp.status}`);
    return resp.json();
  }

  async getBriefing(): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}/api/briefing`, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Briefing fetch failed: ${resp.status}`);
    return resp.json();
  }

  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`);
      return resp.ok;
    } catch {
      return false;
    }
  }
}
