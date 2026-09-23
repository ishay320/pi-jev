import { spawn, exec } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Get directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Track active sessions using a file with PIDs
const OMP_DIR = join(homedir(), ".omp");
const LOCK_FILE = join(OMP_DIR, "jev_server.sessions");

function ensureOmpDir() {
  if (!existsSync(OMP_DIR)) {
    mkdirSync(OMP_DIR, { recursive: true });
  }
}

function getActiveSessions(): Set<number> {
  try {
    if (!existsSync(LOCK_FILE)) return new Set();
    const content = readFileSync(LOCK_FILE, "utf8");
    const pids = content.trim().split("\n").filter(Boolean).map(Number);
    // Filter out dead processes
    const alive = new Set<number>();
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // Check if process exists
        alive.add(pid);
      } catch {
        // Process doesn't exist, skip it
      }
    }
    return alive;
  } catch {
    return new Set();
  }
}

function setActiveSessions(pids: Set<number>): void {
  try {
    ensureOmpDir();
    if (pids.size === 0) {
      if (existsSync(LOCK_FILE)) {
        unlinkSync(LOCK_FILE);
      }
    } else {
      writeFileSync(LOCK_FILE, Array.from(pids).join("\n"), "utf8");
    }
  } catch {
    // Ignore errors
  }
}

function registerSession(): number {
  const pids = getActiveSessions();
  pids.add(process.pid);
  setActiveSessions(pids);
  return pids.size;
}

function unregisterSession(): number {
  const pids = getActiveSessions();
  pids.delete(process.pid);
  setActiveSessions(pids);
  return pids.size;
}

/**
 * Download model files if not present
 */
async function downloadModelsIfNeeded(serverDir: string): Promise<boolean> {
  const modelDir = join(serverDir, "artifacts", "v2");
  const modelFile = join(modelDir, "model.onnx");
  const downloadScript = join(serverDir, "..", "scripts", "download_model.py");

  // Check if model already exists
  if (existsSync(modelFile)) {
    return true;
  }

  // Model not found, need to download
  // Write downloading status
  writeFileSync(join(OMP_DIR, "jev_server.status"), "downloading", "utf8");


  return new Promise((resolve) => {
    const proc = spawn("python", [downloadScript], {
      cwd: serverDir,
      stdio: "inherit",
      shell: true,
    });

    proc.on("close", (code) => {
      if (code === 0 && existsSync(modelFile)) {
        console.log("✓ Models downloaded successfully");
        resolve(true);
      } else {
        console.error("✗ Failed to download models");
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      console.error("Download error:", err.message);
      resolve(false);
    });
  });
}

/**
 * Start the OpenJev server automatically when OMP starts.
 * Server is bundled with pi-jev package.
 */
export default function autoStartJevServer(pi: ExtensionAPI) {
  // Server is bundled in pi-jev/server/
  const serverDir = join(__dirname, "..", "server");
  const startScript = join(serverDir, "start_server.sh");
  const stopScript = join(serverDir, "stop_server.sh");
  const port = 8011;

  if (!existsSync(startScript)) {
    return;
  }

  pi.on("session_start", async () => {
    // Register this session
    registerSession();

    // Download models if not present
    const modelsReady = await downloadModelsIfNeeded(serverDir);
    if (!modelsReady) {
      console.error("Server cannot start without models");
      return;
    }

    // Check if server is already running
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        // Server already running, write status
        writeFileSync(join(OMP_DIR, "jev_server.status"), "online", "utf8");
        return;
      }
    } catch {
      // Server not running, start it
    }

    try {
      // Start server process
      const proc = spawn(startScript, [], {
        detached: true,
        stdio: "ignore",
        shell: true,
      });

      proc.unref();

      // Wait for server to be ready
      const maxAttempts = 15;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(1000),
          });

          if (response.ok) {
            // Write online status to file for index.ts to pick up
            writeFileSync(join(OMP_DIR, "jev_server.status"), "online", "utf8");
            return;
          }
        } catch {
          // Continue waiting
        }
      }
    } catch (error) {
      // Failed to start server
    }
  });

  pi.on("session_shutdown", () => {
    // Unregister this session
    const activeCount = unregisterSession();

    // Only stop server when last session closes
    if (activeCount === 0) {
      exec(stopScript, (error, stdout, stderr) => {
        if (!error) {
          // Clean up status file
          const statusFile = join(OMP_DIR, "jev_server.status");
          if (existsSync(statusFile)) {
            unlinkSync(statusFile);
          }
        }
      });
    }
  });
}
