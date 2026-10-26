// Conventional Commits (https://www.conventionalcommits.org) drive the version
// bump in release-please:
//   fix: ...                    -> patch (2.0.0 -> 2.0.1)
//   feat: ...                   -> minor (2.0.0 -> 2.1.0)
//   feat!: / BREAKING CHANGE:   -> major (2.0.0 -> 3.0.0)
// build, chore, ci, docs, perf, refactor, revert, style and test do not cut a
// release on their own (perf still shows up in the changelog).
//
// Scopes follow the repository layout; see CONTRIBUTING.md.
const scopes = [
  // native engine (src/)
  'core', 'engine', 'audio', 'stt', 'llm', 'rag', 'net', 'overlay', 'app',
  // dashboard (apps/dashboard)
  'dashboard', 'ui', 'updater', 'flags', 'calendar',
  // repository
  'build', 'cmake', 'ci', 'deps', 'deps-dev', 'docs', 'release', 'repo', 'scripts', 'tests'
];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', scopes],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
    'footer-max-line-length': [0]
  }
};
