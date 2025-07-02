# Contributing to Meeting Bot 🤝

Thank you for your interest in contributing to Meeting Bot! This document provides guidelines and information for contributors.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)

## 🤝 Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. We are committed to providing a welcoming and inspiring community for all.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Git
- Docker (optional, for containerized development)

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/screenappai/meeting-bot.git
   cd meeting-bot
   ```
3. Add the upstream repository:
   ```bash
   git remote add upstream https://github.com/original-owner/meeting-bot.git
   ```

## 🛠️ Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

```bash
cp .env.example .env
# Edit .env with your local configuration
```

### 3. Start Development Server

**Option A: Local Development**
```bash
npm start
```

**Option B: Docker Development (Recommended)**
```bash
npm run dev
```

The server will be available at `http://localhost:3000`

### 4. Verify Installation

```bash
# Check if the server is running
curl http://localhost:3000/isbusy

# Run linting
npm run lint

# Run tests (if available)
npm test
```

## 🔧 Making Changes

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Your Changes

- Write clear, descriptive commit messages
- Follow the existing code style
- Add tests for new functionality
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run linting
npm run lint

# Run tests
npm test

# Test the API endpoints
curl -X POST http://localhost:3000/google/join \
  -H "Content-Type: application/json" \
  -d '{"bearerToken":"test","url":"https://meet.google.com/test","name":"Test Bot","teamId":"test","timezone":"UTC","userId":"test"}'
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Writing Tests

- Place test files next to the source files with `.test.ts` or `.spec.ts` extension
- Use descriptive test names
- Test both success and failure scenarios
- Mock external dependencies appropriately

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach } from '@playwright/test';

describe('GoogleMeetBot', () => {
  beforeEach(() => {
    // Setup test environment
  });

  it('should join a Google Meet successfully', async () => {
    // Test implementation
  });

  it('should handle invalid meeting URLs', async () => {
    // Test error handling
  });
});
```

## 📤 Submitting Changes

### 1. Commit Your Changes

```bash
git add .
git commit -m "feat: add support for new meeting platform"
```

### 2. Push to Your Fork

```bash
git push origin feature/your-feature-name
```

### 3. Create a Pull Request

1. Go to your fork on GitHub
2. Click "New Pull Request"
3. Select the base branch (usually `main`)
4. Fill out the PR template
5. Submit the PR

### 4. PR Template

When creating a PR, please include:

- **Description**: What does this PR do?
- **Type of Change**: Bug fix, feature, documentation, etc.
- **Testing**: How have you tested these changes?
- **Breaking Changes**: Does this introduce breaking changes?
- **Related Issues**: Link to any related issues

## 📝 Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Prefer interfaces over types for object shapes
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Use async/await over Promises when possible

### File Organization

```
src/
├── app/           # Express routes and middleware
├── bots/          # Platform-specific bot implementations
├── lib/           # Core utilities and libraries
├── services/      # Business logic
├── types/         # TypeScript type definitions
└── util/          # Helper functions
```

### Naming Conventions

- **Files**: kebab-case (`google-meet-bot.ts`)
- **Classes**: PascalCase (`GoogleMeetBot`)
- **Functions/Variables**: camelCase (`joinMeeting`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RECORDING_DURATION`)
- **Interfaces**: PascalCase with `I` prefix (`IMeetingConfig`)

### Code Formatting

We use ESLint and Prettier for code formatting:

```bash
# Format code
npm run lint

# Auto-fix issues
npm run lint:fix
```

## 🐛 Reporting Bugs

### Before Submitting

1. Check if the bug has already been reported
2. Try to reproduce the bug with the latest version
3. Check the documentation and existing issues

### Bug Report Template

```markdown
**Bug Description**
A clear description of what the bug is.

**Steps to Reproduce**
1. Go to '...'
2. Click on '....'
3. See error

**Expected Behavior**
What you expected to happen.

**Actual Behavior**
What actually happened.

**Environment**
- OS: [e.g. Windows 10, macOS, Linux]
- Node.js Version: [e.g. 18.0.0]
- Meeting Bot Version: [e.g. 1.0.0]

**Additional Context**
Any other context about the problem.
```

## 💡 Feature Requests

### Before Submitting

1. Check if the feature has already been requested
2. Consider if the feature aligns with the project's goals
3. Think about implementation complexity

### Feature Request Template

```markdown
**Feature Description**
A clear description of the feature you'd like to see.

**Use Case**
Why is this feature needed? What problem does it solve?

**Proposed Solution**
How would you like to see this implemented?

**Alternative Solutions**
Any alternative solutions you've considered.

**Additional Context**
Any other context or screenshots.
```

## 🏷️ Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools

### Examples

```bash
feat: add support for Microsoft Teams meetings
fix: resolve recording duration limit issue
docs: update API documentation
refactor: improve error handling in bot implementations
```

## 🎯 Getting Help

**🎯 Primary Support Channel:**
- **Discord**: [Join our Discord Community](https://discord.gg/yS62MZBH) - Our main forum for discussions, support, and real-time collaboration

**📋 Additional Resources:**
- **Issues**: [GitHub Issues](https://github.com/screenappai/meeting-bot/issues) - For bug reports and feature requests
- **Documentation**: Check the [README.md](README.md) and [Wiki](https://github.com/screenappai/meeting-bot/wiki) - For detailed guides and API documentation

## 🙏 Recognition

Contributors will be recognized in:

- The project's README.md file
- Release notes
- GitHub contributors page

Thank you for contributing to Meeting Bot! 🚀 