// Browser stand-in for Node modules a bundled dependency imports but the workbench never calls (gltf-transform's
// NodeIO loads node:fs and node:path for file access; the workbench only uses its in-memory writeBinary).
export default {};
