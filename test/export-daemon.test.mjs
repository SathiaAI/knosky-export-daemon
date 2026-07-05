// knosky-export-daemon — tests (SAT-546, split out of knosky PR #62).
//
// Coverage (renumbered from the original F02-008..F02-016 block in
// knosky's test/append-only-checkpoint.test.mjs, before the export daemon
// was split into this separate package):
//   ED-001  parseExportConfig: off-by-default (null/false/absent -> ok=false).
//   ED-002  parseExportConfig: missing/non-HTTPS destination -> ok=false.
//   ED-003  parseExportConfig: valid HTTPS destination -> ok=true.
//   ED-004  parseExportConfig: non-HTTPS (http://) destination -> ok=false.
//   ED-005  readCheckpointLines reads and parses JSONL correctly.
//   ED-006  readCheckpointLines skips blank lines, warns on malformed JSON.
//   ED-007  readCheckpointLines respects startLine cursor and limit.
//   ED-008  exportBatch returns exhausted=true when checkpoint has no new lines.
//   ED-009  exportBatch returns ok=false on filesystem error (missing file).
//
// This package has NO relationship to knosky's no-egress core tool: knosky
// never imports, requires, or ships this package. It exists only for an
// organization that has deliberately chosen to `npm install
// knosky-export-daemon` and configure its own HTTPS destination.
//
// Run: node test/export-daemon.test.mjs

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseExportConfig,
  readCheckpointLines,
  exportBatch,
} from '../export-daemon.mjs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// Temp directory for all on-disk tests.
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), 'knosky-export-daemon-test-'));

function testPath(...parts) {
  return join(tmpDir, ...parts);
}

// Local JSONL fixture writer -- avoids a test-only dependency on
// knosky's checkpoint module (this package has none at runtime either).
function writeJsonlLine(path, entry) {
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
}

// ===========================================================================
// ED-001  parseExportConfig: off by default
// ===========================================================================
console.log('\n--- ED-001  parseExportConfig: off-by-default ---');

{
  for (const absent of [null, undefined, false]) {
    const r = parseExportConfig(absent);
    ok(`ED-001: parseExportConfig(${JSON.stringify(absent)}) → ok=false`, r.ok === false,
      JSON.stringify(r));
    ok(`ED-001: error is export_not_configured for ${JSON.stringify(absent)}`,
      r.error === 'export_not_configured', r.error);
  }
}

// ===========================================================================
// ED-002  parseExportConfig: missing/malformed destination → ok=false
// ===========================================================================
console.log('\n--- ED-002  parseExportConfig: invalid destination ---');

{
  const cases = [
    [{}, 'export_config_missing_destination'],
    [{ destination: null }, 'export_config_missing_destination'],
    [{ destination: 'not-an-object' }, 'export_config_missing_destination'],
    [{ destination: {} }, 'export_destination_url_missing'],
    [{ destination: { url: '' } }, 'export_destination_url_missing'],
    [{ destination: { url: 'not-a-url' } }, 'export_destination_url_invalid: not-a-url'],
  ];
  for (const [cfg, expectedErr] of cases) {
    const r = parseExportConfig(cfg);
    ok(`ED-002: ok=false for ${JSON.stringify(cfg).slice(0, 60)}`, r.ok === false,
      JSON.stringify(r));
    ok(`ED-002: error starts with ${expectedErr.slice(0, 40)}`,
      typeof r.error === 'string' && r.error.startsWith(expectedErr.split(':')[0]),
      r.error);
  }
}

// ===========================================================================
// ED-003  parseExportConfig: valid HTTPS destination → ok=true
// ===========================================================================
console.log('\n--- ED-003  parseExportConfig: valid HTTPS destination ---');

{
  const cfg = {
    destination: {
      url: 'https://logs.example-org.com/knosky/ingest',
      headers: { Authorization: 'Bearer secret' },
    },
  };
  const r = parseExportConfig(cfg);
  ok('ED-003: ok=true for valid HTTPS destination', r.ok === true, JSON.stringify(r));
  ok('ED-003: config.destination.url preserved', r.config?.destination?.url === cfg.destination.url);
  ok('ED-003: config.destination.headers preserved',
    r.config?.destination?.headers?.Authorization === 'Bearer secret');
  ok('ED-003: config.batchSize is DEFAULT_BATCH_SIZE (100)',
    r.config?.batchSize === 100, String(r.config?.batchSize));
  ok('ED-003: config.retryMax is DEFAULT_RETRY_MAX (3)',
    r.config?.retryMax === 3, String(r.config?.retryMax));

  // Custom batchSize / retryMax respected.
  const cfg2 = { destination: { url: 'https://org.example/ep' }, batchSize: 50, retryMax: 1 };
  const r2 = parseExportConfig(cfg2);
  ok('ED-003: custom batchSize=50 respected', r2.config?.batchSize === 50);
  ok('ED-003: custom retryMax=1 respected', r2.config?.retryMax === 1);
}

// ===========================================================================
// ED-004  parseExportConfig: http:// (non-HTTPS) destination → ok=false
// ===========================================================================
console.log('\n--- ED-004  parseExportConfig: http:// rejected ---');

