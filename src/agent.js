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
    this.gitVersion = null;
  }

  async start() {
    console.log('Starting Citrus Agent...');
    await this.getGitVersion();
    this.connect();
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
      
      // Send immediate agent_connected message
      this.send({
        type: 'agent_connected',
        agentId: this.agentId
      });

      // Start sending status updates with 1-minute interval
      this.startStatusUpdates();
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

  startStatusUpdates() {
    // Clear any existing interval
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }

    // Start new interval with 1-minute updates
    this.statusInterval = setInterval(async () => {
      const status = await this.collectStatus();
      this.send({
        type: 'status_update',
        status
      });
    }, 60000); // Every 1 minute
  }

  async getGitVersion() {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD');
      this.gitVersion = stdout.trim();
      console.log(`Git version: ${this.gitVersion}`);
      return this.gitVersion;
    } catch (error) {
      console.error('Error getting git version:', error);
      this.gitVersion = 'unknown';
      return this.gitVersion;
    }
  }

  async collectStatus() {
    await this.getGitVersion();
    
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize()
    ]);

    return {
      hostname: os.hostname(),
      uptime: os.uptime(),
      gitVersion: this.gitVersion,
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
      case 'update_agent':
        await this.handleUpdateAgent(message);
        break;
      case 'rollback_agent':
        await this.handleRollbackAgent(message);
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

  async handleUpdateAgent(message) {
    try {
      this.send({
        type: 'update_operation',
        status: 'starting'
      });
      
      console.log('Updating agent from git with force reset...');
      
      // Fetch all changes first
      await execAsync('git fetch --all');
      
      // Force reset to origin/main (or whatever your branch is)
      const { stdout, stderr } = await execAsync('git reset --hard origin/main');
      
      // Check for errors in stderr
      const errorIndicators = [
        'fatal:', 'error:', 'cannot', 'denied', 'Could not', 'not found', 
        'failed', 'unable to', 'unresolved', 'Permission denied'
      ];
      
      const hasRealError = errorIndicators.some(indicator => 
        stderr.toLowerCase().includes(indicator.toLowerCase())
      );
      
      if (hasRealError) {
        throw new Error(`Git update error: ${stderr}`);
      }
      
      // Get the new git version
      await this.getGitVersion();
      
      // Successful update
      this.send({
        type: 'update_operation',
        status: 'completed',
        gitVersion: this.gitVersion,
        output: stdout + (stderr ? `\n${stderr}` : '')
      });
      
      console.log('Agent updated successfully, restarting service...');
      
      // Restart the service using systemctl
      try {
        await execAsync('systemctl restart citrus-agent');
        console.log('Restart command sent. Service will restart shortly.');
      } catch (restartError) {
        console.error('Error restarting service:', restartError);
        // We don't throw here because the update itself was successful
      }
      
    } catch (error) {
      console.error('Error updating agent:', error);
      this.send({
        type: 'update_operation',
        status: 'failed',
        error: error.message
      });
    }
  }

  async handleRollbackAgent(message) {
    try {
      const { commitId } = message;
      
      if (!commitId) {
        throw new Error('No commit ID provided for rollback');
      }
      
      this.send({
        type: 'rollback_operation',
        status: 'starting',
        commitId
      });
      
      console.log(`Rolling back agent to commit: ${commitId}`);
      
      // Fetch all remote changes first to ensure we have the commit
      await execAsync('git fetch --all');
      
      // Reset to the specific commit with force
      const { stdout, stderr } = await execAsync(`git reset --hard ${commitId}`);
      
      // Check for errors in stderr
      const errorIndicators = [
        'fatal:', 'error:', 'cannot', 'denied', 'Could not', 'not found', 
        'failed', 'unable to', 'unresolved', 'Permission denied', 'unknown revision'
      ];
      
      const hasRealError = errorIndicators.some(indicator => 
        stderr.toLowerCase().includes(indicator.toLowerCase())
      );
      
      if (hasRealError) {
        throw new Error(`Git rollback error: ${stderr}`);
      }
      
      // Get the new git version to confirm rollback
      await this.getGitVersion();
      
      // Successful rollback
      this.send({
        type: 'rollback_operation',
        status: 'completed',
        gitVersion: this.gitVersion,
        output: stdout + (stderr ? `\n${stderr}` : '')
      });
      
      console.log(`Agent successfully rolled back to ${commitId}, restarting service...`);
      
      // Restart the service using systemctl
      try {
        await execAsync('systemctl restart citrus-agent');
        console.log('Restart command sent. Service will restart shortly.');
      } catch (restartError) {
        console.error('Error restarting service:', restartError);
        // We don't throw here because the rollback itself was successful
      }
      
    } catch (error) {
      console.error('Error rolling back agent:', error);
      this.send({
        type: 'rollback_operation',
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

// Start the agent if this file is run directly
if (require.main === module) {
    const agent = new CitrusAgent();
    agent.start();
}

module.exports = CitrusAgent; 