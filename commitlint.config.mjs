// Conventional Commits drive the version bump in release-please:
//   fix: ...            -> patch (2.0.0 -> 2.0.1)
//   feat: ...           -> minor (2.0.0 -> 2.1.0)
//   feat!: / BREAKING CHANGE: -> major (2.0.0 -> 3.0.0)
// chore/docs/test/ci/refactor/style/build/perf do not trigger a release on their own.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [1, 'always', ['overlay', 'audio', 'stt', 'llm', 'rag', 'dashboard', 'ui', 'updater', 'flags', 'calendar', 'ci', 'deps', 'release']],
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0]
  }
};
