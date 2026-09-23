#!/bin/bash
# Stop OpenJev server

echo "Stopping Jev server..."
pkill -f "server_jev_fixed.py" && echo "✓ Jev server stopped" || echo "Server was not running"
