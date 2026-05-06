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
export type AgentEffort = 'low' | 'medium' | 'high';

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
}

function buildArgs(prompt: string, opts: AgentOptions, systemPromptFile?: string): string[] {
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

  const tools = opts.tools ?? 'none';
  if (tools === 'mcp') {
    // MCP tools come via --mcp-config; don't pass --tools
  } else if (tools === 'none') {
    cmd.push('--tools', '');
  } else {
    cmd.push('--tools', tools);
  }

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
