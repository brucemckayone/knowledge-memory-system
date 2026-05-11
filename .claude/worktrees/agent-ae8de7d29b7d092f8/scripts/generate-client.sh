#!/bin/bash
set -e

# Generate TypeScript client from Python FastAPI service

# Ensure pnpm is available
if ! command -v pnpm &> /dev/null; then
  echo "pnpm could not be found, installing..."
  npm install -g pnpm
fi

# Ensure openapi-ts is installed
if ! pnpm list -g @hey-api/openapi-ts &> /dev/null; then
    echo "Installing @hey-api/openapi-ts..."
    pnpm add -D @hey-api/openapi-ts --dir platform
fi

# Start the Python service in background
echo "Starting Python service..."
cd ml-services
# Check for venv
if [ -d "venv" ]; then
    ./venv/bin/python -m uvicorn app.main:app --port 8000 &
else
    python3 -m uvicorn app.main:app --port 8000 &
fi
PID=$!

# Wait for service to be ready
echo "Waiting for service to be ready..."
sleep 5

# Download OpenAPI spec
echo "Downloading OpenAPI spec..."
curl -s http://localhost:8000/openapi.json > ../platform/src/services/openapi.json

# Kill the Python service
echo "Stopping Python service..."
kill $PID

# Generate TypeScript client
echo "Generating TypeScript client..."
cd ../platform
# Use default client (fetch)
pnpm exec openapi-ts -i src/services/openapi.json -o src/services/api-client

echo "✅ Client generated in platform/src/services/api-client"
