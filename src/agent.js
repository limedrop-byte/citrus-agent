const WebSocket = require('ws');
const si = require('systeminformation');
const os = require('os');
const { exec, spawn } = require('child_process');
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

      // Send a message to clear any running commands
      // This helps when the agent restarts after an update
      this.send({
        type: 'clear_command_state',
        agentId: this.agentId,
        message: 'Agent restarted, clearing previous command state'
      });
      console.log('Sent clear_command_state message to reset any running commands');

      // Start sending status updates with 1-minute interval
      this.startStatusUpdates();
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        console.log('Received message from Engine:', {
          type: message.type,
          commanderId: message.commanderId,
          domain: message.domain
        });
        
        await this.handleMessage(message);
      } catch (error) {
        console.error('Error handling message:', error);
        // Send error back to engine
        this.send({
          type: 'error',
          error: error.message,
          originalMessage: data.toString()
        });
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
    try {
      console.log('Received message:', message.type, 'Full message:', JSON.stringify(message));
      
      switch (message.type) {
        case 'update_agent':
          await this.handleUpdateAgent(message);
          break;
        case 'rollback_agent':
          await this.handleRollbackAgent(message);
          break;
        case 'key_rotation':
          await this.handleKeyRotation(message);
          break;
        default:
          console.log('Unknown message type:', message.type);
          this.send({
            type: 'error',
            error: `Unknown message type: ${message.type}`
          });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.send({
        type: 'error',
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
        type: 'status',
        operation: 'update_agent',
        status: 'starting'
      });
      
      console.log('Updating agent code...');
      
      // Run git pull to update the code
      const { stdout: pullOutput } = await execAsync('git pull');
      console.log('Git pull output:', pullOutput);
      
      // Check if any updates were received
      if (pullOutput.includes('Already up to date.')) {
        console.log('Agent code is already up to date.');
        this.send({
          type: 'status',
          operation: 'update_agent',
          status: 'completed',
          message: 'Agent code is already up to date.',
          output: pullOutput
        });
        
        // Still report success since we're up to date
        this.send({
          type: 'agent_updated',
          success: true,
          message: 'Agent is already up to date'
        });
        
        return;
      }
      
      // Get the new git version
      const { stdout: versionOutput } = await execAsync('git rev-parse HEAD');
      const newVersion = versionOutput.trim();
      
      // Install any new dependencies
      console.log('Installing dependencies...');
      const { stdout: npmOutput } = await execAsync('npm install');
      console.log('NPM install output:', npmOutput);
      
      // Send a success message before restarting
      this.send({
        type: 'agent_updated',
        success: true,
        version: newVersion
      });
      
      // Wait a moment for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Restart the process
      console.log('Restarting agent...');
      process.exit(0); // PM2 or similar will restart the process
    } catch (error) {
      console.error('Error updating agent:', error);
      this.send({
        type: 'status',
        operation: 'update_agent',
        status: 'failed',
        error: error.message
      });
    }
  }

  async handleRollbackAgent(message) {
    const { commitId } = message;
    
    try {
      this.send({
        type: 'rollback_operation',
        status: 'starting'
      });
      
      console.log(`Rolling back agent to commit ${commitId}...`);
      
      // First, fetch all commits
      await execAsync('git fetch --all');
      
      // Reset to the specified commit
      const { stdout: resetOutput } = await execAsync(`git reset --hard ${commitId}`);
      console.log('Git reset output:', resetOutput);
      
      // Install dependencies for that version
      console.log('Installing dependencies for rollback version...');
      const { stdout: npmOutput } = await execAsync('npm install');
      console.log('NPM install output:', npmOutput);
      
      // Send success before restarting
      this.send({
        type: 'rollback_operation',
        status: 'completed',
        version: commitId
      });
      
      // Wait a moment for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Restart the process
      console.log('Restarting agent after rollback...');
      process.exit(0); // PM2 or similar will restart the process
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