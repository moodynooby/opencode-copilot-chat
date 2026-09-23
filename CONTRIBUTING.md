# 🤝 Contributing

**Thank you for wanting to help!** 🎉 Every contribution counts — whether it's a typo fix, a bug report, a new model, or just a ⭐ star.

---

## 🎯 Ways to contribute (easy → hard)

| Level           | What                       | How                                                                                                                    |
| --------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ⭐ **Easiest**  | Star the repo              | Click ⭐ top-right                                                                                                     |
| 🐛 **Easy**     | Report a bug               | [Open an issue](https://github.com/moodynooby/moodynooby-copilot-chat/issues/new?template=bug_report.md)               |
| 💡 **Easy**     | Suggest a feature or model | [Open a discussion](https://github.com/moodynooby/moodynooby-copilot-chat/discussions)                                 |
| 📸 **Easy**     | Add a screenshot or GIF    | Drop in `docs/screenshots/`, open PR                                                                                   |
| 📝 **Medium**   | Fix a typo / improve docs  | Edit README or `docs/`, open PR                                                                                        |
| 🔧 **Medium**   | Fix a bug                  | Look for [`good first issue`](https://github.com/moodynooby/moodynooby-copilot-chat/labels/good%20first%20issue) label |
| 🚀 **Advanced** | Add a new model or feature | [Start a discussion](https://github.com/moodynooby/moodynooby-copilot-chat/discussions) first, then PR                 |

> **New to open source?** Start with [`good first issue`](https://github.com/moodynooby/moodynooby-copilot-chat/labels/good%20first%20issue) — those are picked specifically for newcomers.

---

## 🚀 Getting started (5 minutes)

```bash
# 1. Fork & clone
git clone https://github.com/YOUR-USERNAME/opencode-copilot-chat.git
cd opencode-copilot-chat

# 2. Install
npm install

# 3. Run in dev mode (press F5 in VS Code)
#    This opens a new VS Code window with the extension loaded
```

That's it! You can now test your changes in the Extension Development Host.

---

## 📋 Before you open a Pull Request

- [ ] `npm run compile` passes (no errors)
- [ ] `npm run lint` passes
- [ ] `npm test` passes (all unit tests)
- [ ] `npm run package` produces a VSIX
- [ ] `npm run test-retry` passes (E2E retry test)
- [ ] You tested it works (at least one model)
- [ ] You updated docs if needed (CHANGELOG, README, or `docs/`)

> **Don't worry about making it perfect.** Open the PR early — we can figure out the rest together. 💬

---

## 🧪 Validation Scripts

### `npm run test-retry` — E2E retry test (no API key needed)

Tests the runtime retry mechanism with a mock server. Proves that HTTP 400 → patch → retry → HTTP 200 works.

### `npm run validate-models` — Live API validation (requires API key)

Tests ALL thinking/reasoning parameter combinations for each model against the live OpenCode API. Reuses the extension's exact logic.

```powershell
$env:OPENCODE_API_KEY = "your-key"
npm run validate-models

# Test specific families
npm run validate-models -- --families deepseek,kimi

# Dry run (no API calls)
npm run validate-models -- --dry-run
```

---

## ⚠️ Automation Rules (AI Agents & Copilot)

If you are an AI agent (GitHub Copilot, ChatGPT, etc.) working on this repo:

1. **NEVER push without explicit permission.** Always ask "Should I push?" before running `git push`.
2. **NEVER create PRs or merge without asking.** Let the human decide when to push and create PRs.
3. **Commit only when asked.** Don't auto-commit unless the user explicitly requests it.
4. **Work on feature branches.** Never commit directly to `main` — always create a branch first.

These rules exist to prevent accidental pushes to production branches.

### Workflow expectations

- **Think first.** State assumptions explicitly; if context is missing or ambiguous, ask rather than guessing.
- **Surgical changes.** Don't refactor or "improve" adjacent code, comments, or formatting that isn't part of the task. Match existing style. Mention unrelated issues you notice — don't fix them unasked.
- **Fix root causes, not symptoms.** When a report names a symptom, grep every caller of the touched function and fix the shared logic once.
- **No bulk automation.** Never mass-edit values via scripts or find/replace — change things deliberately, one at a time.
- **Self-review.** After changes, re-read the diff as the next engineer (human or AI) who maintains this code.
- **Verify before claiming done.** Run `npm run compile` before saying a task is complete. Keep linting and formatting at their strictest configured level — never bypass a failing hook with `--no-verify`; fix the root cause instead.

---

## 💬 Questions?

[Start a discussion](https://github.com/moodynooby/moodynooby-copilot-chat/discussions) — no question is too small!

---

**Be kind. Be constructive. Assume good intent.** 🙏
