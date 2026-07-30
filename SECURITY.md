# Security

## Supported versions

Pre-1.0: only the latest published version gets fixes. Check with
`npm view open-take version` and upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

> [Security tab](https://github.com/pascal910107/open-take/security) → *Report a
> vulnerability*

That opens a private advisory only the maintainers can see. Please include the
version, the platform, and the smallest reproduction you have. Expect a first
response within a week; if a report is confirmed, the fix ships in a patch
release and the advisory is published with credit unless you ask otherwise.

## What the tool actually does

Useful context for judging whether something is a real finding. Open Take
drives a real browser against an app you point it at, records the screen, and
writes files into your project:

- **It runs a browser it downloaded.** Chrome for Testing is fetched on first
  use into `~/.open-take/browsers` and driven over CDP.
- **It spawns ffmpeg/ffprobe** — PATH binaries if present, otherwise the
  bundled `@ffmpeg-installer` / `@ffprobe-installer` platform binaries.
- **It writes to your working tree** — a take is `demo.mp4` plus a `demo.take/`
  directory beside it.
- **`open-take edit` starts a local HTTP server.** It binds `127.0.0.1` only
  (never `0.0.0.0`), and mutating requests are gated on the `Host` header, a
  same-origin check and a JSON content type — that is deliberate DNS-rebinding
  and CSRF defense. A way around any of those is in scope.
- **It is driven by an agent**, so `SKILL.md` and the CLI's arguments are, in
  practice, an interface an LLM writes into.

## In scope

- Escaping the take directory, or writing outside the working tree, via `--out`
  or any other path input.
- Reaching the `edit` bridge from another origin, another host, or a rebound
  DNS name; anything that gets a write past its checks.
- Code execution from a crafted `composition.json`, `CaptureLog`, or take
  directory — these are files a user may receive from someone else.
- Anything that could get code into a published tarball, or onto npm under this
  project's name, without a maintainer's tag.
- Credential or token exposure in logs, rendered frames, or the composition.

## Out of scope

- Secrets that were visible on screen while you recorded. The capture is a
  screen recording; it faithfully contains whatever your app displayed. Review
  the video before posting it.
- Vulnerabilities in upstream dependencies with no path to exploit them through
  Open Take. Report those upstream; tell us if there is a reachable path here.
- Resource exhaustion on your own machine from rendering a very long take.
- Anything that requires the attacker to already be running code as your user.
