# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Ground rules

- **Edit the sources, not the generated JSON.** Logic lives in `src/` (tested, dependency-free) and `scripts/node-code/` (thin n8n glue). The files in `workflows/` are generated:

  ```bash
  npm run build   # regenerate workflows/*.json
  npm run check   # CI uses this: fails if the JSON is stale or a Code node does not compile
  npm test        # unit tests + workflow simulation (real Code-node code, mocked HTTP)
  ```

- Keep `src/` free of runtime dependencies (it is inlined into n8n Code nodes).
- Anything that writes to HubSpot or posts to Slack must respect `SANDBOX_MODE`.
- Never commit secrets, real contact data, portal IDs, or webhook URLs. Sample data must use reserved domains (`example.com`).
- Add or update tests with every behavior change.

## Reporting problems

Please include your n8n version, which workflow/node failed, and the error text with secrets and personal data removed.
