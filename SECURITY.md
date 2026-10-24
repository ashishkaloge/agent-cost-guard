# Security policy

## Supported version

The latest 0.1.x preview and the latest commit on `main` receive fixes.

## Report a vulnerability

Use GitHub private vulnerability reporting when it is available for this
repository. Do not open a public issue for a security problem.

Useful reports include:

- an unsafe `allow` decision for a cost-bearing action;
- a parser or hook-adapter bypass;
- credential leakage or incomplete redaction;
- command execution, shell evaluation, or unexpected network access;
- a way to disable or alter the active policy without being detected.

Include a minimal reproduction using fake credentials and fake cloud resources.
Do not test against infrastructure you do not own.
