// The shared image kernels allocate with Node's global Buffer. Browser bundles import this first so they run unchanged.
import { Buffer } from "buffer";

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
