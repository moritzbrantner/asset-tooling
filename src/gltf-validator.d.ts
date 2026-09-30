declare module "gltf-validator" {
  export function version(): string;
  export function validateBytes(bytes: Uint8Array, options: {
    format: "gltf" | "glb";
    writeTimestamp: false;
    maxIssues: number;
    externalResourceFunction: (uri: string) => Promise<Uint8Array>;
  }): Promise<{
    issues: {
      numErrors: number;
      numWarnings: number;
      truncated: boolean;
      messages: { code: string; severity: number; message: string; pointer?: string }[];
    };
  }>;
}
