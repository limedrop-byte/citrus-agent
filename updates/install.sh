#!/bin/bash

# Citrus Agent System-Level Update Controller
# Simple wrapper to run agent upgrades at the system level

echo "=== Citrus Agent System Update Controller ==="
echo "Starting system-level agent update at $(date)"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    echo "Please run: sudo $0"
    exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_SCRIPT="$SCRIPT_DIR/update-agent.sh"

# Check if update script exists
if [ ! -f "$UPDATE_SCRIPT" ]; then
    echo "ERROR: Update script not found at $UPDATE_SCRIPT"
    exit 1
fi

# Make sure update script is executable
chmod +x "$UPDATE_SCRIPT"

# Run the update script
echo "Executing agent update script..."
"$UPDATE_SCRIPT"

# Check exit status
if [ $? -eq 0 ]; then
    echo "✅ System-level agent update completed successfully"
else
    echo "❌ System-level agent update failed"
    exit 1
fi

echo "System update controller finished at $(date)" 