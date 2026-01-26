// Machine Registry - Tracks connected agents and their capabilities
// Part of CNM Multi-Machine Support

import { hostname } from 'os';

// Health check constants
const AGENT_HEARTBEAT_TIMEOUT = 45000; // 45 seconds - consider agent dead if no heartbeat
const AGENT_CLEANUP_INTERVAL = 15000;  // Check for stale agents every 15 seconds

/**
 * Machine Registry
 * Tracks all connected machines (local + remote agents)
 */
export class MachineRegistry {
  constructor() {
    // Map of machineId -> machine info
    this.machines = new Map();

    // Local machine ID constant
    this.LOCAL_MACHINE_ID = 'LOCAL';

    // Register local machine on startup
    this._registerLocalMachine();

    // Start cleanup timer
    this.cleanupInterval = setInterval(() => this._cleanupStaleMachines(), AGENT_CLEANUP_INTERVAL);
  }

  /**
   * Register the local machine (hub itself)
   */
  _registerLocalMachine() {
    this.machines.set(this.LOCAL_MACHINE_ID, {
      id: this.LOCAL_MACHINE_ID,
      hostname: hostname(),
      address: null, // Local machine - no address needed
      isLocal: true,
      projects: [],
      sessions: [],
      status: 'connected',
      lastSeen: Date.now(),
      agentVersion: null
    });
  }

  /**
   * Register a remote agent
   * @param {Object} info - Agent registration info
   * @param {WebSocket} ws - Agent's WebSocket connection
   * @returns {Object} Registration result
   */
  registerAgent(info, ws) {
    const { machineId, hostname: agentHostname, address, agentVersion } = info;

    // Validate required fields
    if (!machineId || !agentHostname || !address) {
      return { success: false, error: 'Missing required fields: machineId, hostname, address' };
    }

    // Don't allow registering as LOCAL
    if (machineId === this.LOCAL_MACHINE_ID) {
      return { success: false, error: 'Cannot register as LOCAL - reserved for hub' };
    }

    // Check if machine already registered
    const existing = this.machines.get(machineId);
    if (existing && existing.ws && existing.ws.readyState === 1) {
      // Already connected - could be a reconnect, close old connection
      console.log(`[Registry] Agent ${machineId} reconnecting, closing old connection`);
      try {
        existing.ws.close(4000, 'Replaced by new connection');
      } catch (e) {
        // Ignore close errors
      }
    }

    // Register/update machine
    this.machines.set(machineId, {
      id: machineId,
      hostname: agentHostname,
      address: address,
      isLocal: false,
      projects: existing?.projects || [],
      sessions: existing?.sessions || [],
      status: 'connected',
      lastSeen: Date.now(),
      agentVersion: agentVersion || '1.0.0',
      ws: ws
    });

    console.log(`[Registry] Agent registered: ${machineId} (${agentHostname}) at ${address}`);

    return { success: true, machineId };
  }

  /**
   * Unregister an agent (on disconnect)
   * @param {string} machineId - Machine ID to unregister
   */
  unregisterAgent(machineId) {
    if (machineId === this.LOCAL_MACHINE_ID) return;

    const machine = this.machines.get(machineId);
    if (machine) {
      machine.status = 'disconnected';
      machine.ws = null;
      console.log(`[Registry] Agent disconnected: ${machineId}`);
    }
  }

  /**
   * Update agent heartbeat
   * @param {string} machineId - Machine ID
   */
  updateHeartbeat(machineId) {
    const machine = this.machines.get(machineId);
    if (machine) {
      machine.lastSeen = Date.now();
    }
  }

  /**
   * Update machine's project list
   * @param {string} machineId - Machine ID
   * @param {Array} projects - Project list
   */
  updateProjects(machineId, projects) {
    const machine = this.machines.get(machineId);
    if (machine) {
      const oldCount = machine.projects?.length || 0;
      const newCount = projects?.length || 0;
      machine.projects = projects || [];
      machine.lastSeen = Date.now();
      // Only log when count changes
      if (oldCount !== newCount) {
        console.log(`[Registry] ${machineId} projects: ${oldCount} -> ${newCount}`);
      }
    }
  }

  /**
   * Update machine's session list
   * @param {string} machineId - Machine ID
   * @param {Array} sessions - Session list
   */
  updateSessions(machineId, sessions) {
    const machine = this.machines.get(machineId);
    if (machine) {
      const oldCount = machine.sessions?.length || 0;
      const newCount = sessions?.length || 0;
      machine.sessions = sessions || [];
      machine.lastSeen = Date.now();
      // Only log when count changes
      if (oldCount !== newCount) {
        console.log(`[Registry] ${machineId} sessions: ${oldCount} -> ${newCount}`);
      }
    }
  }

