# Contributing

Thanks for your interest in Tumble Royale.

## Maintenance status

This project is published as-is and is **not actively maintained**. Issues
and pull requests are welcome, but responses may be slow or may not come at
all. If you want to take the game somewhere new, forking is encouraged; the
MIT license allows it.

## Before opening a pull request

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries
  and the shared contracts, and [DECISIONS.md](DECISIONS.md) for the
  reasoning behind non-obvious choices.
- Keep the simulation deterministic. `packages/sim`, `shared`, `netcode` and
  `content` must not use the DOM, three.js, `Date.now()` or `Math.random()`;
  lint enforces this.
- Run the checks CI runs:

  ```sh
  pnpm lint
  pnpm format:check
  pnpm typecheck
  pnpm test
  ```

- For gameplay or rendering changes, include a screenshot or short clip. The
  sandbox pages (`/playground.html`, `/level.html`, `/obstacles.html`, …) are
  the quickest way to show a change in isolation.
- Keep pull requests focused: one fix or feature per PR.

## Content

All characters, rounds, obstacles, cosmetics, music and sound effects must
be original. Don't submit names, art, audio or designs taken from existing
games.

## Reporting bugs

Open an issue with steps to reproduce, the browser and GPU backend (shown in
the `?debug=1` stats overlay), and any console errors. For security issues,
see [SECURITY.md](SECURITY.md) instead.
