// knosky-export-daemon — Opt-in org-owned export daemon for KnoSky
// append-only checkpoints (SAT-546).
//
// PR #62 review (2026-07-05, round 5): split out of the `knosky` repo
// entirely into this separate package/repo. The "the evaluator never gains
// network capability" guarantee is now a PACKAGE-BOUNDARY fact, not just a
// directory or naming convention within the same repo -- `knosky` itself has
// zero dependency on this package and never imports, requires, or ships any
// part of it. An organization must deliberately `npm install
// knosky-export-daemon` (a separate install step, separate package, separate
// repo) to obtain this code at all.
//
// This module is NEVER imported by KnoSky's evaluator process. The evaluator
// only ever writes to the local append-only checkpoint file
// (knosky's core/append-only-checkpoint.mjs). Remote export is a SEPARATE,
// unsandboxed, opt-in daemon that exists only when an org has configured a
// destination AND has separately chosen to install this package.
//
// Design constraints (ticket round-3 clarification, D-193):
//   1. Off by default — no export occurs unless `destination.url` is set in
//      the export config.
//   2. Org-owned — the destination is always an endpoint the org itself owns
//      and operates (never a Sathia-operated endpoint).
//   3. No-egress preserved — the evaluator process is never involved in export
//      and gains no network capability in any configuration.
//   4. Plain HTTPS POST — no SDK, no cloud vendor dependency.  Pure Node
//      stdlib `node:https`, so the published package adds zero new deps.
//
// The daemon reads records from the same JSONL checkpoint file that the
// evaluator appends to, and forwards them to the configured destination.  It
// READS (never writes) the checkpoint — the O_RDONLY open keeps the append-
// only attribute in force.
//
// Config schema (subset; loader is caller-supplied):
// ```
// {
//   destination: {
//     url:     string,    // HTTPS URL — org-owned, never Sathia-operated.
//     headers: object,    // Optional extra headers (e.g. Authorization).
//   },
//   batchSize: number,    // Records per POST (default 100).
//   retryMax:  number,    // Max POST attempts per batch (default 3).
// }
// ```
//
// Returns from `exportBatch` are structured so callers can log/alert without
// needing to catch exceptions from this module.
//
// Pure Node stdlib, ESM — no third-party dependencies.

import { createReadStream } from 'node:fs';
import { request } from 'node:https';
import { createInterface } from 'node:readline';
import { URL, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// parseExportConfig — validate and normalise the export config object
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETRY_MAX  = 3;

/**
 * Parse and validate an export config object.
 *
 * Returns `{ ok: true, config }` on success.
 * Returns `{ ok: false, error }` when the config is absent, off, or invalid.
 *
 * The function NEVER throws — invalid configs return `ok: false` so callers
 * can log and skip export without a try/catch.
 *
 * @param {unknown} raw  Raw config value (e.g. from `.knosky/export.yml`).
 * @returns {{ ok: boolean, config?: object, error?: string }}
 */
export function parseExportConfig(raw) {
  // Absent or explicitly disabled.
  if (raw === null || raw === undefined || raw === false) {
    return { ok: false, error: 'export_not_configured' };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'export_config_must_be_object' };
  }

  const { destination } = raw;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) {
    return { ok: false, error: 'export_config_missing_destination' };
  }

  const { url } = destination;
  if (typeof url !== 'string' || !url) {
    return { ok: false, error: 'export_destination_url_missing' };
  }

  // URL must be HTTPS (no http:// — org endpoints must use TLS).
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `export_destination_url_invalid: ${url}` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `export_destination_url_must_be_https: ${url}` };
  }

  const headers = (destination.headers && typeof destination.headers === 'object')
    ? destination.headers
    : {};

  const batchSize = Number.isInteger(raw.batchSize) && raw.batchSize > 0
    ? raw.batchSize
    : DEFAULT_BATCH_SIZE;

  const retryMax = Number.isInteger(raw.retryMax) && raw.retryMax >= 0
    ? raw.retryMax
    : DEFAULT_RETRY_MAX;

  return {
    ok: true,
    config: {
      destination: { url, headers },
      batchSize,
      retryMax,
    },
  };
}

// ---------------------------------------------------------------------------
// readCheckpointLines — read JSONL from the checkpoint file (O_RDONLY)
// ---------------------------------------------------------------------------

