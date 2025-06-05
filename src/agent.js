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

  async checkServiceStatus(serviceName) {
    try {
      const { stdout } = await execAsync(`systemctl is-active ${serviceName}`);
      const status = stdout.trim();
      console.log(`Service ${serviceName}: ${status}`);
      return status === 'active';
    } catch (error) {
      console.log(`Service ${serviceName}: error checking status - ${error.message}`);
      return false;
    }
  }

  async collectStatus() {
    await this.getGitVersion();
    
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize()
    ]);

    // Check service status for MariaDB and OpenLiteSpeed (which handles PHP)
    const services = {
      mariadb: await this.checkServiceStatus('mariadb'),
      openlitespeed: await this.checkServiceStatus('lshttpd')  // OpenLiteSpeed handles PHP
    };

    console.log('Service status:', services);

    // Get main disk usage (usually the root filesystem)
    const mainDisk = disk.find(d => d.fs === '/' || d.mount === '/') || disk[0];
    const diskUsage = {
      total: Math.round(mainDisk.size / (1024 * 1024 * 1024)), // GB
      used: Math.round(mainDisk.used / (1024 * 1024 * 1024)),  // GB
      free: Math.round((mainDisk.size - mainDisk.used) / (1024 * 1024 * 1024)), // GB
      percentage: Math.round((mainDisk.used / mainDisk.size) * 100)
    };

    return {
      hostname: os.hostname(),
      uptime: os.uptime(),
      gitVersion: this.gitVersion,
      cpu: {
        load: Math.round(cpu.currentLoad * 100) / 100, // Round to 2 decimals
        cores: os.cpus().length
      },
      memory: {
        total: Math.round(mem.total / (1024 * 1024 * 1024)), // GB
        used: Math.round(mem.used / (1024 * 1024 * 1024)),   // GB
        free: Math.round(mem.free / (1024 * 1024 * 1024))    // GB
      },
      disk: diskUsage,
      services,
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
        case 'system_update':
          await this.handleSystemUpdate(message);
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
      
      // First, fetch all commits to ensure we have the latest refs
      await execAsync('git fetch --all');
      
      // Get current commit before reset
      const { stdout: currentCommit } = await execAsync('git rev-parse HEAD');
      const beforeVersion = currentCommit.trim();
      
      // Force reset to latest origin/main (or whatever the default branch is)
      const { stdout: resetOutput } = await execAsync('git reset --hard origin/main');
      console.log('Git reset output:', resetOutput);
      
      // Get new commit after reset
      const { stdout: newCommit } = await execAsync('git rev-parse HEAD');
      const afterVersion = newCommit.trim();
      
      // Check if any updates were received
      if (beforeVersion === afterVersion) {
        console.log('Agent code is already up to date.');
        this.send({
          type: 'status',
          operation: 'update_agent',
          status: 'completed',
          message: 'Agent code is already up to date.',
          output: resetOutput
        });
        
        // Still report success since we're up to date
        this.send({
          type: 'agent_updated',
          success: true,
          message: 'Agent is already up to date'
        });
        
        return;
      }
      
      // Use the version we already got after the reset
      const newVersion = afterVersion;
      
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

  async handleSystemUpdate(message) {
    try {
      this.send({
        type: 'status',
        operation: 'system_update',
        status: 'starting'
      });
      
      console.log('Running system-level update...');
      
      // Check if the install.sh script exists
      const installScriptPath = '/opt/citrus-agent/updates/install.sh';
      try {
        await execAsync(`test -f ${installScriptPath}`);
      } catch (error) {
        throw new Error(`System update script not found at ${installScriptPath}`);
      }
      
      // Make sure the script is executable
      await execAsync(`chmod +x ${installScriptPath}`);
      
      // Run the system update script with real-time output streaming
      console.log('Executing system update script...');
      
      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const child = spawn('sudo', [installScriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: '/opt/citrus-agent'
        });
        
        let allOutput = '';
        
        // Stream stdout in real-time
        child.stdout.on('data', (data) => {
          const output = data.toString();
          console.log('SYSTEM UPDATE:', output);
          allOutput += output;
          
          // Send real-time updates
          this.send({
            type: 'status',
            operation: 'system_update',
            status: 'running',
            output: output.trim()
          });
        });
        
        // Stream stderr in real-time
        child.stderr.on('data', (data) => {
          const output = data.toString();
          console.log('SYSTEM UPDATE ERROR:', output);
          allOutput += output;
          
          // Send real-time error updates
          this.send({
            type: 'status',
            operation: 'system_update',
            status: 'running',
            error: output.trim()
          });
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            console.log('System update completed successfully');
            this.send({
              type: 'status',
              operation: 'system_update',
              status: 'completed',
              output: 'System update completed successfully',
              fullOutput: allOutput
            });
            resolve();
          } else {
            console.error(`System update failed with exit code ${code}`);
            this.send({
              type: 'status',
              operation: 'system_update',
              status: 'failed',
              error: `System update failed with exit code ${code}`,
              fullOutput: allOutput
            });
            reject(new Error(`System update failed with exit code ${code}`));
          }
        });
        
        child.on('error', (error) => {
          console.error('Error spawning system update process:', error);
          this.send({
            type: 'status',
            operation: 'system_update',
            status: 'failed',
            error: `Process spawn error: ${error.message}`
          });
          reject(error);
        });
      });
      
    } catch (error) {
      console.error('Error performing system update:', error);
      this.send({
        type: 'status',
        operation: 'system_update',
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