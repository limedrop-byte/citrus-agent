#!/bin/bash

# Citrus Agent Logging Upgrade Script
# This script upgrades existing agents to use the new daily log rotation system

echo "=== Citrus Agent Logging Upgrade ==="
echo "Starting logging system upgrade at $(date)"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    echo "Please run: sudo $0"
    exit 1
fi

# Stop the agent service temporarily
echo "Stopping citrus-agent service..."
systemctl stop citrus-agent

# Backup existing log file if it exists
if [ -f /var/log/citrus-agent.log ]; then
    echo "Backing up existing log file..."
    mkdir -p /var/log/citrus-agent-backup
    cp /var/log/citrus-agent.log /var/log/citrus-agent-backup/agent.log.backup.$(date +%Y%m%d_%H%M%S)
    echo "Backup created in /var/log/citrus-agent-backup/"
fi

# Create new log directory structure
echo "Setting up new logging directory structure..."
mkdir -p /var/log/citrus-agent
touch /var/log/citrus-agent/agent.log
chmod 644 /var/log/citrus-agent/agent.log
chown root:root /var/log/citrus-agent/agent.log

# Move existing log content to new location if it exists
if [ -f /var/log/citrus-agent.log ]; then
    echo "Migrating existing log content..."
    cat /var/log/citrus-agent.log >> /var/log/citrus-agent/agent.log
    rm /var/log/citrus-agent.log
fi

# Create logrotate configuration
echo "Setting up log rotation configuration..."
cat > /etc/logrotate.d/citrus-agent << 'EOL'
/var/log/citrus-agent/agent.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
    postrotate
        systemctl reload citrus-agent 2>/dev/null || true
    endscript
}
EOL

# Update systemd service to use new log location
echo "Updating systemd service configuration..."
if [ -f /etc/systemd/system/citrus-agent.service ]; then
    # Backup existing service file
    cp /etc/systemd/system/citrus-agent.service /etc/systemd/system/citrus-agent.service.backup
    
    # Update log paths in service file
    sed -i 's|StandardOutput=append:/var/log/citrus-agent.log|StandardOutput=append:/var/log/citrus-agent/agent.log|g' /etc/systemd/system/citrus-agent.service
    sed -i 's|StandardError=append:/var/log/citrus-agent.log|StandardError=append:/var/log/citrus-agent/agent.log|g' /etc/systemd/system/citrus-agent.service
    
    # Reload systemd daemon
    systemctl daemon-reload
    echo "Systemd service updated"
else
    echo "WARNING: /etc/systemd/system/citrus-agent.service not found"
fi

# Test logrotate configuration
echo "Testing logrotate configuration..."
logrotate -d /etc/logrotate.d/citrus-agent

# Start the agent service
echo "Starting citrus-agent service..."
systemctl start citrus-agent

# Verify service is running
sleep 2
if systemctl is-active --quiet citrus-agent; then
    echo "✅ Citrus Agent service is running"
else
    echo "❌ WARNING: Citrus Agent service failed to start"
    echo "Check logs with: journalctl -u citrus-agent.service"
fi

# Display new log locations
echo ""
echo "=== Upgrade Complete ==="
echo "✅ New log location: /var/log/citrus-agent/agent.log"
echo "✅ Log rotation: Daily with 30-day retention"
echo "✅ Old logs backed up to: /var/log/citrus-agent-backup/"
echo ""
echo "To view current logs: tail -f /var/log/citrus-agent/agent.log"
echo "To test log rotation: sudo logrotate -f /etc/logrotate.d/citrus-agent"
echo ""
echo "Logging upgrade completed at $(date)" 