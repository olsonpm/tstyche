import { spawn } from "node:child_process";
import { getFixtureUrl } from "./getFixtureUrl.js";

/**
 * @param {string} fixture
 * @param {Array<string>} [args]
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ exitCode: number | null, stderr: string, stdout: string }>}
 */
export async function spawnTyche(fixture, args, options) {
  return new Promise((resolve, reject) => {
    const tstyche = spawn("tstyche", args, {
      cwd: getFixtureUrl(fixture),
      env: {
        ...process.env,
        ["TSTYCHE_NO_COLOR"]: "true",
        ["TSTYCHE_STORE_PATH"]: "./.store",
        ...options?.env,
      },
      shell: true,
    });

    let stdoutOutput = "";

    tstyche.stdout.on("data", (data) => {
      stdoutOutput += data;
    });

    let stderrOutput = "";

    tstyche.stderr.on("data", (data) => {
      stderrOutput += data;
    });

    tstyche.on("error", (error) => {
      reject(error);
    });

    tstyche.on("close", (exitCode) => {
      resolve({ exitCode, stderr: stderrOutput.toString(), stdout: stdoutOutput.toString() });
    });
  });
}
