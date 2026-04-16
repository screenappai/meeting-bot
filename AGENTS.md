# Agent Contract: Meeting Bot

## Mission
Build and operate meeting automation across controller, manager, and TypeScript service layers with reliable capture, orchestration, and observability.

## Mandatory Traversal Workflow
1. Read this file.
2. Read `.ai/repo-manifest.yaml`.
3. For code tasks, query `codebase_memory` first (symbols, call-paths, cross-layer references).
4. Open only top-ranked files before editing.
5. Use `local_rag` only for docs/spec tasks (`README.md`, `DEPLOYMENT.md`, markdown/PDF notes).
6. Fall back to `rg` only when MCP retrieval is unavailable or low confidence.

## Guardrails
- Never push directly to `main`, `master`, or `develop`.
- Use worktree/branch/PR workflow for all changes.
- Keep Python controller/manager behavior aligned with TypeScript service contracts.
- Prefer incremental, test-backed changes for orchestration and shutdown paths.

## High-Signal Paths
- TypeScript service layer: `src/`
- Browser/controller flows: `controller/`
- Manager pipeline: `manager/`
- Test and ops artifacts: `tests/`, `scripts/`, `docker-compose.yml`

## Pre-PR Validation
- Run commands from `.ai/repo-manifest.yaml` under `test_commands`.
- Run targeted smoke checks for affected runtime path.
