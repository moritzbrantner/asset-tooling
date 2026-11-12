// Worker runner shared by the Pages workbenches (#127): one Web Worker with at most one running and one waiting
// job. A newer job replaces the waiting one before it starts, and only the latest job's result reaches the page.
import { LatestRequest } from "./texture-workbench-state.js";

export type WorkbenchReply = { id: number; ok: boolean; error?: string };

export class WorkbenchRunner<Job extends object, Result extends WorkbenchReply> {
  #worker: Worker;
  #latest = new LatestRequest();
  #busy = false;
  #waiting: (Job & { id: number }) | undefined;
  constructor(
    private readonly url: string,
    private readonly onResult: (result: Result) => void,
    private readonly onBusy: (busy: boolean) => void,
  ) {
    this.#worker = this.#spawn();
  }
  #spawn() {
    const worker = new Worker(this.url, { type: "module" });
    worker.onmessage = (event: MessageEvent<Result>) => {
      this.#busy = false;
      if (this.#latest.isCurrent(event.data.id)) this.onResult(event.data);
      this.#pump();
    };
    worker.onerror = (event) => {
      this.#busy = false;
      this.onResult({ id: -1, ok: false, error: event.message || "the preview worker failed" } as Result);
      this.#pump();
    };
    return worker;
  }
  run(job: Job) {
    this.#waiting = { ...job, id: this.#latest.next() };
    this.#pump();
  }
  /** Stops the running job; its result never arrives. The next job starts a fresh worker without kept stages. */
  cancel() {
    this.#latest.next();
    this.#waiting = undefined;
    if (!this.#busy) return;
    this.#worker.terminate();
    this.#worker = this.#spawn();
    this.#busy = false;
    this.onBusy(false);
  }
  #pump() {
    if (this.#busy || !this.#waiting) {
      this.onBusy(this.#busy);
      return;
    }
    const job = this.#waiting;
    this.#waiting = undefined;
    this.#busy = true;
    this.onBusy(true);
    this.#worker.postMessage(job);
  }
}
