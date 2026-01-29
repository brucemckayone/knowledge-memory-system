/**
 * HTML Report Generator
 *
 * Generates HTML dashboard with benchmark results, visualizations,
 * and historical comparisons.
 */

import type { BenchmarkRun } from '../orchestrator.js';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Generate HTML report from benchmark results
 */
export async function generateReport(results?: BenchmarkRun): Promise<void> {
  const reportsDir = path.join(process.cwd(), 'benchmark-reports');
  await fs.mkdir(reportsDir, { recursive: true });

  // Load historical data if available
  const history = await loadHistory();

  // If no results provided, use the most recent run
  const run = results || history[history.length - 1];

  if (!run) {
    console.log('⚠️ No benchmark results found. Run a benchmark first.');
    return;
  }

  // Generate HTML
  const html = await generateDashboardHTML(run, history);

  // Write report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `report-${timestamp}.html`;
  const filepath = path.join(reportsDir, filename);

  await fs.writeFile(filepath, html);

  // Create symlink to latest
  const latestPath = path.join(reportsDir, 'latest.html');
  try {
    await fs.unlink(latestPath);
  } catch {
    // File doesn't exist, that's fine
  }
  await fs.symlink(filename, latestPath);

  console.log(`📄 Report generated: ${filepath}`);
}

/**
 * Load historical benchmark results
 */
