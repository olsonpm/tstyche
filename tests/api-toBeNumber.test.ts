import { expect, test } from "@jest/globals";
import { normalizeOutput } from "./__utils__/normalizeOutput.js";
import { spawnTyche } from "./__utils__/spawnTyche.js";

test("toBeNumber", async () => {
  const { exitCode, stderr, stdout } = await spawnTyche("api-toBeNumber");

  expect(normalizeOutput(stdout)).toMatchSnapshot("stdout");
  expect(normalizeOutput(stderr)).toMatchSnapshot("stderr");

  expect(exitCode).toBe(1);
});
