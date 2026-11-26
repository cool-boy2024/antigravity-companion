# Internal contract

Node.js 22, ESM, no production dependencies. Core exports live in `src/core.js`.

## Core API

- `createTask(input)` returns `{id,title,goal,constraints:[],decisions:[],nextSteps:[],createdAt,updatedAt,checks:[],notes:[]}`. IDs UUIDs. Input strings bounded; constraints/decisions/nextSteps arrays of strings.
- `validateTask(value)` returns a normalized task or throws; never accepts a check as verified from an imported JSON.
- `readState(workspace)` async returns `{version:1,tasks:[],events:[]}`. Storage under `.antigravity-companion/`, modes 0700/0600. Internal files never published.
- `addTask(workspace,input)` and `updateTask(workspace,id,patch)` async return task. Updates only title/goal/constraints/decisions/nextSteps; no client-controlled checks.
- `addNote(workspace,id,text)` async returns task. Notes `{id,text,createdAt,source:'manual'}`.
- `appendEvent(workspace,eventName,payload)` async writes one event atomically; only allowlisted metadata, no tool args/user prompts/transcript contents/tokens. Supported official events SessionStart/PreInvocation/PostInvocation/PostToolUse/Stop; omit PreToolUse so permission decisions stay unchanged.
- `recordCheck(workspace,id,check)` async adds local runner evidence; used by CLI only, not HTTP API. Check `{id,argv,exitCode,signal,startedAt,finishedAt,beforeFingerprint,afterFingerprint,output,source:'local-runner'}`.
- `workspaceFingerprint(workspace)` async returns a stable SHA256 string for non-ignored project content. Excludes state, .git, node_modules; symlinks not followed. Bounds work and fails if unable to cover snapshot, never claims full freshness from a partial snapshot.
- `buildReceipt(task,currentFingerprint)` returns `{status:'passed'|'failed'|'stale'|'unverified',checks:[...checks,{verdict}],warnings:[]}`. A passed check requires exitCode 0, no signal, unchanged before/after/current fingerprint and local provenance. Imported checks never become locally verified. Passed means recorded commands passed, not full requirements acceptance.
- `buildHandoff(task,receipt,{target='generic'}={})` returns Markdown including goals, constraints, decisions, nextSteps and validation state, explicit provenance. `target` generic/codex/claude/antigravity changes heading only, never inserts instructions to bypass approvals.
- `summarizeEvents(events,now=Date.now())` returns `{sessions:[],alerts:[]}`. Session `{id,model,status,lastEventAt,toolCount,errorCount}`. Status working/idle/background/unknown. Alerts `{level,message,sessionId}` based on observed errors/elapsed time; no event alone proves tests passed. Stop fullyIdle false => background; quiet => unknown not blocked.

Event output `{id,eventName,conversationId,modelName,toolName,hasError,fullyIdle,createdAt}`; conversations are identifiers not paths. Error body is not retained.

## HTTP interface (root implements)

GET /api/state => `{workspaceName,tasks:[...task,receipt],events,activity:{sessions,alerts},capabilities:{...}}`.
POST /api/tasks JSON fields title/goal/constraints/decisions/nextSteps => task.
PATCH /api/tasks/:uuid => updateTask.
POST /api/tasks/:uuid/notes `{text}` => task.
POST /api/import `{task: exportedTask}` => NEW task with new local ID, imported assertions only, checks are not local evidence.
GET /api/tasks/:uuid/handoff?target=codex => `{markdown}`.
GET /api/tasks/:uuid/export => JSON safe exchange object; redact obvious tokens and machine paths, prompt user review before external sharing.
GET /api/competitors => curated dated feature JSON from data/competitors.json (root writes).
All APIs require Bearer session token supplied in URL fragment on UI launch. Same-origin, loopback only, no CORS. No command execution HTTP endpoint. 256KB body limit. UI uses textContent, never renders imported Markdown as HTML.
