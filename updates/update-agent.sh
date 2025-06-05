#!/bin/bash

# Citrus Agent System Update Script
# This script handles system-level updates like logging configuration

echo "=== Citrus Agent System Update ==="
echo "Starting system update at $(date)"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    echo "Please run: sudo $0"
    exit 1
fi

v6 - no stoppin# Check if systemd service needs updating
SERVICE_NEEDS_RESTART=false
echo "Checking if systemd service needs updating..."

if [ -f /etc/systemd/system/citrus-agent.service ]; then
    # Check if service file still uses old log path
    if grep -q "/var/log/citrus-agent\.log" /etc/systemd/system/citrus-agent.service; then
        echo "Service file needs updating for new log paths"
        SERVICE_NEEDS_RESTART=true
    else
        echo "Service file already uses correct log paths"
    fi
else
    echo "WARNING: /etc/systemd/system/citrus-agent.service not found"
fi

# Create new log directory structure (safe to do while service is running)
echo "Setting up new logging directory structure..."
mkdir -p /var/log/citrus-agent
touch /var/log/citrus-agent/agent.log
chmod 644 /var/log/citrus-agent/agent.log
chown root:root /var/log/citrus-agent/agent.log

# Only stop service if we need to update systemd configuration
if [ "$SERVICE_NEEDS_RESTART" = true ]; then
    echo "Stopping citrus-agent service for configuration update..."
    systemctl stop citrus-agent
    
    # Backup and migrate existing log file if it exists
    if [ -f /var/log/citrus-agent.log ]; then
        echo "Backing up and migrating existing log file..."
        mkdir -p /var/log/citrus-agent-backup
        cp /var/log/citrus-agent.log /var/log/citrus-agent-backup/agent.log.backup.$(date +%Y%m%d_%H%M%S)
        echo "Backup created in /var/log/citrus-agent-backup/"
        
        # Migrate content to new location
        cat /var/log/citrus-agent.log >> /var/log/citrus-agent/agent.log
        rm /var/log/citrus-agent.log
        echo "Log content migrated to new location"
    fi
    
    # Update systemd service configuration
    echo "Updating systemd service configuration..."
    cp /etc/systemd/system/citrus-agent.service /etc/systemd/system/citrus-agent.service.backup
    
    # Update log paths in service file
    sed -i 's|StandardOutput=append:/var/log/citrus-agent.log|StandardOutput=append:/var/log/citrus-agent/agent.log|g' /etc/systemd/system/citrus-agent.service
    sed -i 's|StandardError=append:/var/log/citrus-agent.log|StandardError=append:/var/log/citrus-agent/agent.log|g' /etc/systemd/system/citrus-agent.service
    
    # Reload systemd daemon
    systemctl daemon-reload
    echo "Systemd service updated"
    
    # Start the service again
    echo "Starting citrus-agent service..."
    systemctl start citrus-agent
else
    echo "No service restart needed, service remains running"
    
    # Just backup existing log file if it exists (don't migrate while service is running)
    if [ -f /var/log/citrus-agent.log ]; then
        echo "Backing up existing log file..."
        mkdir -p /var/log/citrus-agent-backup
        cp /var/log/citrus-agent.log /var/log/citrus-agent-backup/agent.log.backup.$(date +%Y%m%d_%H%M%S)
        echo "Backup created in /var/log/citrus-agent-backup/"
        echo "Note: Old log file left in place since service is still running"
    fi
fi

# Create logrotate configuration (safe to do while service is running)
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

# Test logrotate configuration
echo "Testing logrotate configuration..."
logrotate -d /etc/logrotate.d/citrus-agent

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
echo "=== System Update Complete ==="
echo "✅ New log location: /var/log/citrus-agent/agent.log"
echo "✅ Log rotation: Daily with 30-day retention"
echo "✅ Old logs backed up to: /var/log/citrus-agent-backup/"
echo ""
echo "To view current logs: tail -f /var/log/citrus-agent/agent.log"
echo "To test log rotation: sudo logrotate -f /etc/logrotate.d/citrus-agent"
echo ""
echo "System update completed at $(date)" 