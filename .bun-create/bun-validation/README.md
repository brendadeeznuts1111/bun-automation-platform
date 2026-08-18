# bun-validation starter

Scaffolded with `bun create bun-validation` (local `.bun-create` template).

```sh
bun install
# Until bun-validation is published, link the workspace crate:
# bun add file:../path/to/packages/bun-validation

bun run validate -- 0.0.0
bun run validate:all
```

Put release artifacts at `releases/bun-v<version>/{extracted,normalized}.json`.
A sample `releases/bun-v0.0.0` is included so the first `validate` run works.
