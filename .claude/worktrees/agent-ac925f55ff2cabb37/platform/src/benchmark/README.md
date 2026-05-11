# Continuous Benchmark System

A comprehensive benchmarking framework for testing long-running cognitive platform behavior with streaming message injection, real-time monitoring, and time-series analysis.

## 🎯 Problem Statement

Traditional benchmarks complete in seconds (batch processing), but real-world cognitive systems:
- Process messages continuously over hours/days
- Have gardener agents that refine knowledge periodically
- Evolve through multiple processing cycles
- Require observing long-term trends

This system enables testing continuous behavior in minutes instead of hours by accelerating gardener cycles while maintaining realistic system behavior.

## 🚀 Features

### 1. **Configurable Gardener Frequency**
Accelerate gardener cycles for faster testing:
```bash
# Default (production)
GARDENER_FREQUENT_INTERVAL=5m   # Summarizer, Evaluator
GARDENER_PERIODIC_INTERVAL=1h   # Schema Alignment, Conflict Resolution
GARDENER_DEEP_INTERVAL=24h      # Community Detection, Insight Generation

# Fast development (60x acceleration)
GARDENER_FREQUENT_INTERVAL=5s
GARDENER_PERIODIC_INTERVAL=1m
GARDENER_DEEP_INTERVAL=10m
```

### 2. **Continuous Benchmark Mode**
- Long-running execution (minutes to days)
- Streaming message injection over time
- Periodic checkpoint collection
- Graceful shutdown support

### 3. **Real-Time Web Dashboard**
- Live metrics via WebSocket
- Chart.js time-series visualizations
- Entity/Fact/Task growth tracking
- Queue depth and throughput monitoring
- Auto-reconnection on disconnect

### 4. **Enhanced HTML Reports**
- Time-series charts showing system evolution
- Growth rate calculations
- Quality evolution (F1 scores over time)
- Detailed checkpoint comparison tables
- Gardener agent impact analysis

## 📦 Installation

```bash
# Install dependencies
pnpm install

# Or install specific new dependencies
pnpm add express ws
pnpm add -D @types/express @types/ws
```

## 🎮 Quick Start

### Basic Continuous Benchmark

```bash
# Run a 30-minute continuous benchmark
pnpm run benchmark:continuous

# View the report
open benchmark-reports/latest-continuous.html
```

### With Accelerated Gardener

```bash
# Fast development cycle (30s frequent, 2m periodic)
pnpm run benchmark:continuous:fast

# Or manually
GARDENER_FREQUENT_INTERVAL=30s \
GARDENER_PERIODIC_INTERVAL=2m \
pnpm run benchmark --mode continuous --duration 30m
```

### With Live Dashboard

```bash
# Start benchmark with web dashboard at http://localhost:3001
pnpm run benchmark:continuous:dashboard

# Or custom configuration
pnpm run benchmark \
  --mode continuous \
  --duration 1h \
  --dashboard \
  --dashboard-port 3001
```

## 📖 Usage

### Command-Line Options

#### Batch Mode (Default)

```bash
pnpm run benchmark [options]

Options:
  --scenario <name>     Run specific scenario
  --scale <size>        Dataset scale: light|medium|heavy
  --timespan <period>   Temporal distribution: 1week|1month|3months|6months
  --volume <count>      Custom message count
```

#### Continuous Mode

```bash
pnpm run benchmark --mode continuous [options]

Options:
  --mode <batch|continuous>  Benchmark mode (default: batch)
  --duration <time>         Run duration: 30m, 2h, 24h, 2d
  --injection-rate <n>      Messages per minute (default: 10)
  --checkpoint <time>       Checkpoint interval: 5m, 15m, 1h (default: 15m)
  --dashboard               Enable web dashboard
  --dashboard-port <n>      Dashboard port (default: 3001)
  --max-messages <n>        Maximum messages to inject
  --scenario <name>         Scenario to run
```

### Environment Variables

```bash
# Gardener Intervals
GARDENER_FREQUENT_INTERVAL=5m    # Summarizer, Evaluator
GARDENER_PERIODIC_INTERVAL=1h    # Schema Alignment, Conflict Resolution
GARDENER_DEEP_INTERVAL=24h       # Community Detection, Insight Generation

# Supported formats: 30s, 5m, 1h, 1d
# Automatically converts to cron expressions for pg-boss
```

### NPM Scripts

```json
{
  "benchmark": "tsx src/benchmark/index.ts",
  "benchmark:quality": "tsx src/benchmark/index.ts --scenario entity-extraction",
  "benchmark:stress": "tsx src/benchmark/index.ts --scale heavy",
  "benchmark:report": "tsx src/benchmark/index.ts --report-only",
  "benchmark:continuous": "tsx src/benchmark/index.ts --mode continuous --duration 30m",
  "benchmark:continuous:fast": "GARDENER_FREQUENT_INTERVAL=30s GARDENER_PERIODIC_INTERVAL=2m pnpm run benchmark:continuous",
  "benchmark:continuous:dashboard": "tsx src/benchmark/index.ts --mode continuous --duration 30m --dashboard"
}
```

