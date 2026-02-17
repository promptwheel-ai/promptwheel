# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@promptwheel.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Resolution Timeline**: Depends on severity, typically 30-90 days

### Scope

This policy applies to:
- `@promptwheel/cli`
- `@promptwheel/core`
- `@promptwheel/sqlite`

### Out of Scope

- Issues in dependencies (report to the dependency maintainers)
- Social engineering attacks
- Denial of service attacks

## Security Best Practices

When using PromptWheel:

1. **API Keys**: Never commit API keys. Use environment variables.
2. **Allowed Paths**: Configure `allowed_paths` to restrict what PromptWheel can modify.
3. **Review Changes**: Always review generated PRs before merging.
4. **Credentials**: Don't store credentials in `.promptwheel/` directory.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.5   | No        |

We recommend always using the latest version.
