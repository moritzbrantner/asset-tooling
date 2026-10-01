# Selected-bundle adoption

[adoption.ts](adoption.ts) is the source-owned recipe and package-only pixel acceptance. [consumer.ts](consumer.ts) calls its supported `asset-tooling/examples/selected-bundle` export. The recipe creates the existing strong ring artwork, encodes PNG through the declared FFmpeg codec, exports the existing static bundle, verifies its expected manifest pin, and decodes the packaged PNG in an independent consumer store. Acceptance checks dimensions, transparent center/border, and opaque colored stroke.

This is the first bounded distribution/adoption slice of #125 and coding-tooling#273. It establishes static-image recipe provenance and package transport. It does not establish rigged characters, rest/idle/walk deformation, approved production artwork, or game integration from #110/#125.

## Producer checks

Use Bun 1.4.2, FFmpeg and FFprobe already installed on PATH. Codec identities and the producer dependency lock are recorded by the existing operations. No source acquisition, sibling repository, Blender installation, or network call is needed during recipe/acceptance execution.

```sh
bun install --frozen-lockfile
bun run example:selected-bundle
bun run verify:consumer:bundle
```

The second command explicitly generates disposable artifacts. The third packs the actual package, installs it into a fresh disposable consumer, executes the public entrypoint twice, and checks unchanged distribution bytes/mtime and preserved user content. It then deletes only the fixture producer store, proves package-only acceptance, rejects corrupted payloads without repairing them, rejects a broken public export, and rejects an unavailable codec. Installation is the declared network setup phase; subsequent recipe and verification execution is offline. The ordinary `check` remains separate; hosted `selected-bundle-consumer` runs this heavier installed-package check with an explicitly installed codec.

## Fresh consumer through the existing generator

Use a fresh disposable directory. Set `ASSET_SOURCE` to this producer checkout, `CONSUMER_ROOT` to that new directory, and `CODING_TOOLING_CLI` to an explicitly available coding-tooling CLI source path. The CLI is a setup prerequisite for generation only; the app uses the installed asset-tooling package at runtime.

```sh
bun pm pack --filename /tmp/asset-tooling-adoption.tgz
mkdir "$CONSUMER_ROOT"
cp /tmp/asset-tooling-adoption.tgz "$CONSUMER_ROOT/asset-tooling.tgz"
cp "$ASSET_SOURCE/examples/selected-bundle/consumer-package.json" "$CONSUMER_ROOT/package.json"
bun install --cwd "$CONSUMER_ROOT"
bun install --cwd "$CONSUMER_ROOT" --frozen-lockfile
bun "$CODING_TOOLING_CLI" generate describe selected-bundle --json
bun "$CODING_TOOLING_CLI" generate plan selected-bundle --target "$CONSUMER_ROOT" --json
bun "$CODING_TOOLING_CLI" generate selected-bundle --target "$CONSUMER_ROOT" --json
bun run --cwd "$CONSUMER_ROOT" accept
```

Run CLI generator commands from the producer root so its local generator is selected. Initial archive/manifest staging above is for a fresh directory; never copy them over an existing project. Repeating the two install commands and the generator preserves existing app files and user notes; identical generation performs no writes. Conflicting `consumer.ts` is reported before mutation. The generator checks declared Bun/FFmpeg/FFprobe and installed package prerequisites; it claims no semantic postcondition from creating a file. `accept` must actually execute and report `accepted: true`; a zero-test process is insufficient.

Task discovery is non-mutating:

```sh
bun "$CODING_TOOLING_CLI" inspect --target examples/selected-bundle/adoption.ts --task-kind asset-adoption --task-context --json
```

An expected manifest `AssetRef` is the deliberate handoff trust anchor. Do not trust an arbitrary downloaded manifest as its own expected pin. Consumer verification reads only selected distribution bytes and never reacquires source inputs or repairs artifacts.

## Full selected inventory

[build.ts](build.ts) is the existing two-tree/two-PNG inventory example. It requires the separately declared tree and effect-artwork builds and their pinned inputs/tooling; it is not the clean consumer bootstrap. The adoption pilot above exercises the same public static transport with a smaller real recipe suitable for an installed-package gate.
