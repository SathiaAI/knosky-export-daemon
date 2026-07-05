# knosky-export-daemon

Opt-in, org-owned export daemon for [KnoSky](https://github.com/SathiaAI/knosky)
append-only checkpoints (SAT-546).

## This is a separate package on purpose

KnoSky's core tool (the indexer, the local MCP server, `npx knosky`) is
**no-egress by default and always** -- it never connects out, transmits
telemetry, or makes any third-party network call. That guarantee should not
have to depend on you trusting a comment in the source or a line in a test
file.

So this package lives entirely outside `knosky`:

- `knosky` never imports, requires, or ships any part of this package.
- Installing `knosky` does **not** install this package -- it is a
  completely separate `npm install knosky-export-daemon`, a deliberate,
  second decision.
- This package's only job is to read KnoSky's local append-only checkpoint
  file and forward new records to an HTTPS destination **your organization
  owns and operates** -- never a Sathia/KnoSky-operated endpoint.

If you never install this package, nothing in your KnoSky setup ever makes
a network call. Full stop.

## What it does

1. Reads new lines from a KnoSky checkpoint file (JSONL, append-only).
2. POSTs them, in batches, to the HTTPS URL in your config.
3. Persists a cursor next to the checkpoint file so a restart resumes where
   it left off instead of re-sending everything.
4. Does nothing at all -- exits cleanly -- if it isn't given a config, or the
   config is disabled, missing a destination, or not HTTPS.

## Usage

```bash
npm install knosky-export-daemon

cat > export-config.json <<'JSON'
{
  "destination": {
    "url": "https://logs.your-org.example.com/knosky/ingest",
    "headers": { "Authorization": "Bearer <your-token>" }
  },
  "batchSize": 100,
  "retryMax": 3
}
JSON
chmod 600 export-config.json   # it may contain a bearer token

npx knosky-export-daemon --config export-config.json --checkpoint /path/to/checkpoint.jsonl
```

The daemon prints an explicit warning on startup that it makes real network
calls, and again if your config file is readable by group/other (it may hold
a bearer token).

## Design constraints (D-193)

1. **Off by default** -- no export occurs unless `destination.url` is set.
2. **Org-owned** -- the destination is always an endpoint you own and
   operate, never one Sathia/KnoSky operates.
3. **No-egress preserved** -- KnoSky's evaluator process is never involved in
   export and gains no network capability in any configuration, regardless
   of whether this package is installed.
4. **Plain HTTPS POST** -- no SDK, no cloud vendor dependency. Pure Node
   stdlib `node:https`; zero third-party dependencies.

See [SECURITY.md in knosky](https://github.com/SathiaAI/knosky/blob/main/SECURITY.md)
for how this fits into KnoSky's broader no-egress guarantee.

## License

See [LICENSE.md](LICENSE.md).