{
  const r = parseExportConfig({ destination: { url: 'http://org.example/ep' } });
  ok('ED-004: http:// destination is rejected', r.ok === false, JSON.stringify(r));
  ok('ED-004: error mentions must_be_https',
    typeof r.error === 'string' && r.error.includes('must_be_https'), r.error);
}

// ===========================================================================
// ED-005  readCheckpointLines reads and parses JSONL correctly
// ===========================================================================
console.log('\n--- ED-005  readCheckpointLines reads JSONL ---');

{
  const p = testPath('f02-012.jsonl');
  const entries = [
    { seq: 1, event: 'a' },
    { seq: 2, event: 'b' },
    { seq: 3, event: 'c' },
  ];
  for (const e of entries) writeJsonlLine(p, e);

  const { entries: read, nextLine } = await readCheckpointLines(p, 0, 10);
  ok('ED-005: reads 3 entries', read.length === 3, String(read.length));
  ok('ED-005: entry 0 is seq=1', read[0].seq === 1);
  ok('ED-005: entry 1 is seq=2', read[1].seq === 2);
  ok('ED-005: entry 2 is seq=3', read[2].seq === 3);
  ok('ED-005: nextLine is 3', nextLine === 3, String(nextLine));
}

// ===========================================================================
// ED-006  readCheckpointLines skips blank lines; warns on malformed JSON
// ===========================================================================
console.log('\n--- ED-006  readCheckpointLines: blank/malformed handling ---');

{
  const p = testPath('f02-013.jsonl');
  // Write a file with blank lines and one malformed line.
  const content = [
    '{"seq":1,"event":"ok1"}',
    '',                                   // blank
    'NOT VALID JSON',                     // malformed — should be skipped with warning
    '{"seq":2,"event":"ok2"}',
    '',                                   // trailing blank
  ].join('\n') + '\n';
  writeFileSync(p, content, 'utf8');

  // Capture warnings emitted during parsing.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  const { entries: read } = await readCheckpointLines(p, 0, 10);

  console.warn = origWarn;   // restore

  ok('ED-006: 2 valid entries returned (blank + malformed skipped)',
    read.length === 2, String(read.length));
  ok('ED-006: entry 0 is seq=1', read[0]?.seq === 1);
  ok('ED-006: entry 1 is seq=2', read[1]?.seq === 2);
  ok('ED-006: warning emitted for malformed line',
    warnings.some(w => w.includes('malformed') || w.includes('export-daemon')),
    warnings.join('; ').slice(0, 200));
}

// ===========================================================================
// ED-007  readCheckpointLines respects startLine and limit
// ===========================================================================
console.log('\n--- ED-007  readCheckpointLines: startLine and limit ---');

{
  const p = testPath('f02-014.jsonl');
  for (let i = 1; i <= 5; i++) writeJsonlLine(p, { seq: i });

  // Read from line 2 (0-indexed), limit 2.
  const { entries: read, nextLine } = await readCheckpointLines(p, 2, 2);
  ok('ED-007: 2 entries returned', read.length === 2, String(read.length));
  ok('ED-007: first entry is seq=3 (skip first 2 lines)', read[0].seq === 3,
    String(read[0].seq));
  ok('ED-007: second entry is seq=4', read[1].seq === 4, String(read[1].seq));
  ok('ED-007: nextLine is 4 (startLine + entries read)', nextLine === 4, String(nextLine));
}

// ===========================================================================
// ED-008  exportBatch returns exhausted=true when no new lines
// ===========================================================================
console.log('\n--- ED-008  exportBatch exhausted=true on empty cursor ---');

{
  const p = testPath('f02-015.jsonl');
  // Write 2 entries.
  writeJsonlLine(p, { seq: 1 });
  writeJsonlLine(p, { seq: 2 });

  const cfgResult = parseExportConfig({
    destination: { url: 'https://org.example/ep' },
  });
  ok('ED-008: config parsed ok', cfgResult.ok === true);

  // Start cursor at 2 (past the end) — no new entries.
  const result = await exportBatch(cfgResult.config, p, 2);
  ok('ED-008: ok=true', result.ok === true, JSON.stringify(result));
  ok('ED-008: exhausted=true', result.exhausted === true);
  ok('ED-008: exported=0', result.exported === 0);
  ok('ED-008: nextLine=2 (unchanged)', result.nextLine === 2, String(result.nextLine));
}

// ===========================================================================
// ED-009  exportBatch returns ok=false on filesystem read error
// ===========================================================================
console.log('\n--- ED-009  exportBatch ok=false for missing checkpoint file ---');

{
  const p = testPath('does-not-exist-f02-016.jsonl');
  const cfgResult = parseExportConfig({ destination: { url: 'https://org.example/ep' } });

  const result = await exportBatch(cfgResult.config, p, 0);
  ok('ED-009: ok=false when checkpoint file missing', result.ok === false, JSON.stringify(result));
  ok('ED-009: error is a non-empty string', typeof result.error === 'string' && result.error.length > 0,
    result.error);
  ok('ED-009: nextLine unchanged at 0', result.nextLine === 0, String(result.nextLine));
}

// ===========================================================================

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
rmSync(tmpDir, { recursive: true, force: true });

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