  /**
   * Update local machine's data (called by hub)
   * @param {Array} projects - Local projects
   * @param {Array} sessions - Local sessions
   */
  updateLocalMachine(projects, sessions) {
    const local = this.machines.get(this.LOCAL_MACHINE_ID);
    if (local) {
      local.projects = projects || [];
      local.sessions = sessions || [];
      local.lastSeen = Date.now();
    }
  }

  /**
   * Get a machine by ID
   * @param {string} machineId - Machine ID
   * @returns {Object|null} Machine info
   */
  getMachine(machineId) {
    return this.machines.get(machineId) || null;
  }

  /**
   * Get agent WebSocket for a machine
   * @param {string} machineId - Machine ID
   * @returns {WebSocket|null} Agent WebSocket
   */
  getAgentSocket(machineId) {
    const machine = this.machines.get(machineId);
    return machine?.ws || null;
  }

  /**
   * List all machines (for client consumption)
   * @returns {Array} Machine list (without WebSocket refs)
   */
  listMachines() {
    const machines = [];

    for (const [id, machine] of this.machines) {
      // Skip disconnected machines that have been gone too long
      if (machine.status === 'disconnected') {
        const age = Date.now() - machine.lastSeen;
        if (age > AGENT_HEARTBEAT_TIMEOUT * 2) continue;
      }

      machines.push({
        id: machine.id,
        hostname: machine.hostname,
        address: machine.address,
        isLocal: machine.isLocal,
        projectCount: machine.projects?.length || 0,
        sessionCount: machine.sessions?.length || 0,
        status: machine.status
      });
    }

    // Sort: local first, then by hostname
    machines.sort((a, b) => {
      if (a.isLocal && !b.isLocal) return -1;
      if (!a.isLocal && b.isLocal) return 1;
      return a.hostname.localeCompare(b.hostname);
    });

    return machines;
  }

  /**
   * Get all projects from all machines
   * @returns {Array} Combined project list with machine info
   */
  getAllProjects() {
    const allProjects = [];

    for (const [machineId, machine] of this.machines) {
      // Skip disconnected machines
      if (machine.status !== 'connected') continue;

      for (const project of machine.projects || []) {
        allProjects.push({
          ...project,
          machineId: machineId,
          machineName: machine.hostname
        });
      }
    }

    return allProjects;
  }

  /**
   * Get all sessions from all machines
   * @returns {Array} Combined session list with machine info
   */
  getAllSessions() {
    const allSessions = [];

    for (const [machineId, machine] of this.machines) {
      // Skip disconnected machines
      if (machine.status !== 'connected') continue;

      for (const session of machine.sessions || []) {
        allSessions.push({
          ...session,
          machineId: machineId,
          machineName: machine.hostname
        });
      }
    }

    return allSessions;
  }

  /**
   * Clean up stale/disconnected machines
   */
  _cleanupStaleMachines() {
    const now = Date.now();

    for (const [machineId, machine] of this.machines) {
      // Never clean up local machine
      if (machine.isLocal) continue;

      const age = now - machine.lastSeen;

      // Mark as disconnected if no heartbeat
      if (machine.status === 'connected' && age > AGENT_HEARTBEAT_TIMEOUT) {
        console.log(`[Registry] Agent ${machineId} heartbeat timeout (${Math.round(age / 1000)}s)`);
        machine.status = 'disconnected';

        // Close WebSocket if still open
        if (machine.ws) {
          try {
            machine.ws.close(4001, 'Heartbeat timeout');
          } catch (e) {
            // Ignore close errors
          }
          machine.ws = null;
        }
      }

      // Remove if disconnected for too long (1 hour)
      if (machine.status === 'disconnected' && age > 60 * 60 * 1000) {
        console.log(`[Registry] Removing stale agent ${machineId}`);
        this.machines.delete(machineId);
      }
    }
  }

  /**
   * Clean up on shutdown
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Close all agent connections
    for (const [machineId, machine] of this.machines) {
      if (machine.ws) {
        try {
          machine.ws.close(1001, 'Server shutting down');
        } catch (e) {
          // Ignore
        }
      }
    }

    this.machines.clear();
  }
}

export default MachineRegistry;
