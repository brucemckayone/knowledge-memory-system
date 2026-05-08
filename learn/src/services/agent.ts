/**
 * Claude Code CLI invocation helper.
 * TypeScript port of ml-services/app/core/llm.py ClaudeCodeProvider.
 */

import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Find the absolute path to the `claude` executable.
 * On Windows, spawn can't auto-resolve `.cmd`/`.exe` shims without shell:true,
 * but using shell:true makes prompt arg escaping fragile. So we resolve once
 * and invoke the absolute path directly.
 */
let _claudePath: string | null = null;
function getClaudePath(): string {
  if (_claudePath) return _claudePath;

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where claude' : 'which claude';
  try {
    const out = execSync(cmd, { encoding: 'utf-8' }).trim();
    // Windows `where` may return multiple lines; pick the first .exe if available
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exeFirst = lines.find(p => p.toLowerCase().endsWith('.exe')) ?? lines[0];
    if (!exeFirst || !existsSync(exeFirst)) {
      throw new Error(`Resolved path does not exist: ${exeFirst}`);
    }
    _claudePath = exeFirst;
    return _claudePath;
  } catch (err) {
    throw new Error(`Could not resolve 'claude' on PATH. Install Claude Code CLI from https://claude.ai/code. (${err instanceof Error ? err.message : err})`);
  }
}

export type AgentModel = 'haiku' | 'sonnet' | 'opus';
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentOptions {
  model?: AgentModel;
  effort?: AgentEffort;
  systemPrompt?: string;
  mcpConfigPath?: string;
  mcpServerName?: string;
  maxTurns?: number;
  timeoutMs?: number;
  tools?: 'none' | 'mcp' | string;
}

export interface AgentResult {
  result: string;
  cost?: Record<string, unknown>;
  numTurns?: number;
}

/**
 * Tools that the helper recognises as web tools and forwards to the Claude
 * CLI's `--tools` flag. Anything else passed via `tools` falls through as a
 * bare string (forward-compat).
 */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

/**
 * Parse a `tools` option into a CLI-friendly shape:
 *   - `webTools`: comma-joined web tool names to pass to `--tools`, or null when empty.
 *   - `wantsMcp`:  whether the option opts into MCP tools (separate `--mcp-config` plumbing).
 *   - `passthrough`: when the option is none of the recognised forms, the raw string
 *                    is passed through to `--tools` as-is.
 *
 * Recognised forms:
 *   - 'none'                     → no web tools, no MCP
 *   - 'mcp'                      → MCP only, no `--tools`
 *   - 'WebSearch'                → web tool only
 *   - 'WebSearch,WebFetch'       → both web tools
 *   - 'WebSearch,WebFetch,mcp'   → both web tools + MCP
 *   - other                      → passed through verbatim to `--tools`
 */
export function parseToolsOption(tools: string | undefined): {
  webTools: string | null;
  wantsMcp: boolean;
  passthrough: string | null;
} {
  const raw = tools ?? 'none';
  if (raw === 'none') return { webTools: null, wantsMcp: false, passthrough: null };
  if (raw === 'mcp')  return { webTools: null, wantsMcp: true, passthrough: null };

  if (raw.includes(',') || WEB_TOOLS.has(raw)) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const wantsMcp = parts.includes('mcp');
    const webParts = parts.filter((p) => WEB_TOOLS.has(p));
    const webTools = webParts.length > 0 ? webParts.join(',') : null;
    // Reject if the only thing left after we extract web tools + 'mcp' is unknown.
    const known = new Set([...WEB_TOOLS, 'mcp']);
    const unknown = parts.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      // Unknown tokens — fall through to passthrough so callers can use raw CLI shapes.
      return { webTools: null, wantsMcp: false, passthrough: raw };
    }
    return { webTools, wantsMcp, passthrough: null };
  }
  // Bare unknown string: treat as raw `--tools` value.
  return { webTools: null, wantsMcp: false, passthrough: raw };
}

export function buildArgs(prompt: string, opts: AgentOptions, systemPromptFile?: string): string[] {
  const model = opts.model ?? 'haiku';
  const effort = opts.effort ?? 'low';

  const cmd: string[] = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    '--no-session-persistence',
  ];

  if (systemPromptFile) {
    cmd.push('--system-prompt-file', systemPromptFile);
  }

  const { webTools, wantsMcp, passthrough } = parseToolsOption(opts.tools);

  // Tools handling: webTools and MCP are independent — both can coexist.
  if (webTools) {
    cmd.push('--tools', webTools);
  } else if (passthrough !== null) {
    cmd.push('--tools', passthrough);
  } else if (!wantsMcp) {
    // 'none' — explicitly empty.
    cmd.push('--tools', '');
  }
  // else: 'mcp' alone — let `--mcp-config` handle it without `--tools`.

  if (opts.mcpConfigPath) {
    const serverName = opts.mcpServerName ?? 'learn';
    cmd.push(
      '--mcp-config', opts.mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', `mcp__${serverName}__*`,
    );
  }

  cmd.push('--max-turns', String(opts.maxTurns ?? (opts.mcpConfigPath ? 20 : 1)));

  return cmd;
}

export async function runAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  let systemPromptFile: string | undefined;
  if (opts.systemPrompt) {
    systemPromptFile = join(tmpdir(), `learn-agent-prompt-${randomUUID()}.txt`);
    writeFileSync(systemPromptFile, opts.systemPrompt, 'utf-8');
  }

  const args = buildArgs(prompt, opts, systemPromptFile);
  const claudePath = getClaudePath();

  return new Promise((resolve, reject) => {
    // Use absolute path to claude.exe (or POSIX claude). No shell, no quoting issues.
    // Args go to the process verbatim — quotes inside the prompt are preserved.
    const proc = spawn(claudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (systemPromptFile) {
        try { unlinkSync(systemPromptFile); } catch { /* ignore */ }
      }

      if (code !== 0) {
        return reject(new Error(`Claude CLI exited ${code}: ${stderr.slice(0, 400)}`));
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        data = { result: stdout.trim() };
      }

      resolve({
        result: (data.result as string) ?? '',
        cost: data.cost as Record<string, unknown> | undefined,
        numTurns: typeof data.num_turns === 'number' ? data.num_turns : undefined,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/** Write a temporary MCP config JSON and return its path. */
export function writeMcpConfig(
  serverName: string,
  scriptPath: string,
  env: Record<string, string> = {},
): string {
  const configPath = join(tmpdir(), `learn-mcp-config-${randomUUID()}.json`);
  const config = {
    mcpServers: {
      [serverName]: {
        command: 'npx',
        args: ['tsx', scriptPath],
        env,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}
