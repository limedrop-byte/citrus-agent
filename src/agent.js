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
        case 'create_site':
          await this.handleCreateSite(message);
          break;
        case 'delete_site':
          await this.handleDeleteSite(message);
          break;
        case 'deploy_ssl':
          await this.handleDeploySSL(message);
          break;
        case 'redeploy_ssl':
          await this.handleRedeploySSL(message);
          break;
        case 'turn_off_ssl':
          await this.handleTurnOffSSL(message);
          break;
        case 'update_agent':
          await this.handleUpdateAgent(message);
          break;
        case 'rollback_agent':
          await this.handleRollbackAgent(message);
          break;
        case 'key_rotation':
          await this.handleKeyRotation(message);
          break;
        case 'site_info':
          await this.handleSiteInfo(message);
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

  async handleCreateSite(message) {
    const { domain, options } = message;
    
    console.log('Received create site request for domain:', domain);
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'starting',
        domain
      });
      console.log('Sent starting status for domain:', domain);

      const command = `wo site create ${domain} --wp`;
      console.log('Executing command:', command);
      const { stdout, stderr } = await execAsync(command);
      console.log('Command output:', stdout);
      if (stderr) console.error('Command stderr:', stderr);

      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'completed',
        domain,
        output: stdout
      });
      console.log('Sent completed status for domain:', domain);
    } catch (error) {
      console.error('Error creating site:', error);
      this.send({
        type: 'site_operation',
        operation: 'create',
        status: 'failed',
        domain,
        error: error.message
      });
      console.log('Sent failed status for domain:', domain);
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

      const command = `wo site delete ${domain} --no-prompt`;
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

  async handleDeploySSL(message) {
    const { domain } = message;
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'deploy_ssl',
        status: 'starting',
        domain
      });
      
      console.log(`Deploying SSL for domain: ${domain}`);
      
      // Use spawn instead of exec to handle interactive prompts
      return new Promise((resolve, reject) => {
        console.log('Executing command: wo site update', domain, '-le');
        
        const child = spawn('wo', ['site', 'update', domain, '-le'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdoutData = '';
        let stderrData = '';
        
        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          console.log('Command output:', output);
          
          // Check for certificate prompt and respond with '1'
          if (output.includes('Please select an option from below') && 
              output.includes('1: Reinstall existing certificate') &&
              output.includes('Type the appropriate number')) {
            console.log('Certificate prompt detected, selecting option 1 (Reinstall existing certificate)');
            child.stdin.write('1\n');
          }
        });
        
        child.stderr.on('data', (data) => {
          stderrData += data.toString();
          console.error('Command stderr:', data.toString());
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            console.log('SSL deployment completed for domain:', domain);
      this.send({
        type: 'site_operation',
        operation: 'deploy_ssl',
        status: 'completed',
        domain,
              output: stdoutData
            });
            resolve();
          } else {
            const errorMessage = `SSL deployment failed with code ${code}: ${stderrData}`;
            console.error(errorMessage);
            this.send({
              type: 'site_operation',
              operation: 'deploy_ssl',
              status: 'failed',
              domain,
              error: errorMessage
            });
            reject(new Error(errorMessage));
          }
        });
        
        child.on('error', (err) => {
          console.error('Error spawning process:', err);
          this.send({
            type: 'site_operation',
            operation: 'deploy_ssl',
            status: 'failed',
            domain,
            error: err.message
          });
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error deploying SSL:', error);
      this.send({
        type: 'site_operation',
        operation: 'deploy_ssl',
        status: 'failed',
        domain,
        error: error.message
      });
      console.log('SSL deployment failed for domain:', domain);
    }
  }

  async handleTurnOffSSL(message) {
    const { domain } = message;
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'turn_off_ssl',
        status: 'starting',
        domain
      });
      
      console.log(`Turning off SSL for domain: ${domain}`);
      
      // Use spawn instead of exec to handle any interactive prompts
      return new Promise((resolve, reject) => {
        console.log('Executing command: wo site update', domain, '--letsencrypt=off');
        
        const child = spawn('wo', ['site', 'update', domain, '--letsencrypt=off'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdoutData = '';
        let stderrData = '';
        
        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          console.log('Command output:', output);
        });
        
        child.stderr.on('data', (data) => {
          stderrData += data.toString();
          console.error('Command stderr:', data.toString());
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            console.log('SSL successfully turned off for domain:', domain);
            this.send({
              type: 'site_operation',
              operation: 'turn_off_ssl',
              status: 'completed',
              domain,
              output: stdoutData
            });
            resolve();
          } else {
            const errorMessage = `Failed to turn off SSL with code ${code}: ${stderrData}`;
            console.error(errorMessage);
            this.send({
              type: 'site_operation',
              operation: 'turn_off_ssl',
              status: 'failed',
              domain,
              error: errorMessage
            });
            reject(new Error(errorMessage));
          }
        });
        
        child.on('error', (err) => {
          console.error('Error spawning process:', err);
          this.send({
            type: 'site_operation',
            operation: 'turn_off_ssl',
            status: 'failed',
            domain,
            error: err.message
          });
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error turning off SSL:', error);
      this.send({
        type: 'site_operation',
        operation: 'turn_off_ssl',
        status: 'failed',
        domain,
        error: error.message
      });
      console.log('Failed to turn off SSL for domain:', domain);
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

  async handleRedeploySSL(message) {
    const { domain } = message;
    
    try {
      this.send({
        type: 'site_operation',
        operation: 'redeploy_ssl',
        status: 'ssl_redeploying',
        domain
      });
      
      console.log(`Redeploying SSL for domain: ${domain}`);
      console.log('First turning off SSL...');
      
      // Use spawn for the first command to turn off SSL
      const turnOffResult = await new Promise((resolve, reject) => {
        console.log('Executing command: wo site update', domain, '--letsencrypt=off');
        
        const turnOffChild = spawn('wo', ['site', 'update', domain, '--letsencrypt=off'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let turnOffStdoutData = '';
        let turnOffStderrData = '';
        
        turnOffChild.stdout.on('data', (data) => {
          const output = data.toString();
          turnOffStdoutData += output;
          console.log('Turn off SSL output:', output);
        });
        
        turnOffChild.stderr.on('data', (data) => {
          turnOffStderrData += data.toString();
          console.error('Turn off SSL stderr:', data.toString());
        });
        
        turnOffChild.on('close', (code) => {
          if (code === 0) {
            console.log('SSL successfully turned off for domain:', domain);
            resolve(true);
          } else {
            // Even if turning off fails, we'll still try to redeploy
            // Sometimes the SSL might not be active yet
            console.warn(`Warning: Failed to turn off SSL with code ${code}: ${turnOffStderrData}`);
            resolve(false);
          }
        });
        
        turnOffChild.on('error', (err) => {
          console.error('Error spawning turn off SSL process:', err);
          // Continue with redeploy even if turn off fails
          resolve(false);
        });
      });
      
      console.log('Now deploying SSL with force renewal...');
      
      // Use spawn for the second command to deploy SSL
      return new Promise((resolve, reject) => {
        console.log('Executing command: wo site update', domain, '-le');
        
        const child = spawn('wo', ['site', 'update', domain, '-le'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdoutData = '';
        let stderrData = '';
        
        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          console.log('Command output:', output);
          
          // Check for certificate prompt and always choose option 2 for force renewal
          if (output.includes('Please select an option from below') && 
              output.includes('Type the appropriate number')) {
            console.log('Certificate prompt detected, selecting option 2 (Force renewal)');
            child.stdin.write('2\n');
          }
        });
        
        child.stderr.on('data', (data) => {
          stderrData += data.toString();
          console.error('Command stderr:', data.toString());
        });
        
        child.on('close', (code) => {
          if (code === 0) {
            console.log('SSL redeployment completed for domain:', domain);
            this.send({
              type: 'site_operation',
              operation: 'redeploy_ssl',
              status: 'completed',
              domain,
              output: stdoutData
            });
            resolve();
          } else {
            const errorMessage = `SSL redeployment failed with code ${code}: ${stderrData}`;
            console.error(errorMessage);
            this.send({
              type: 'site_operation',
              operation: 'redeploy_ssl',
              status: 'failed',
              domain,
              error: errorMessage
            });
            reject(new Error(errorMessage));
          }
        });
        
        child.on('error', (err) => {
          console.error('Error spawning process:', err);
          this.send({
            type: 'site_operation',
            operation: 'redeploy_ssl',
            status: 'failed',
            domain,
            error: err.message
          });
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error redeploying SSL:', error);
      this.send({
        type: 'site_operation',
        operation: 'redeploy_ssl',
        status: 'failed',
        domain,
        error: error.message
      });
      console.log('SSL redeployment failed for domain:', domain);
    }
  }

  async handleSiteInfo(message) {
    const { domain } = message;
    
    try {
      console.log(`Checking site info for domain: ${domain}`);
      
      // Get site info using wo command
      const command = `wo site info ${domain} --json`;
      const { stdout } = await execAsync(command);
      
      // Parse the JSON output
      const siteInfo = JSON.parse(stdout);
      
      // Extract SSL status
      const ssl = {
        enabled: siteInfo.ssl_enabled || false,
        provider: siteInfo.ssl_provider || null,
        expiry: siteInfo.ssl_expiry || null
      };
      
      // Send response back to engine
      this.send({
        type: 'site_info_response',
        domain,
        ssl
      });
      
      console.log(`Sent site info response for ${domain}:`, ssl);
    } catch (error) {
      console.error(`Error getting site info for ${domain}:`, error);
      this.send({
        type: 'error',
        error: `Failed to get site info: ${error.message}`,
        domain
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