/**
 * server.ts — Local Admin Panel Server
 *
 * Run with: npm run panel
 * Opens at: http://localhost:3000
 *
 * Intentionally does NOT import from ./config — the panel must work
 * even before API keys are filled in (that's the whole point of the panel).
 * All .env reads are done directly via dotenv.parse + fs.readFileSync.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import dotenv from 'dotenv';

const app = express();
const PORT = parseInt(process.env['PANEL_PORT'] ?? '3000', 10);

// Absolute paths anchored to the project root (one level above /src)
const ROOT = path.resolve('.');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const HISTORY_PATH = path.join(ROOT, 'history.json');

app.use(express.json());
// Serve the admin panel static files from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────────────────────────────────────
//  .env helpers
// ─────────────────────────────────────────────────────────────────────────────

function readEnv(): Record<string, string> {
  const src = fs.existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  if (!fs.existsSync(src)) return {};
  return dotenv.parse(fs.readFileSync(src, 'utf-8'));
}

function writeEnv(updates: Record<string, string>): void {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  }
  for (const [key, value] of Object.entries(updates)) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^${esc}=.*$`, 'm');
    content = rx.test(content)
      ? content.replace(rx, `${key}=${value}`)
      : (content.endsWith('\n') ? content : content + '\n') + `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Config endpoints
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/config — returns non-sensitive config values + key presence flags */
app.get('/api/config', (_req: Request, res: Response) => {
  const env = readEnv();
  // Strip raw key values — only expose presence booleans to the frontend
  const { DEEPINFRA_TOKEN, SERPER_API_KEY, ...safe } = env;
  res.json({
    config: safe,
    keysConfigured: {
      deepinfra: Boolean(DEEPINFRA_TOKEN?.trim()),
      serper: Boolean(SERPER_API_KEY?.trim()),
    },
  });
});

/** POST /api/config — update non-sensitive .env values */
app.post('/api/config', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  // Never allow overwriting secrets from this endpoint
  delete body['DEEPINFRA_TOKEN'];
  delete body['SERPER_API_KEY'];
  writeEnv(body);
  res.json({ success: true });
});

/** POST /api/config/keys — update API key values (separate security boundary) */
app.post('/api/config/keys', (req: Request, res: Response) => {
  const { deepinfraToken, serperApiKey } = req.body as {
    deepinfraToken?: string;
    serperApiKey?: string;
  };
  const updates: Record<string, string> = {};
  if (deepinfraToken?.trim()) updates['DEEPINFRA_TOKEN'] = deepinfraToken.trim();
  if (serperApiKey?.trim()) updates['SERPER_API_KEY'] = serperApiKey.trim();
  if (Object.keys(updates).length) writeEnv(updates);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  History endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/history', (_req: Request, res: Response) => {
  if (!fs.existsSync(HISTORY_PATH)) return void res.json({ history: [] });
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')) as string[];
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

app.delete('/api/history/:index', (req: Request, res: Response) => {
  const idx = parseInt(req.params['index'] ?? '-1', 10);
  if (!fs.existsSync(HISTORY_PATH)) return void res.json({ success: false });
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')) as string[];
    if (idx < 0 || idx >= history.length) {
      return void res.json({ success: false, error: 'Index out of bounds' });
    }
    history.splice(idx, 1);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: String(e) });
  }
});

