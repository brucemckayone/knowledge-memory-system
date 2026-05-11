# Continuous Benchmark - Quick Reference

## 🚀 Common Commands

### Quick Tests

```bash
# 5-minute smoke test
GARDENER_FREQUENT_INTERVAL=30s GARDENER_PERIODIC_INTERVAL=1m \
pnpm run benchmark --mode continuous --duration 5m --injection-rate 5

# 30-minute standard test
pnpm run benchmark:continuous

# Fast development cycle (accelerated gardener)
pnpm run benchmark:continuous:fast

# With live dashboard
pnpm run benchmark:continuous:dashboard
```

### Custom Configurations

```bash
# Short duration, high frequency
pnpm run benchmark --mode continuous --duration 10m --injection-rate 20 --checkpoint 2m

# Long duration, realistic
pnpm run benchmark --mode continuous --duration 4h --injection-rate 10 --checkpoint 30m

# Stress test
pnpm run benchmark --mode continuous --duration 2h --injection-rate 100 --max-messages 5000

# Specific scenario
pnpm run benchmark --mode continuous --duration 1h --scenario entity-extraction
```

## 🔧 Environment Variables

```bash
# Accelerate gardener for faster testing
export GARDENER_FREQUENT_INTERVAL=30s   # Default: 5m
export GARDENER_PERIODIC_INTERVAL=2m    # Default: 1h
export GARDENER_DEEP_INTERVAL=10m       # Default: 24h

# Format: <number><unit> where unit is s, m, h, or d
# Examples: 30s, 5m, 1h, 1d
```

## 📊 Viewing Results

```bash
# Open latest report
open benchmark-reports/latest-continuous.html

# View checkpoint data
ls -la .benchmark-history/

# Monitor running test
tail -f benchmark.log
```

## 🖥️  Dashboard

```bash
# Start with dashboard
pnpm run benchmark --mode continuous --duration 30m --dashboard

# Open in browser
open http://localhost:3001

# Custom port
pnpm run benchmark --mode continuous --dashboard --dashboard-port 3002
```

## 🧪 Verification

```bash
# 1. Install dependencies
pnpm install

# 2. Quick smoke test (2 minutes)
GARDENER_FREQUENT_INTERVAL=30s \
pnpm run benchmark --mode continuous --duration 2m --checkpoint 30s

# 3. Verify report generated
ls -la benchmark-reports/latest-continuous.html

# 4. Open and inspect report
open benchmark-reports/latest-continuous.html
```

## 📈 What to Expect

### 5-Minute Fast Test
- **Duration**: 5 minutes
- **Messages**: ~25 (at 5 msg/min)
- **Checkpoints**: 5-10
- **Gardener Cycles**: 10 (frequent), 2-3 (periodic)
- **Report**: Growth chart, quality evolution, checkpoint table

### 30-Minute Standard Test
- **Duration**: 30 minutes
- **Messages**: ~300 (at 10 msg/min)
- **Checkpoints**: 2-3 (at 15m intervals)
- **Gardener Cycles**: 6 (frequent at 5m), 1 (periodic)
- **Report**: Time-series, growth rates, detailed metrics

### 2-Hour Extended Test
- **Duration**: 2 hours
- **Messages**: ~1200 (at 10 msg/min)
- **Checkpoints**: 8 (at 15m intervals)
- **Gardener Cycles**: 24 (frequent), 2 (periodic)
- **Report**: Full evolution, multiple cycles, trends

## ⚡ Performance Tips

### Faster Iteration
```bash
# Very accelerated gardener
GARDENER_FREQUENT_INTERVAL=10s \
GARDENER_PERIODIC_INTERVAL=30s \
pnpm run benchmark --mode continuous --duration 5m
```

### More Data Points
```bash
# Frequent checkpoints
pnpm run benchmark --mode continuous --duration 30m --checkpoint 2m
```

### Higher Volume
```bash
# More messages per minute
pnpm run benchmark --mode continuous --duration 30m --injection-rate 50
```

## 🐛 Quick Fixes

### Dashboard not showing?
```bash
# Check port
lsof -i :3001

# Try different port
pnpm run benchmark --mode continuous --dashboard --dashboard-port 3002
```

### No checkpoints?
```bash
# Ensure checkpoint interval < duration
# Bad: --duration 5m --checkpoint 10m
# Good: --duration 5m --checkpoint 1m
```

### Gardener not running?
```bash
# Check environment variables
echo $GARDENER_FREQUENT_INTERVAL

# Verify format (must be <number><unit>)
# Good: 30s, 5m, 1h
# Bad: 30, 5min, 1 hour
```

## 📚 Common Scenarios

### Testing Entity Extraction
```bash
pnpm run benchmark \
  --mode continuous \
  --scenario entity-extraction \
  --duration 30m \
  --injection-rate 10
```

### Testing Conflict Resolution
```bash
pnpm run benchmark \
  --mode continuous \
  --scenario conflicts \
  --duration 20m \
  --injection-rate 5
```

### Stress Testing Queue
```bash
pnpm run benchmark \
  --mode continuous \
  --duration 1h \
  --injection-rate 100 \
  --max-messages 5000
```

## 🎯 NPM Scripts Reference

```bash
pnpm run benchmark                    # Interactive CLI
pnpm run benchmark:quality            # Batch: entity extraction
pnpm run benchmark:stress             # Batch: heavy load
pnpm run benchmark:report             # Generate report only
pnpm run benchmark:continuous         # Continuous: 30min default
pnpm run benchmark:continuous:fast    # Continuous: accelerated gardener
pnpm run benchmark:continuous:dashboard  # Continuous: with web UI
```

## 🔗 Links

- [Full Documentation](./README.md)
- [Architecture](../../architecture/README.md)
- [Troubleshooting](./README.md#-troubleshooting)