/**
 * Read up to `limit` lines from the checkpoint file starting at `startLine`
 * (0-indexed).  Returns a Promise that resolves to an array of parsed objects.
 *
 * Lines that are not valid JSON are skipped with a console warning.
 *
 * @param {string} checkpointPath  Path to the JSONL checkpoint file.
 * @param {number} startLine       0-indexed line offset (inclusive).
 * @param {number} limit           Maximum number of lines to return.
 * @returns {Promise<{ entries: object[], nextLine: number }>}
 */
export async function readCheckpointLines(checkpointPath, startLine, limit) {
  const entries = [];
  let lineNum = 0;
  let nextLine = startLine;

  const stream = createReadStream(checkpointPath, { encoding: 'utf8', flags: 'r' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  await new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      if (lineNum < startLine) { lineNum++; return; }
      if (entries.length >= limit) { rl.close(); stream.destroy(); return; }
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) return; // blank line — skip
      try {
        entries.push(JSON.parse(trimmed));
        nextLine = lineNum;
      } catch {
        // Malformed line — warn but do not abort the batch.
        console.warn(`[export-daemon] skipping malformed checkpoint line ${lineNum}: ${trimmed.slice(0, 80)}`);
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
    stream.on('error', reject);
  });

  return { entries, nextLine };
}

// ---------------------------------------------------------------------------
// postBatch — single HTTPS POST to the org-owned destination
// ---------------------------------------------------------------------------

/**
 * POST a JSON array of checkpoint entries to the configured destination URL.
 *
 * Returns a structured result (never throws).
 *
 * @param {string} url
 * @param {object} headers  Extra headers from config (e.g. Authorization).
 * @param {object[]} entries
 * @returns {Promise<{ ok: boolean, statusCode: number|null, error: string|null }>}
 */
async function postBatch(url, headers, entries) {
  const body = JSON.stringify(entries);
  const parsed = new URL(url);

  const reqHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  };

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: reqHeaders,
      },
      (res) => {
        // Consume the response body to free the socket.
        res.resume();
        res.on('end', () => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, statusCode: res.statusCode ?? null, error: null });
        });
      },
    );
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: null, error: String(err?.message || err) });
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// exportBatch — main public API for the export daemon
// ---------------------------------------------------------------------------

/**
 * Export one batch of checkpoint entries to the org-owned destination.
 *
 * This is the primary public API for the export daemon loop:
 *
 * ```js
 * import { parseExportConfig, exportBatch } from 'knosky-export-daemon';
 *
 * const cfg = parseExportConfig(rawConfig);
 * if (!cfg.ok) { /* not configured or disabled * / }
 *
 * let cursor = 0;
 * while (true) {
 *   const result = await exportBatch(cfg.config, checkpointPath, cursor);
 *   if (result.exhausted) break; // no more records
 *   cursor = result.nextLine;
 * }
 * ```
 *
 * @param {object} config           Validated config from {@link parseExportConfig}.
 * @param {string} checkpointPath   Path to the JSONL checkpoint file.
 * @param {number} startLine        Next unread line (0-indexed cursor).
 * @returns {Promise<{
 *   ok: boolean,
 *   nextLine: number,
 *   exported: number,
 *   exhausted: boolean,
 *   error: string|null,
 * }>}
 */
export async function exportBatch(config, checkpointPath, startLine) {
  const { destination, batchSize, retryMax } = config;

  let entries, nextLine;
  try {
    ({ entries, nextLine } = await readCheckpointLines(checkpointPath, startLine, batchSize));
  } catch (err) {
    return {
      ok: false,
      nextLine: startLine,
      exported: 0,
      exhausted: false,
      error: `read_checkpoint_failed: ${err?.message || err}`,
    };
  }

  if (entries.length === 0) {
    return { ok: true, nextLine: startLine, exported: 0, exhausted: true, error: null };
  }

  // POST with simple linear retry.
  let lastResult = null;
  for (let attempt = 0; attempt <= retryMax; attempt++) {
    lastResult = await postBatch(destination.url, destination.headers, entries);
    if (lastResult.ok) break;
    // Brief back-off between retries (exponential: 200ms, 400ms, 800ms…).
    if (attempt < retryMax) {
      await new Promise(r => setTimeout(r, 200 * 2 ** attempt));
    }
  }

  if (!lastResult.ok) {
    return {
      ok: false,
      nextLine: startLine, // do not advance — retry this batch next tick
      exported: 0,
      exhausted: false,
      error: lastResult.error ?? `http_${lastResult.statusCode}`,
    };
  }

  return {
    ok: true,
    nextLine,
    exported: entries.length,
    exhausted: entries.length < batchSize,
    error: null,
  };
}


