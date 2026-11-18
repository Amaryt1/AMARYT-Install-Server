import { expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
it("validates the published OpenAPI contract", async () => {
  const spec = await SwaggerParser.validate("docs/openapi.yaml");
  expect(Object.keys(spec.paths ?? {})).toHaveLength(9);
});
