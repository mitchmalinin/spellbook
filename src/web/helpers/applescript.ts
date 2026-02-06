export function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"');    // Escape double quotes
}

export function extractWorkItemReference(sessionName: string): string | null {
  // Patterns to match: "Bug 79", "bug-79", "bug_79", "bug79", "feature/48", etc.
  const patterns = [
    { regex: /bug[\s\-_\/]?(\d+)/i, prefix: 'bug' },
    { regex: /improvement[\s\-_\/]?(\d+)/i, prefix: 'improvement' },
    { regex: /feature[\s\-_\/]?(\d+)/i, prefix: 'feature' },
  ];

  for (const { regex, prefix } of patterns) {
    const match = sessionName.match(regex);
    if (match && match[1]) {
      return `${prefix}-${match[1]}`;
    }
  }

  return null;
}
