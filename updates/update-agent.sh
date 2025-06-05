#!/bin/bash

# Citrus Agent Update Script
# This script updates the agent from git and applies any necessary system upgrades

echo "=== Citrus Agent Update ==="
echo "Starting agent update at $(date)"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    echo "Please run: sudo $0"
    exit 1
fi

# Navigate to agent directory
cd /opt/citrus-agent || {
    echo "ERROR: Could not find /opt/citrus-agent directory"
    exit 1
}

echo "Current directory: $(pwd)"

# Backup current .env file
if [ -f .env ]; then
    cp .env .env.backup
    echo "✅ Environment file backed up"
fi

# Stop the agent service
echo "Stopping citrus-agent service..."
systemctl stop citrus-agent

# Pull latest changes from git
echo "Pulling latest changes from git..."
git fetch origin
git pull origin main || git pull origin master

# Install/update dependencies
echo "Updating Node.js dependencies..."
npm install

# Check if logging upgrade script exists and run it
if [ -f ./updates/upgrade-logging.sh ]; then
    echo "Found logging upgrade script, executing..."
    chmod +x ./updates/upgrade-logging.sh
    ./updates/upgrade-logging.sh
else
    echo "No logging upgrade script found, skipping..."
    
    # Start the agent service normally
    echo "Starting citrus-agent service..."
    systemctl start citrus-agent
fi

# Verify service is running
sleep 2
if systemctl is-active --quiet citrus-agent; then
    echo "✅ Citrus Agent service is running"
    echo "✅ Agent update completed successfully"
else
    echo "❌ WARNING: Citrus Agent service failed to start"
    echo "Check logs with: journalctl -u citrus-agent.service"
fi

echo "Agent update completed at $(date)" 