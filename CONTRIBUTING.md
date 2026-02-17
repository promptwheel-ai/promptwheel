# Contributing to PromptWheel

Thanks for your interest in contributing to PromptWheel!

## Getting Started

### Prerequisites

- Node.js 18+
- Claude Code CLI (`npm i -g @anthropic-ai/claude-code`)

### Setup

```bash
# Clone the repo
git clone https://github.com/promptwheel-ai/promptwheel.git
cd promptwheel

# Install dependencies
npm install

# Run the CLI in development
npx tsx packages/cli/src/bin/promptwheel.ts solo --help
```

## Project Structure

```
promptwheel/
├── packages/
│   ├── cli/          # Main CLI (promptwheel solo)
│   ├── core/         # Core types and utilities
│   └── sqlite/       # SQLite adapter for solo mode
├── docs/             # Documentation
```

## Development Workflow

### Making Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Run type check (`npm run typecheck`)
6. Commit with a descriptive message
7. Push and create a PR

### Commit Messages

We use conventional commits:

```
feat: Add new scout category for performance
fix: Handle edge case in scope expansion
docs: Update README with new examples
refactor: Extract duplicate code in solo.ts
test: Add tests for deduplication logic
chore: Update dependencies
```

### Code Style

- TypeScript strict mode
- ESLint for linting (`npm run lint`)

## Areas to Contribute

### Good First Issues

- Documentation improvements
- Adding tests
- Bug fixes with clear reproduction steps

### Larger Contributions

- New scout categories
- New formulas
- Performance improvements

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- packages/cli/src/test/solo-hints.test.ts

# Run with coverage
npm test -- --coverage
```

## Questions?

- Open an issue for bugs or feature requests
- Discussions for general questions

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
