#!/bin/bash

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "Please run as root"
  exit 1
fi

# Agent configuration
AGENT_ID="$1"
AGENT_KEY="$2"
ENGINE_WS_URL="$3"

if [ -z "$AGENT_ID" ] || [ -z "$AGENT_KEY" ] || [ -z "$ENGINE_WS_URL" ]; then
  echo "Usage: $0 <agent_id> <agent_key> <engine_ws_url>"
  exit 1
fi

# Create directories
mkdir -p /opt/citrus-agent
mkdir -p /etc/citrus-agent
mkdir -p /var/log/citrus-agent

# Install Node.js if not present
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi

# Copy agent files
cp -r . /opt/citrus-agent/

# Install dependencies
cd /opt/citrus-agent
npm install --production

# Create environment file
cat > /etc/citrus-agent/config.env << EOF
AGENT_ID=${AGENT_ID}
AGENT_KEY=${AGENT_KEY}
ENGINE_WS_URL=${ENGINE_WS_URL}
EOF

# Create systemd service
cat > /etc/systemd/system/citrus-agent.service << EOF
[Unit]
Description=Citrus Host Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/citrus-agent
EnvironmentFile=/etc/citrus-agent/config.env
ExecStart=/usr/bin/node src/agent.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/citrus-agent/agent.log
StandardError=append:/var/log/citrus-agent/error.log

[Install]
WantedBy=multi-user.target
EOF

# Setup log rotation
cat > /etc/logrotate.d/citrus-agent << EOF
/var/log/citrus-agent/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
}
EOF

# Start and enable service
systemctl daemon-reload
systemctl enable citrus-agent
systemctl start citrus-agent

echo "Citrus Agent installed successfully!"
echo "Check status with: systemctl status citrus-agent"
echo "View logs with: tail -f /var/log/citrus-agent/agent.log" 