async function loadHistory(): Promise<BenchmarkRun[]> {
  const historyDir = path.join(process.cwd(), '.benchmark-history');

  try {
    await fs.access(historyDir);
  } catch {
    // Directory doesn't exist
    return [];
  }

  const files = await fs.readdir(historyDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const runs: BenchmarkRun[] = [];
  for (const file of jsonFiles) {
    try {
      const filepath = path.join(historyDir, file);
      const content = await fs.readFile(filepath, 'utf-8');
      const run = JSON.parse(content) as BenchmarkRun;
      runs.push(run);
    } catch (error) {
      console.warn(`⚠️ Failed to load history file ${file}:`, error);
    }
  }

  // Sort by timestamp
  runs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return runs;
}

/**
 * Generate dashboard HTML
 */
async function generateDashboardHTML(
  current: BenchmarkRun,
  history: BenchmarkRun[]
): Promise<string> {
  const lastRun = history.length > 1 ? history[history.length - 2] : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Benchmark Report - ${current.runId}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }

    .header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
    }

    .header p {
      opacity: 0.9;
      font-size: 1.1em;
    }

    .content {
      padding: 30px;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .metric-card {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      padding: 25px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .metric-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 5px 20px rgba(0, 0, 0, 0.15);
    }

    .metric-card h3 {
      color: #2d3748;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }

    .metric-card .value {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
      margin-bottom: 5px;
    }

    .metric-card .trend {
      font-size: 0.9em;
      color: #718096;
    }

    .trend.positive { color: #48bb78; }
    .trend.negative { color: #f56565; }

    .section {
      margin-bottom: 40px;
    }

    .section h2 {
      color: #2d3748;
      margin-bottom: 20px;
      font-size: 1.8em;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }

    .chart-container {
      background: #f7fafc;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }

    table th,
    table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e2e8f0;
    }

    table th {
      background: #f7fafc;
      font-weight: 600;
      color: #2d3748;
    }

    table tr:hover {
      background: #f7fafc;
    }

    .score {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 0.9em;
    }

    .score.high { background: #c6f6d5; color: #22543d; }
    .score.medium { background: #fefcbf; color: #744210; }
    .score.low { background: #fed7d7; color: #742a2a; }

    .footer {
      text-align: center;
      padding: 20px;
      color: #718096;
      font-size: 0.9em;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 E2E Benchmark Report</h1>
      <p>Run ID: ${current.runId}</p>
      <p>Generated: ${new Date().toLocaleString()}</p>
    </div>

    <div class="content">
      <!-- Overview Metrics -->
      <div class="section">
        <h2>Overview</h2>
        <div class="metrics-grid">
          <div class="metric-card">
            <h3>Messages Processed</h3>
            <div class="value">${current.metrics.totalMessages}</div>
            <div class="trend">${(current.metrics.totalMessages / (current.metrics.totalProcessingTime / 1000)).toFixed(1)} msg/sec</div>
          </div>

          <div class="metric-card">
            <h3>Overall F1 Score</h3>
            <div class="value">${current.metrics.f1Score.toFixed(3)}</div>
            ${lastRun ? `<div class="trend ${current.metrics.f1Score >= lastRun.metrics.f1Score ? 'positive' : 'negative'}">
              ${current.metrics.f1Score >= lastRun.metrics.f1Score ? '▲' : '▼'} ${Math.abs((current.metrics.f1Score - lastRun.metrics.f1Score) * 100).toFixed(2)}%
            </div>` : '<div class="trend">First run</div>'}
          </div>

          <div class="metric-card">
            <h3>Entities Extracted</h3>
            <div class="value">${current.metrics.entityCount}</div>
            <div class="trend">${current.metrics.totalMessages > 0 ? (current.metrics.entityCount / current.metrics.totalMessages).toFixed(2) + ' per message' : ''}</div>
          </div>

          <div class="metric-card">
            <h3>Facts Extracted</h3>
            <div class="value">${current.metrics.factCount}</div>
            <div class="trend">${current.metrics.totalMessages > 0 ? (current.metrics.factCount / current.metrics.totalMessages).toFixed(2) + ' per message' : ''}</div>
          </div>

          <div class="metric-card">
            <h3>Tasks Created</h3>
            <div class="value">${current.metrics.taskCount}</div>
            <div class="trend">${current.metrics.totalMessages > 0 ? (current.metrics.taskCount / current.metrics.totalMessages).toFixed(2) + ' per message' : ''}</div>
          </div>

          <div class="metric-card">
            <h3>Processing Time</h3>
            <div class="value">${(current.metrics.totalProcessingTime / 1000).toFixed(1)}s</div>
            <div class="trend">${current.metrics.avgProcessingTime.toFixed(0)}ms avg</div>
          </div>
        </div>
      </div>

      <!-- Validation Scores -->
      <div class="section">
        <h2>Validation Scores</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>F1 Score</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>📚 Entity Extraction</td>
              <td>${current.validation.entities.precision.toFixed(3)}</td>
              <td>${current.validation.entities.recall.toFixed(3)}</td>
              <td>${current.validation.entities.f1Score.toFixed(3)}</td>
              <td><span class="score ${getScoreClass(current.validation.entities.f1Score)}">${getScoreLabel(current.validation.entities.f1Score)}</span></td>
            </tr>
            <tr>
              <td>🔗 Fact Extraction</td>
              <td>${current.validation.facts.precision.toFixed(3)}</td>
              <td>${current.validation.facts.recall.toFixed(3)}</td>
              <td>${current.validation.facts.f1Score.toFixed(3)}</td>
              <td><span class="score ${getScoreClass(current.validation.facts.f1Score)}">${getScoreLabel(current.validation.facts.f1Score)}</span></td>
            </tr>
            <tr>
              <td>📋 Task Extraction</td>
              <td>${current.validation.tasks.precision.toFixed(3)}</td>
              <td>${current.validation.tasks.recall.toFixed(3)}</td>
              <td>${current.validation.tasks.f1Score.toFixed(3)}</td>
              <td><span class="score ${getScoreClass(current.validation.tasks.f1Score)}">${getScoreLabel(current.validation.tasks.f1Score)}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      ${history.length > 1 ? generateHistoricalTrends(history) : ''}

      <!-- Configuration -->
      <div class="section">
        <h2>Configuration</h2>
        <table>
          <tbody>
            <tr>
              <td><strong>Scenario</strong></td>
              <td>${current.config.scenario || 'default'}</td>
            </tr>
            <tr>
              <td><strong>Scale</strong></td>
              <td>${current.config.scale || 'medium'}</td>
            </tr>
            <tr>
              <td><strong>Timespan</strong></td>
              <td>${current.config.timespan || '1month'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="footer">
      <p>Generated by Knowledge Memory System Benchmark Tool</p>
      <p>Run ${current.runId} • ${new Date(current.timestamp).toLocaleString()}</p>
    </div>
  </div>

  ${history.length > 1 ? generateChartScript(history) : ''}
</body>
</html>`;
}

/**
 * Get score CSS class
 */
function getScoreClass(score: number): string {
  if (score >= 0.8) return 'high';
  if (score >= 0.6) return 'medium';
  return 'low';
}

/**
 * Get score label
 */
function getScoreLabel(score: number): string {
  if (score >= 0.8) return 'Excellent';
  if (score >= 0.6) return 'Good';
  if (score >= 0.4) return 'Fair';
  return 'Poor';
}

/**
 * Generate historical trends section
 */
function generateHistoricalTrends(history: BenchmarkRun[]): string {
  return `
  <div class="section">
    <h2>Historical Trends (Last ${Math.min(10, history.length)} Runs)</h2>
    <div class="chart-container">
      <canvas id="f1TrendChart"></canvas>
    </div>
    <div class="chart-container">
      <canvas id="performanceTrendChart"></canvas>
    </div>
  </div>`;
}

/**
 * Generate Chart.js initialization script
 */
function generateChartScript(history: BenchmarkRun[]): string {
  const recent = history.slice(-10); // Last 10 runs
  const labels = recent.map(r => new Date(r.timestamp).toLocaleDateString());
  const f1Scores = recent.map(r => r.metrics.f1Score);
  const entityF1 = recent.map(r => r.validation.entities.f1Score);
  const factF1 = recent.map(r => r.validation.facts.f1Score);
  const processingTimes = recent.map(r => r.metrics.totalProcessingTime / 1000);

  return `
<script>
  // F1 Score Trend Chart
  new Chart(document.getElementById('f1TrendChart'), {
    type: 'line',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [
        {
          label: 'Overall F1',
          data: ${JSON.stringify(f1Scores)},
          borderColor: '#667eea',
          backgroundColor: 'rgba(102, 126, 234, 0.1)',
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Entity F1',
          data: ${JSON.stringify(entityF1)},
          borderColor: '#48bb78',
          backgroundColor: 'rgba(72, 187, 120, 0.1)',
          tension: 0.3,
          fill: false,
        },
        {
          label: 'Fact F1',
          data: ${JSON.stringify(factF1)},
          borderColor: '#ed8936',
          backgroundColor: 'rgba(237, 137, 54, 0.1)',
          tension: 0.3,
          fill: false,
        },
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: 'F1 Score Over Time'
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 1,
        }
      }
    }
  });

  // Processing Time Chart
  new Chart(document.getElementById('performanceTrendChart'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [{
        label: 'Processing Time (s)',
        data: ${JSON.stringify(processingTimes)},
        backgroundColor: 'rgba(102, 126, 234, 0.7)',
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: 'Processing Time Over Time'
        }
      },
      scales: {
        y: {
          beginAtZero: true,
        }
      }
    }
  });
</script>`;
}
