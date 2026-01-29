/**
 * Benchmark Dashboard Server
 *
 * Provides real-time monitoring of continuous benchmarks via web interface.
 * Uses Express for HTTP server and WebSocket for live updates.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardOptions {
  /** Port to listen on */
  port: number;

  /** Run ID to monitor */
  runId: string;
}

export interface DashboardState {
  runId: string;
  startTime: Date;
  currentCheckpoint?: any;
  messagesInjected: number;
  checkpointsCollected: number;
  isRunning: boolean;
}

/**
 * Start dashboard server
 */
export async function startDashboard(options: DashboardOptions): Promise<{
  server: http.Server;
  wss: WebSocketServer;
  app: express.Express;
}> {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Dashboard state
  const state: DashboardState = {
    runId: options.runId,
    startTime: new Date(),
    messagesInjected: 0,
    checkpointsCollected: 0,
    isRunning: true,
  };

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  // API endpoint: Get current state
  app.get('/api/state', (req, res) => {
    res.json(state);
  });

  // API endpoint: Get checkpoint history
  app.get('/api/checkpoints', async (req, res) => {
    try {
      const { loadCheckpoints } = await import('../monitor.js');
      const checkpoints = await loadCheckpoints(options.runId);
      res.json(checkpoints);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load checkpoints' });
    }
  });

  // WebSocket connection handler
  wss.on('connection', (ws: WebSocket) => {
    console.log('📊 Dashboard client connected');

    // Send current state on connection
    ws.send(JSON.stringify({
      type: 'state',
      data: state,
    }));

    // Handle incoming messages (if needed)
    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message);
        // Handle client messages here
      } catch (error) {
        console.error('Invalid WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      console.log('📊 Dashboard client disconnected');
    });
  });

  // Broadcast state update to all connected clients
  function broadcastState() {
    const message = JSON.stringify({
      type: 'state',
      data: state,
    });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Broadcast checkpoint update
  function broadcastCheckpoint(checkpoint: any) {
    const message = JSON.stringify({
      type: 'checkpoint',
      data: checkpoint,
    });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Start server
  server.listen(options.port, () => {
    console.log(`🖥️  Dashboard server listening on http://localhost:${options.port}`);
    console.log(`📊 Monitoring run: ${options.runId}`);
  });

  // Return server instance with update methods
  return {
    server,
    wss,
    app,
  };
}

/**
 * Update dashboard with new checkpoint
 */
export function updateDashboard(
  server: { wss: WebSocketServer },
  checkpoint: any
): void {
  const message = JSON.stringify({
    type: 'checkpoint',
    data: checkpoint,
  });

  server.wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/**
 * Stop dashboard server
 */
export async function stopDashboard(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      console.log('🖥️  Dashboard server stopped');
      resolve();
    });
  });
}
