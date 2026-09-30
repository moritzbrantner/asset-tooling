export const BROWSER_SF3D_SOURCE = Object.freeze({
  repository: "Pixel11211/sf3d-webgpu",
  revision: "751e6642761466dbf15ed1e4c53ef6ed4db12b40",
  license: "MIT",
});

export const BROWSER_SF3D_MODEL = Object.freeze({
  repository: "needle-tools/SF3D-webgpu",
  revision: "56d2f58d27395b0be9c633671b439b4aac482549",
  license: "Stability AI Community License",
  totalBytes: 1730100305,
  assets: Object.freeze({
    imageTokenizer: Object.freeze({
      path: "onnx/image_tokenizer_single.onnx",
      bytes: 763808910,
      sha256: "cc8c76276a9cf86ece8a854827ed570bdbf71e458df09bde5664af46af29c21e",
    }),
    backbone: Object.freeze({
      path: "onnx/backbone_fp16.onnx",
      bytes: 911863351,
      sha256: "8bcde6d22589e8bbb753c4ca1a91f2c800f27a794b75405ef0dbee6b07b0da12",
    }),
    decoder: Object.freeze({
      path: "onnx/decoder_single.onnx",
      bytes: 104430,
      sha256: "ec4655df567128cc86b18b8a86b7b79d092d5223c8521a6d9993d08209e2785d",
    }),
    tetsVertices: Object.freeze({
      path: "tets_vertices.bin",
      bytes: 6430584,
      sha256: "16f4ee01a050d1757c19b13a7e1dbd4d0918d08208d961c105ff74cbfc345dac",
    }),
    tetsIndices: Object.freeze({
      path: "tets_indices.bin",
      bytes: 47543232,
      sha256: "606cc8b47f8744a64ff6f1f3c088d9d9113ff80539bd62cb1651f8dc629d1f1e",
    }),
    featuresMlp: Object.freeze({
      path: "features_mlp_weights.json",
      bytes: 349798,
      sha256: "b493e908039ebb70bf99f451b3ff85dc70cb2a62b29cefd17453ebdf27b8b4d7",
    }),
  }),
});

export const BROWSER_SF3D_CACHE_NAME =
  "asset-tooling-sf3d-webgpu-" + BROWSER_SF3D_MODEL.revision.slice(0, 12);

export const BROWSER_ORT_VERSION = "1.29.0";
export const BROWSER_THREE_VERSION = "0.186.0";
