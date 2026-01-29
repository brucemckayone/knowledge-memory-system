/**
 * Continuous Benchmark Report Generator
 *
 * Generates HTML reports with time-series charts for long-running
 * continuous benchmarks. Shows system evolution over time.
 */

import type { ContinuousBenchmarkResults } from '../types/continuous.js';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Generate HTML report from continuous benchmark results
 */
export async function generateContinuousReport(results: ContinuousBenchmarkResults): Promise<void> {
  const reportsDir = path.join(process.cwd(), 'benchmark-reports');
  await fs.mkdir(reportsDir, { recursive: true });

  // Generate HTML
  const html = await generateContinuousHTML(results);

  // Write report
  const filename = `${results.runId}.html`;
  const filepath = path.join(reportsDir, filename);

  await fs.writeFile(filepath, html);

  // Create symlink to latest continuous
  const latestPath = path.join(reportsDir, 'latest-continuous.html');
  try {
    await fs.unlink(latestPath);
  } catch {
    // File doesn't exist, that's fine
  }
  await fs.symlink(filename, latestPath);

  console.log(`📄 Continuous report generated: ${filepath}`);
}

/**
 * Generate continuous benchmark HTML
 */
async function generateContinuousHTML(results: ContinuousBenchmarkResults): Promise<string> {
  const {
    runId,
    startTime,
    endTime,
    config,
    checkpoints,
    totalMessages,
    finalMetrics,
    timeSeries,
  } = results;

  // Calculate statistics
  const duration = endTime.getTime() - startTime.getTime();
  const durationMin = Math.floor(duration / 60000);
  const durationSec = Math.floor((duration % 60000) / 1000);

  // Get data for charts
  const timestamps = timeSeries.timestamps.map(t => {
    const elapsed = Math.floor((t.getTime() - startTime.getTime()) / 60000);
    return `${elapsed}m`;
  });

  const entityCounts = timeSeries.entityCounts;
  const factCounts = timeSeries.factCounts;
  const taskCounts = timeSeries.taskCounts;
  const f1Scores = timeSeries.f1Scores;

  // Calculate growth rates
  const entityGrowth = calculateGrowthRate(entityCounts);
  const factGrowth = calculateGrowthRate(factCounts);
  const taskGrowth = calculateGrowthRate(taskCounts);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Continuous Benchmark Report - ${runId}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    .header {
      background: white;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    h1 {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #0f172a;
    }

    .subtitle {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 20px;
    }

    .run-id {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      background: #f1f5f9;
      padding: 4px 12px;
      border-radius: 6px;
      color: #475569;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 20px;
    }

    .summary-item {
      background: #f8fafc;
      padding: 16px;
      border-radius: 8px;
    }

    .summary-label {
      font-size: 12px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .summary-value {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin-top: 4px;
    }

    .section {
      background: white;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    h2 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 20px;
      color: #0f172a;
    }

    .chart-container {
      position: relative;
      height: 400px;
      margin-bottom: 24px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: #f8fafc;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #3b82f6;
    }

    .stat-card.growth {
      border-left-color: #22c55e;
    }

    .stat-card.quality {
      border-left-color: #8b5cf6;
    }

    .stat-label {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: #0f172a;
    }

    .stat-delta {
      font-size: 14px;
      color: #22c55e;
      margin-top: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }

    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e2e8f0;
    }

    th {
      font-size: 12px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    td {
      font-size: 14px;
    }

    tr:last-child td {
      border-bottom: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Continuous Benchmark Report</h1>
      <div class="subtitle">
        <span class="run-id">${runId}</span>
      </div>

      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">Duration</div>
          <div class="summary-value">${durationMin}m ${durationSec}s</div>
        </div>

        <div class="summary-item">
          <div class="summary-label">Messages Injected</div>
          <div class="summary-value">${totalMessages.toLocaleString()}</div>
        </div>

        <div class="summary-item">
          <div class="summary-label">Checkpoints</div>
          <div class="summary-value">${checkpoints.length}</div>
        </div>

        <div class="summary-item">
          <div class="summary-label">Injection Rate</div>
          <div class="summary-value">${config.injectionRate} msg/min</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Knowledge Growth Over Time</h2>
      <div class="chart-container">
        <canvas id="growthChart"></canvas>
      </div>
    </div>

    <div class="section">
      <h2>Final Metrics</h2>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Entities</div>
          <div class="stat-value">${finalMetrics.entityCount.toLocaleString()}</div>
          <div class="stat-delta">+${entityGrowth.toFixed(1)}% avg growth</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total Facts</div>
          <div class="stat-value">${finalMetrics.factCount.toLocaleString()}</div>
          <div class="stat-delta">+${factGrowth.toFixed(1)}% avg growth</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total Tasks</div>
          <div class="stat-value">${finalMetrics.taskCount.toLocaleString()}</div>
          <div class="stat-delta">+${taskGrowth.toFixed(1)}% avg growth</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total Memories</div>
          <div class="stat-value">${finalMetrics.memoryCount.toLocaleString()}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Quality Evolution</h2>
      <div class="chart-container">
        <canvas id="qualityChart"></canvas>
      </div>
    </div>

    <div class="section">
      <h2>Checkpoint Details</h2>
      <table>
        <thead>
          <tr>
            <th>Checkpoint</th>
            <th>Elapsed</th>
            <th>Entities</th>
            <th>Facts</th>
            <th>Tasks</th>
            <th>Queue Depth</th>
            <th>Throughput</th>
          </tr>
        </thead>
        <tbody>
          ${checkpoints.map((cp, index) => {
            const elapsed = Math.floor(cp.elapsedMs / 60000);
            const throughput = cp.performance.throughput.toFixed(2);
            return `
              <tr>
                <td>#${index + 1}</td>
                <td>${elapsed}m</td>
                <td>${cp.metrics.entityCount}</td>
                <td>${cp.metrics.factCount}</td>
                <td>${cp.metrics.taskCount}</td>
                <td>${cp.performance.queueDepth}</td>
                <td>${throughput} msg/s</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Configuration</h2>
      <table>
        <tbody>
          <tr>
            <th>Scenario</th>
            <td>${config.scenario || 'default'}</td>
          </tr>
          <tr>
            <th>Duration</th>
            <td>${config.duration}</td>
          </tr>
          <tr>
            <th>Injection Rate</th>
            <td>${config.injectionRate} messages/minute</td>
          </tr>
          <tr>
            <th>Checkpoint Interval</th>
            <td>${config.checkpointInterval}</td>
          </tr>
          <tr>
            <th>Dashboard Enabled</th>
            <td>${config.enableDashboard ? 'Yes' : 'No'}</td>
          </tr>
          <tr>
            <th>Max Messages</th>
            <td>${config.maxMessages || 'Unlimited'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    // Growth chart
    new Chart(document.getElementById('growthChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(timestamps)},
        datasets: [
          {
            label: 'Entities',
            data: ${JSON.stringify(entityCounts)},
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.4
          },
          {
            label: 'Facts',
            data: ${JSON.stringify(factCounts)},
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            fill: true,
            tension: 0.4
          },
          {
            label: 'Tasks',
            data: ${JSON.stringify(taskCounts)},
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            fill: true,
            tension: 0.4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
          },
          title: {
            display: true,
            text: 'Knowledge Base Growth'
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Count'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Elapsed Time'
            }
          }
        }
      }
    });

    // Quality chart
    new Chart(document.getElementById('qualityChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(timestamps)},
        datasets: [
          {
            label: 'F1 Score',
            data: ${JSON.stringify(f1Scores)},
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.1)',
            fill: true,
            tension: 0.4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
          },
          title: {
            display: true,
            text: 'Quality Score Evolution'
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 1,
            title: {
              display: true,
              text: 'F1 Score'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Elapsed Time'
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Calculate average growth rate
 */
function calculateGrowthRate(values: number[]): number {
  if (values.length < 2) return 0;

  let totalGrowth = 0;
  let periods = 0;

  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];

    if (prev > 0) {
      const growth = ((curr - prev) / prev) * 100;
      totalGrowth += growth;
      periods++;
    }
  }

  return periods > 0 ? totalGrowth / periods : 0;
}