## 📊 Examples

### 1. Quick Development Test (5 minutes)

```bash
GARDENER_FREQUENT_INTERVAL=30s \
GARDENER_PERIODIC_INTERVAL=1m \
pnpm run benchmark \
  --mode continuous \
  --duration 5m \
  --injection-rate 5 \
  --checkpoint 1m
```

**Result**: Multiple gardener cycles in 5 minutes, checkpoints every minute.

### 2. Medium Duration Test (2 hours)

```bash
pnpm run benchmark \
  --mode continuous \
  --duration 2h \
  --injection-rate 10 \
  --checkpoint 30m \
  --scenario fact-extraction
```

**Result**: Realistic testing over extended period, checkpoints every 30 minutes.

### 3. Stress Test with Dashboard

```bash
GARDENER_FREQUENT_INTERVAL=1m \
GARDENER_PERIODIC_INTERVAL=5m \
pnpm run benchmark \
  --mode continuous \
  --duration 4h \
  --injection-rate 100 \
  --checkpoint 15m \
  --dashboard
```

**Result**: High-volume test with live monitoring at http://localhost:3001.

### 4. Overnight Test

```bash
# Run in background with nohup
nohup pnpm run benchmark \
  --mode continuous \
  --duration 12h \
  --injection-rate 5 \
  --checkpoint 1h \
  > benchmark.log 2>&1 &

# Monitor progress
tail -f benchmark.log

# Check dashboard
open http://localhost:3001
```

### 5. Custom Scenario Testing

```bash
pnpm run benchmark \
  --mode continuous \
  --duration 1h \
  --scenario conflicts \
  --injection-rate 5 \
  --max-messages 100
```

## 📈 Output

### Files Generated

```
.benchmark-history/
├── continuous-2024-01-26-10-30-45-abc123.json    # Full results
└── continuous-2024-01-26-10-30-45-abc123/
    └── checkpoints/
        ├── checkpoint-2024-01-26T10-30-45.json  # Individual checkpoints
        ├── checkpoint-2024-01-26T10-45-45.json
        └── ...

benchmark-reports/
├── continuous-2024-01-26-10-30-45-abc123.html   # HTML report
└── latest-continuous.html                        # Symlink to latest
```

### HTML Report Features

- **Summary Section**: Duration, messages injected, checkpoints collected
- **Growth Chart**: Entity/Fact/Task counts over time
- **Quality Chart**: F1 score evolution
- **Metrics Cards**: Final counts with growth rates
- **Checkpoint Table**: Detailed metrics for each checkpoint
- **Configuration**: Test parameters and environment

### Dashboard Features

- **Real-Time Metrics**: Live updates via WebSocket
- **Growth Charts**: Entity/Fact/Task over time
- **Performance Charts**: Throughput and queue depth
- **Checkpoint History**: Last 10 checkpoints
- **Progress Bar**: Test completion percentage
- **Connection Status**: Auto-reconnect indicator

## 🔧 Architecture

### System Flow

```
┌─────────────────┐
│  CLI Start      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Parse Config   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Start Dashboard│ (optional)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Calculate      │
│  Injection      │
│  Schedule       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Main Loop:     │
│  - Inject batch │
│  - Wait for time│
│  - Collect      │
│    checkpoint   │
│  - Update       │
│    dashboard    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Generate Report│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Cleanup & Exit │
└─────────────────┘
```

### Key Components

- **`interval-parser.ts`**: Converts "30s", "5m" to cron expressions
- **`monitor.ts`**: Collects metrics at checkpoints
- **`modes/continuous.ts`**: Orchestrates long-running benchmarks
- **`dashboard/server.ts`**: Express + WebSocket server
- **`report/continuous-report.ts`**: HTML report generator

### Gardener Agents

| Tier        | Agents                  | Default  | Fast Test |
|-------------|-------------------------|----------|-----------|
| Frequent    | Summarizer, Evaluator   | 5m       | 30s       |
| Periodic    | Schema Align, Conflicts | 1h       | 2m        |
| Deep        | Community, Insights     | 3-4 AM   10m       |

## 🧪 Testing

### Verification Steps

1. **Install Dependencies**
   ```bash
   pnpm install
   ```

2. **Quick Smoke Test** (2 minutes)
   ```bash
   GARDENER_FREQUENT_INTERVAL=30s \
   GARDENER_PERIODIC_INTERVAL=1m \
   pnpm run benchmark \
     --mode continuous \
     --duration 2m \
     --injection-rate 5 \
     --checkpoint 30s
   ```

3. **Verify Gardener Acceleration**
   ```bash
   # Check logs for accelerated schedule
   grep "gardener:summarize" logs/
   # Should see runs every 30 seconds instead of 5 minutes
   ```

