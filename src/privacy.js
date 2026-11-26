// A best-effort sharing filter, never a promise that arbitrary prose is secret-free.
export function redact(value) {
  return String(value)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[=:]\s*)(["'])([^\r\n]*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/g, (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) { parsed.username = 'REDACTED'; parsed.password = ''; }
        for (const key of [...parsed.searchParams.keys()]) {
          if (/token|key|secret|password|auth|signature/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
        }
        return parsed.toString();
      } catch { return '[invalid URL]'; }
    })
    .replace(/\/(?:Users|home)\/[^\s/]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\s\\]+/g, '~');
}

export function redactObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  }
  return value;
}

export function exchangeTask(task) {
  return redactObject({
    schemaVersion: 1,
    title: task.title,
    goal: task.goal,
    constraints: task.constraints,
    decisions: task.decisions,
    nextSteps: task.nextSteps,
    notes: task.notes.map((note) => ({ text: note.text, source: 'imported-assertion' })),
    checks: task.checks.map((check) => ({
      argv: check.argv,
      exitCode: check.exitCode,
      signal: check.signal,
      finishedAt: check.finishedAt,
      source: 'imported-assertion',
      // Outputs can contain private source, so exchange exports omit them.
    })),
  });
}
