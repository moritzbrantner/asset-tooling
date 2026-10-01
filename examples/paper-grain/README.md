# Paper grain without 3D

Run `bun examples/paper-grain/build.ts`, then `python3 examples/paper-grain/review.py` (Pillow and DejaVu Sans required for inspection). Paths resolve from the scripts, so invoking them from another working directory produces the same outputs. Generation uses existing built-in surface operations and the declared FFmpeg PNG codec; it never invokes Blender, a mesh processor or a model service.

Three immutable editable presets keep one seed and restrained warm palette while changing fine/coarse/directional frequencies. Each also supplies a cool recolor using the accepted height step: one executed color operation and three reused height operations, compared with an independent full cold build. Only color is selected; normals and roughness are not computed. The intermediate scalar is noise data, not physical fiber or displacement evidence.

Six opaque, repeatable PNGs export through the existing static bundle profile, retaining their complete surface steps, editable recipes, original canonical image refs and encoder identities on the same content bytes. The example verifies the cold package and reads every PNG through the public bundle API after deleting its object store. Individual PNGs need no atlas or 3D runtime.

The independent inspector verifies pins and every decoded RGBA byte, then displays actual repeated tiles behind text. This is a producer text fixture, not adoption or theme approval in UI, a puzzle game or Flat Stories. Consumer repositories remain read-only; #131's real consumer acceptance and remaining texture families stay open. Outputs and screenshots under `.artifacts/paper-grain` are disposable. Repeat runs reconcile unchanged files; inspection failures remove stale preview evidence.
