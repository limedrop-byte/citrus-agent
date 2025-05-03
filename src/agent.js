const WebSocket = require('ws');
const si = require('systeminformation');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
require('dotenv').config();

class CitrusAgent {
  constructor() {
    this.agentId = process.env.AGENT_ID;
    this.agentKey = process.env.AGENT_KEY;
    this.engineUrl = process.env.ENGINE_WS_URL;
    this.ws = null;
    this.reconnectTimeout = 5000;
    this.statusInterval = null;
  }

  async start() {
    console.log('Starting Citrus Agent...');
    this.connect();
    this.startStatusUpdates();
  }

  connect() {
    console.log(`Connecting to Engine at ${this.engineUrl}`);
    
    this.ws = new WebSocket(this.engineUrl, {
      headers: {
        'x-client-type': 'agent',
        'x-agent-id': this.agentId,
        'x-agent-key': this.agentKey
      }
    });

    this.ws.on('open', () => {
      console.log('Connected to Engine');
      this.sendInitialStatus();
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        await this.handleMessage(message);
      } catch (error) {
        console.error('Error handling message:', error);
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from Engine, reconnecting...');
      clearInterval(this.statusInterval);
      setTimeout(() => this.connect(), this.reconnectTimeout);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  async sendInitialStatus() {
    const status = await this.collectStatus();
    this.send({
      type: 'initial_status',
      status
    });
  }

  startStatusUpdates() {
    this.statusInterval = setInterval(async () => {
      const status = await this.collectStatus();
      this.send({
        type: 'status_update',
        status
      });
    }, 30000); // Every 30 seconds
  }

  async collectStatus() {
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize()
    ]);

    return {
      hostname: os.hostname(),
      uptime: os.uptime(),
      cpu: {
        load: cpu.currentLoad,
        cores: os.cpus().length
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free
      },
      disk: disk.map(d => ({
        fs: d.fs,
        size: d.size,
        used: d.used,
        available: d.available
      })),
      timestamp: Date.now()
    };
  }

  async handleMessage(message) {
    console.log('Received message:', message.type);

    switch (message.type) {
      case 'create_site':
        await this.handleCreateSite(message);
        break;
      case 'delete_site':
        await this.handleDeleteSite(message);
        break;
      case 'key_rotation':
        await this.handleKeyRotation(message);
        break;
      default:
        console.log('Unknown message type:', message.type);
    }
  }

  async handleCreateSite(message) {
    const { domain, options } = message;
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'starting',
        domain
      });

      const command = `ee site create ${domain} --type=wp --cache`;
      const { stdout, stderr } = await execAsync(command);

      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'completed',
        domain,
        output: stdout
      });
    } catch (error) {
      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'failed',
        domain,
        error: error.message
      });
    }
  }

  async handleDeleteSite(message) {
    const { domain } = message;
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'delete',
        status: 'starting',
        domain
      });

      const command = `ee site delete ${domain} --yes`;
      const { stdout } = await execAsync(command);

      this.send({
        type: 'site_operation',
        operation: 'delete',
        status: 'completed',
        domain,
        output: stdout
      });
    } catch (error) {
      this.send({
        type: 'site_operation',
        operation: 'delete',
        status: 'failed',
        domain,
        error: error.message
      });
    }
  }

  async handleKeyRotation(message) {
    const { newKey } = message;
    
    try {
      // Update the key file
      await this.updateKeyFile(newKey);
      this.agentKey = newKey;
      
      this.send({
        type: 'key_rotation',
        status: 'completed'
      });
    } catch (error) {
      this.send({
        type: 'key_rotation',
        status: 'failed',
        error: error.message
      });
    }
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        ...message,
        agentId: this.agentId,
        timestamp: Date.now()
      }));
    }
  }
}

// Start the agent
const agent = new CitrusAgent();
agent.start(); 