4. **Verify Dashboard**
   ```bash
   # Start with dashboard
   pnpm run benchmark --mode continuous --duration 5m --dashboard

   # Open browser
   open http://localhost:3001

   # Check for:
   # - Live metrics updates
   # - Growing charts
   # - Connection status "Connected"
   ```

5. **Verify Report**
   ```bash
   # After test completes
   ls -la benchmark-reports/
   open benchmark-reports/latest-continuous.html

   # Check for:
   # - Growth chart with data points
   # - Quality chart (if applicable)
   # - Checkpoint table with entries
   # - Growth rate percentages
   ```

### Expected Results

For a 5-minute test with accelerated gardener (30s frequent, 2m periodic):

```
✅ Continuous benchmark complete!
   Total duration: 5.0 minutes
   Messages injected: 50
   Checkpoints collected: 5
   Final entities: 15
   Final facts: 42
   Final tasks: 3
```

Dashboard should show:
- 5 checkpoints collected
- Entities/facts/tasks growing over time
- Live throughput metrics

Report should show:
- Growth chart with upward trends
- Checkpoint table with deltas
- Configuration summary

## 🎯 Use Cases

### 1. Development Iteration

Test changes quickly with accelerated cycles:

```bash
# 10-minute test with very fast gardener
GARDENER_FREQUENT_INTERVAL=15s \
GARDENER_PERIODIC_INTERVAL=1m \
pnpm run benchmark:continuous:fast
```

### 2. Regression Testing

Compare before/after with same configuration:

```bash
# Run baseline
pnpm run benchmark --mode continuous --duration 30m
mv benchmark-reports/latest-continuous.html benchmark-reports/baseline.html

# Make changes
# ...

# Run new test
pnpm run benchmark --mode continuous --duration 30m

# Compare reports
diff benchmark-reports/baseline.html benchmark-reports/latest-continuous.html
```

### 3. Performance Profiling

Identify bottlenecks with detailed metrics:

```bash
# Run with high volume
pnpm run benchmark \
  --mode continuous \
  --duration 1h \
  --injection-rate 50 \
  --checkpoint 10m \
  --dashboard

# Monitor dashboard for:
# - Queue depth spikes
# - Processing slowdowns
# - Memory growth
```

### 4. Quality Validation

Verify knowledge extraction quality over time:

```bash
# Test specific scenario
pnpm run benchmark \
  --mode continuous \
  --duration 2h \
  --scenario entity-extraction \
  --injection-rate 10 \
  --checkpoint 15m

# Check quality evolution in report
```

### 5. Stress Testing

Push system limits:

```bash
# High-volume test
pnpm run benchmark \
  --mode continuous \
  --duration 6h \
  --injection-rate 100 \
  --checkpoint 30m \
  --max-messages 10000
```

## 🐛 Troubleshooting

### Dashboard Won't Start

```bash
# Check if port is in use
lsof -i :3001

# Use different port
pnpm run benchmark --mode continuous --dashboard --dashboard-port 3002
```

### Gardener Not Running

```bash
# Check environment variables
echo $GARDENER_FREQUENT_INTERVAL
echo $GARDENER_PERIODIC_INTERVAL

# Check logs
grep "gardener" logs/

# Verify cron expression
node -e "console.log(require('./src/utils/interval-parser').intervalToCron('30s'))"
```

### No Checkpoints Generated

```bash
# Verify checkpoint interval
# Should be less than duration

# Example: --duration 5m --checkpoint 10m
# Bad: Checkpoint interval (10m) > duration (5m)
# Good: --duration 5m --checkpoint 1m
```

### Messages Not Injecting

```bash
# Check injection rate
# Should be reasonable (1-100 msg/min)

# Verify queue is running
ps aux | grep queue

# Check queue depth
# Should be growing during test
```

### Report Missing Charts

```bash
# Verify checkpoints were collected
ls -la .benchmark-history/*/checkpoints/

# Check report generation logs
grep "Generating report" benchmark.log

# Manually regenerate
pnpm run benchmark --report-only
```

## 📚 Related Documentation

- [Architecture Overview](../../architecture/README.md)
- [Gardener Agents](../gardener/README.md)
- [Benchmark Scenarios](./scenarios/README.md)
- [API Documentation](../services/api-client/README.md)

## 🤝 Contributing

When adding new benchmark scenarios or features:

1. Add scenario generator in `src/benchmark/scenarios/`
2. Update this README with usage examples
3. Add verification steps to testing section
4. Update NPM scripts if needed

## 📝 License

MIT

## 🙏 Acknowledgments

Built with:
- [Express](https://expressjs.com/) - Web server
- [WebSocket](https://github.com/websockets/ws) - Real-time communication
- [Chart.js](https://www.chartjs.org/) - Visualization
- [pg-boss](https://github.com/timgit/pg-boss) - Job scheduling