// ---------------------------------------------------------------------------
// CLI entry point -- `node daemon/export-daemon.mjs --config <path> --checkpoint <path>`
// PR #62 Architect finding: this module had no daemon entry point/CLI runner,
// making it an orphaned library with no actual caller outside tests.
// ---------------------------------------------------------------------------

async function _readJsonConfig(configPath) {
  const { readFileSync, statSync } = await import('node:fs');
  try {
    // PR #62 round-3 fix: the config may hold a bearer token in
    // destination.headers -- warn (best-effort; not fatal, and Windows
    // doesn't expose POSIX mode bits) if the file is group/other readable.
    try {
      const mode = statSync(configPath).mode & 0o777;
      if (mode & 0o077) {
        console.warn(
          `[export-daemon] WARNING: config file ${configPath} is readable by `
          + `group/other (mode ${mode.toString(8)}). It may contain a bearer `
          + 'token in destination.headers -- consider `chmod 600`.'
        );
      }
    } catch {
      // statSync itself failing is handled by the outer readFileSync below.
    }
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    // PR #62 round-4 fix: log why the config was unreadable/unparseable so
    // operators can tell "malformed config" apart from "no config" -- both
    // used to silently produce the same off-by-default no-op.
    console.error(`[export-daemon] could not read/parse config ${configPath}: ${err.message}`);
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name) => {
    const idx = argv.indexOf(name);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const configPath = getArg('--config');
  const checkpointPath = getArg('--checkpoint');
  const pollMs = Number(getArg('--poll-ms')) || 5000;

  if (!configPath || !checkpointPath) {
    console.error('Usage: node daemon/export-daemon.mjs --config <path> --checkpoint <path> [--poll-ms N]');
    process.exit(1);
  }

  const raw = await _readJsonConfig(configPath);
  const { ok, config, error } = parseExportConfig(raw);
  if (!ok) {
    // Off-by-default: no config, disabled config, or invalid config -> exit cleanly, no export.
    console.log(`[export-daemon] not running: ${error}`);
    process.exit(0);
  }

  console.warn(
    '[export-daemon] WARNING: this process makes real outbound network calls. '
    + 'It is NOT part of KnoSky\'s no-egress core tool (it is not shipped in the '
    + 'published npm package -- see SECURITY.md, "Opt-in org export"). Only run '
    + 'this if your organization has deliberately configured its own destination.'
  );
  console.log(`[export-daemon] exporting to ${config.destination.url} (poll ${pollMs}ms)`);

  // PR #62 round-4 fix: persist the cursor next to the checkpoint file so a
  // daemon restart resumes where it left off instead of re-exporting every
  // record from line 0 (duplicate POSTs to the org's endpoint). Best-effort:
  // a missing/corrupt cursor file just falls back to 0, same as before.
  const { readFileSync: _readFileSync, writeFileSync: _writeFileSync } = await import('node:fs');
  const cursorPath = `${checkpointPath}.cursor`;
  let cursor = 0;
  try {
    const saved = Number(_readFileSync(cursorPath, 'utf8').trim());
    if (Number.isInteger(saved) && saved >= 0) cursor = saved;
  } catch {
    // No cursor file yet, or unreadable -- start from 0.
  }

  for (;;) {
    const result = await exportBatch(config, checkpointPath, cursor);
    if (!result.ok) {
      console.error(`[export-daemon] batch failed: ${result.error}`);
    } else if (result.exported > 0) {
      console.log(`[export-daemon] exported ${result.exported} record(s), cursor now ${result.nextLine}`);
      cursor = result.nextLine;
      try {
        _writeFileSync(cursorPath, String(cursor), 'utf8');
      } catch (err) {
        console.error(`[export-daemon] could not persist cursor to ${cursorPath}: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Cross-platform-safe entry-point check (PR #62 round-3 fix, round-5
// cleanup): the naive `file://${process.argv[1]}` string compare breaks on
// Windows (backslash paths) and paths with spaces/special characters.
// pathToFileURL normalizes both sides the same way Node does internally.
// PR #62 round-5 fix: pathToFileURL is now a static top-of-file import
// instead of a dynamic import that ran on every load of this module
// (including when imported as a library, e.g. by tests) just to evaluate a
// guard condition that only matters for direct CLI invocation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
