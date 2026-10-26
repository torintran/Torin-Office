/**
 * Role mapping for OpenCode task subagent_type → office role keys.
 * Mirrors hooks/agent-tracker.sh ROLE_MAP / NAME_MAP / TASK_ROLE_HINTS.
 */

export const ROLE_MAP = {
  debugger: 'debugger',
  'code-reviewer': 'code-reviewer',
  code_reviewer: 'code-reviewer',
  'frontend-developer': 'frontend-developer',
  frontend_developer: 'frontend-developer',
  'fullstack-developer': 'fullstack-developer',
  fullstack_developer: 'fullstack-developer',
  'test-engineer': 'test-engineer',
  test_engineer: 'test-engineer',
  'security-auditor': 'security-auditor',
  security_auditor: 'security-auditor',
  'architect-reviewer': 'architect-reviewer',
  architect_reviewer: 'architect-reviewer',
  'performance-engineer': 'performance-engineer',
  performance_engineer: 'performance-engineer',
  'devops-engineer': 'devops-engineer',
  devops_engineer: 'devops-engineer',
  'database-architect': 'database-architect',
  database_architect: 'database-architect',
  'typescript-pro': 'typescript-pro',
  typescript_pro: 'typescript-pro',
  'ai-engineer': 'ai-engineer',
  ai_engineer: 'ai-engineer',
  'prompt-engineer': 'prompt-engineer',
  prompt_engineer: 'prompt-engineer',
  'general-purpose': 'general-purpose',
  general_purpose: 'general-purpose',
  Explore: 'Explore',
  explore: 'Explore',
  build: 'general-purpose',
  plan: 'architect-reviewer',
}

export const NAME_MAP = {
  debugger: 'Debugger',
  'code-reviewer': 'Reviewer',
  'frontend-developer': 'Frontend',
  'fullstack-developer': 'Fullstack',
  'test-engineer': 'Tester',
  'security-auditor': 'Security',
  'architect-reviewer': 'Architect',
  'performance-engineer': 'PerfEng',
  'devops-engineer': 'DevOps',
  'database-architect': 'DBA',
  'typescript-pro': 'TS Pro',
  'ai-engineer': 'AI Eng',
  'prompt-engineer': 'Prompts',
  'general-purpose': 'Agent',
  Explore: 'Explorer',
}

const TASK_ROLE_HINTS = [
  [/\b(test|tests|testing|spec|coverage)\b/i, 'test-engineer'],
  [/\b(review|audit the diff|code review)\b/i, 'code-reviewer'],
  [/\b(debug|bug|crash|stack ?trace|failing)\b/i, 'debugger'],
  [/\b(security|vuln|cve|auth\b|secret)/i, 'security-auditor'],
  [/\b(frontend|ui|css|react|component|layout)\b/i, 'frontend-developer'],
  [/\b(perf|performance|latency|profil)/i, 'performance-engineer'],
  [/\b(deploy|ci|docker|pipeline|infra)\b/i, 'devops-engineer'],
  [/\b(database|sql|schema|migration|query)\b/i, 'database-architect'],
  [/\b(architecture|design doc|refactor plan)\b/i, 'architect-reviewer'],
]

export function roleFor(subagentType, task = '') {
  let role = ROLE_MAP[subagentType] || 'general-purpose'
  if (role === 'general-purpose' && task) {
    for (const [pattern, hinted] of TASK_ROLE_HINTS) {
      if (pattern.test(task)) return hinted
    }
  }
  return role
}

export function nameFor(role) {
  return NAME_MAP[role] || 'Agent'
}