app.delete('/api/history', (_req: Request, res: Response) => {
  fs.writeFileSync(HISTORY_PATH, '[]');
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Session status endpoint
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/session', (_req: Request, res: Response) => {
  const env = readEnv();
  const sessionPath = path.resolve(env['AUTH_SESSION_PATH'] ?? './auth/session.json');
  const exists = fs.existsSync(sessionPath);
  let age: string | null = null;
  if (exists) {
    const ms = Date.now() - fs.statSync(sessionPath).mtimeMs;
    const h = Math.floor(ms / 3_600_000);
    age = h < 1 ? 'Just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }
  res.json({ exists, age, sessionPath });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SSE process spawner (shared by run + auth)
// ─────────────────────────────────────────────────────────────────────────────

type SseEventType = 'log' | 'err' | 'done' | 'fail';

function spawnStreamed(
  res: Response,
  script: string,
  extraEnv: Record<string, string> = {}
): ChildProcess {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (type: SseEventType, msg: string): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ msg, ts: Date.now() })}\n\n`);
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...extraEnv,
  };

  const proc = spawn('npx', ['ts-node', script], {
    cwd: ROOT,
    env,
    shell: true,
    windowsHide: true,
  });

  proc.stdout?.setEncoding('utf-8');
  proc.stderr?.setEncoding('utf-8');
  proc.stdout?.on('data', (d: string) =>
    d.split('\n').filter(Boolean).forEach((l) => send('log', l))
  );
  proc.stderr?.on('data', (d: string) =>
    d.split('\n').filter(Boolean).forEach((l) => send('err', l))
  );
  proc.on('close', (code) => {
    send(code === 0 ? 'done' : 'fail', code === 0 ? 'Completed ✓' : `Exited (${code})`);
    res.end();
  });
  proc.on('error', (e) => {
    send('fail', `Spawn error: ${e.message}`);
    res.end();
  });

  return proc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Run endpoints (ORIGINAL_POST / REPLY / RETWEET)
// ─────────────────────────────────────────────────────────────────────────────

let runProcess: ChildProcess | null = null;

/** GET /api/run — SSE: spawn stealth_poster with HITL disabled (panel is the HITL) */
app.get('/api/run', (req: Request, res: Response) => {
  if (runProcess) {
    res.status(409).json({ error: 'A run is already in progress.' });
    return;
  }
  const proc = spawnStreamed(res, 'src/stealth_poster.ts', {
    HUMAN_IN_THE_LOOP: 'false',
  });
  runProcess = proc;
  proc.on('close', () => { runProcess = null; });
  req.on('close', () => { if (runProcess === proc) { proc.kill(); runProcess = null; } });
});

/** POST /api/run/kill — terminate an in-progress run */
app.post('/api/run/kill', (_req: Request, res: Response) => {
  if (runProcess) {
    runProcess.kill();
    runProcess = null;
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'No active run.' });
  }
});

/** GET /api/run/status — is a run currently active? */
app.get('/api/run/status', (_req: Request, res: Response) => {
  res.json({ running: Boolean(runProcess) });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Auth endpoints
// ─────────────────────────────────────────────────────────────────────────────

let authProcess: ChildProcess | null = null;

/** GET /api/auth — SSE: spawn generate_session.ts */
app.get('/api/auth', (req: Request, res: Response) => {
  if (authProcess) {
    res.status(409).json({ error: 'Auth already running.' });
    return;
  }
  const proc = spawnStreamed(res, 'src/generate_session.ts');
  authProcess = proc;
  proc.on('close', () => { authProcess = null; });
  req.on('close', () => { if (authProcess === proc) { proc.kill(); authProcess = null; } });
});

/** POST /api/auth/confirm — send ENTER keypress to the waiting auth process */
app.post('/api/auth/confirm', (_req: Request, res: Response) => {
  if (authProcess?.stdin) {
    authProcess.stdin.write('\n');
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'No auth process is waiting for input.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Preview endpoint — LLM draft generation without browser
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/preview — generates a tweet draft using LLM + Serper, returns JSON */
app.get('/api/preview', (_req: Request, res: Response) => {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  const proc = spawn('npx', ['ts-node', 'src/preview.ts'], {
    cwd: ROOT,
    env,
    shell: true,
    windowsHide: true,
  });

  let out = '';
  proc.stdout?.setEncoding('utf-8');
  proc.stderr?.setEncoding('utf-8');
  proc.stdout?.on('data', (d: string) => { out += d; });

  proc.on('close', (code) => {
    // preview.ts writes __RESULT__:{json} as its final stdout line
    const match = out.match(/__RESULT__:(.+)/);
    if (!match) {
      return void res.json({
        success: false,
        error: code !== 0 ? 'Preview script failed — check API keys in .env.' : 'No result received.',
      });
    }
    try {
      const data = JSON.parse(match[1]!) as Record<string, unknown>;
      res.json({ success: true, ...data });
    } catch {
      res.json({ success: false, error: 'Failed to parse preview result.' });
    }
  });

  proc.on('error', (e) => res.json({ success: false, error: e.message }));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   X Automation — Admin Panel              ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   → http://localhost:${PORT}                   ║`);
  console.log('╚══════════════════════════════════════════╝\n');
});
