import { spawn } from 'node:child_process';

let patched = false;

function runPythonAuth(scriptPath: string, pythonBin: string, username: string, password: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, username || '', password || ''], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      stdout += d.toString();
    });

    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`python auth exited ${code}: ${stderr || stdout}`));
      }

      try {
        const lines = stdout
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);

        const parsed = JSON.parse(lines[lines.length - 1] || '{}');

        if (parsed?.error) {
          return reject(new Error(`python auth error: ${parsed.error}`));
        }

        if (!parsed?.token || !parsed?.profile?.id || !parsed?.profile?.name) {
          return reject(new Error('python auth missing required fields: token/profile.id/profile.name'));
        }

        resolve({
          token: parsed.token,
          profile: {
            id: String(parsed.profile.id).replace(/-/g, ''),
            name: parsed.profile.name,
          },
          entitlements: parsed.entitlements || {},
          certificates: parsed.certificates || {},
        });
      } catch (e) {
        reject(new Error(`python auth parse failed: ${(e as Error).message}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
  });
}

export function applyPythonMicrosoftAuthPatch(): void {
  if (patched) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prismarineAuth = require('prismarine-auth');
  const Authflow = prismarineAuth?.Authflow;
  if (!Authflow?.prototype) {
    throw new Error('Failed to patch prismarine-auth: Authflow prototype not found');
  }

  Authflow.prototype.getMinecraftJavaToken = async function getMinecraftJavaTokenPatched(_options: any = {}) {
    const scriptPath = this.options?.pythonAuthScript || process.env.MAICRAFT_PY_AUTH_SCRIPT;
    const pythonBin = this.options?.pythonBin || process.env.MAICRAFT_PY_BIN || 'python3';

    if (!scriptPath) {
      throw new Error('Missing pythonAuthScript (set bot option pythonAuthScript or env MAICRAFT_PY_AUTH_SCRIPT)');
    }

    const username = this.username || this.options?.username || '';
    const password = this.options?.password || '';

    return await runPythonAuth(scriptPath, pythonBin, username, password);
  };

  patched = true;
}
