import { Worker } from "node:worker_threads";
import { ApiError } from "../security/auth.js";

// Both formats are parsed off the HTTP event loop with bounded memory and time.
export async function bundleInfo(
  data: Buffer,
): Promise<{ id: string; build: string }> {
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const data=Buffer.from(workerData);
    const info=data.subarray(0,8).toString()==='bplist00'
      ? require('bplist-parser').parseBuffer(data)[0] : require('plist').parse(data.toString('utf8'));
    if(typeof info?.CFBundleIdentifier!=='string' || typeof info?.CFBundleVersion!=='string') throw Error();
    parentPort.postMessage({id:info.CFBundleIdentifier,build:info.CFBundleVersion});
  `,
    {
      eval: true,
      workerData: data,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
    },
  );
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new ApiError(422, "invalid_bundle_info"));
      const timer = setTimeout(fail, 3000);
      worker.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.once("error", () => {
        clearTimeout(timer);
        fail();
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        fail();
      });
    });
  } finally {
    await worker.terminate();
  }
}
