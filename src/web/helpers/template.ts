const TYPE_LABELS: Record<string, string> = {
  bug: 'Bug',
  improvement: 'Improvement',
  feature: 'Feature',
};

export function generatePlanTemplate(type: string, number: number, slug: string): string {
  const today = new Date().toISOString().split('T')[0];
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel = TYPE_LABELS[type] || 'Feature';

  return `---
status: planning
created: ${today}
last_session: ${today}
phase: 0
---

# Implementation Plan: ${typeLabel} #${number}

## Overview
${title}

## Phases

### Phase 1: Analysis & Setup
- [ ] Review the issue/improvement description
- [ ] Identify affected files and code paths
- [ ] Determine testing strategy

### Phase 2: Implementation
- [ ] [Add specific implementation tasks]

### Phase 3: Testing & Validation
- [ ] Write/update unit tests
- [ ] Manual testing
- [ ] Code review prep

## Session Log

### ${today} - Planning Session
- Created initial plan
- [Add notes as you work]

## Session Handoff

**Last completed:** Initial planning
**Next step:** Begin Phase 1 analysis
**Blocked:** None
**Warnings:** None

## How to Continue
Read this plan file. We're in the planning phase. Start by reviewing the main document and identifying the specific implementation approach.
`;
}
