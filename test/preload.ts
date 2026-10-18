// Blender-spawning tests key on ASSET_TOOLING_BLENDER. They run only with BLENDER_TESTS=1, so a configured
// local Blender does not slow ordinary `bun test` iteration; the hosted blender-script job sets it.
if (process.env.BLENDER_TESTS !== "1") delete process.env.ASSET_TOOLING_BLENDER;
