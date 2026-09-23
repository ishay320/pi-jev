#!/bin/bash
# Start OpenJev server from pi-jev package

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Kill any existing server
pkill -f "server_jev_fixed.py" || true
# Wait for server to start
sleep 5
# Start the server
cd "$SCRIPT_DIR"
source .venv/bin/activate
nohup python server_jev_fixed.py --port 8011 > /tmp/jev_server.log 2>&1 &

# Wait for server to start
sleep 2

# Check if server is running
if curl -s http://127.0.0.1:8011/health > /dev/null 2>&1; then
    echo "✓ Jev server started on http://127.0.0.1:8011"
    curl -s http://127.0.0.1:8011/health | jq -c
else
    echo "✗ Failed to start Jev server"
    echo "Check logs at: /tmp/jev_server.log"
    exit 1
fi
