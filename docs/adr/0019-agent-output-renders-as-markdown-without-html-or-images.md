# 0019. Agent output renders as markdown without raw HTML or images

## Status

Accepted

## Context

Agent replies, subagent tasks and subagent reports are written in markdown, and showing them as literal text makes transcripts hard to read. Agent output is untrusted: a prompt-injected agent can write anything. Raw HTML in it would run in the dashboard, and a markdown image loads its URL on page view, which leaks whatever the agent put in that URL to a third party without a click, against ADR-0014's promise that a page view leaks nothing.

- Option 1: Keep everything preformatted. Safe, but unreadable.
- Option 2: Render full markdown with an HTML sanitiser. Richer output, but safety rests on the sanitiser's allowlist, and images still load on view.
- Option 3: Render markdown on the server with `markdown-it` and `html: false`, no auto-linking, only `http`, `https` and `mailto` links with `rel="noopener noreferrer nofollow"`, and no image rule.

## Decision

We will go with Option 3. Only prose renders as markdown: assistant messages, subagent tasks and subagent reports. Tool arguments, tool results, error text and paths stay preformatted.

## Consequences

Raw HTML in agent output shows as escaped text, and `![alt](url)` shows as plain text, so nothing an agent writes loads or runs on page view. Following a link takes a deliberate click. Agents cannot embed images in their reports, and adding images later means revisiting this decision rather than just enabling a rule.
