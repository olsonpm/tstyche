import { describe, expect, test } from "tstyche";

describe("argument for 'source'", () => {
  test("must be provided", () => {
    expect().type.toHaveProperty("runTest");
  });

  test("must be of an object type", () => {
    expect("sample").type.toHaveProperty("runTest");
  });
});

describe("type argument for 'Source'", () => {
  test("must be of an object type", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect<any>().type.toHaveProperty("runTest");
  });
});

describe("argument for 'key'", () => {
  test("must be provided", () => {
    // @ts-expect-error test
    expect<{ test: () => void }>().type.toHaveProperty();
  });

  test("must be of type 'string | number | symbol'", () => {
    // @ts-expect-error test
    expect<{ test: () => void }>().type.toHaveProperty(["test"]);
  });
});