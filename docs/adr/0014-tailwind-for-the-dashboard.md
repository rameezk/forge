# 0014. Tailwind for the dashboard, built into a self-hosted stylesheet

## Status

Accepted

## Context

The dashboard is server-rendered by Hono with no client JS and no build step, and all of its styling is one CSS string inlined into every page. That string grows with each page, has no shared tokens, and hardcodes its status colours. The dashboard is reachable only on localhost through a tunnel.

- Option 1: Tailwind v4. Utility classes in the templates, design tokens in one `@theme` block, and a build step that scans the templates and emits a static stylesheet.
- Option 2: Pico CSS. Classless styling themed through CSS variables, served straight from `node_modules` with no build step, but with Pico's look and less fine control.
- Option 3: No framework. Move the inline CSS into a stylesheet with custom-property tokens.

Separately, the stylesheet can come from a CDN or be served by the dashboard itself.

## Decision

We will go with Option 1: Tailwind v4. `@tailwindcss/cli` builds the stylesheet in the Nix build, and the dashboard serves it itself under a content-hashed path with long-lived caching. The dashboard loads nothing from a CDN.

## Consequences

The runtime package gains a CSS build step, both in Nix and in a watch script for local work, and the templates carry utility classes instead of semantic class names. The colour scheme lives in one place as tokens. The dashboard keeps working with no outbound network from the browser, and a page view leaks nothing to a third party.
