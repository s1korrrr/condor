import test from "node:test";
import assert from "node:assert/strict";
import { frontendModules } from "./helpers/frontend-module.mjs";

const { observationErrorMessage } = frontendModules().load("features/market-picture/source-errors.ts");

test("market picture failures read like the other panels' typed states", () => {
  assert.equal(observationErrorMessage(502, ["RESPONSE_CONTRACT_VIOLATION"]),
    "Error · Market Picture response failed validation (RESPONSE_CONTRACT_VIOLATION)");
  assert.equal(observationErrorMessage(503, ["SOURCE_DISABLED"]),
    "No data · Market Picture source disabled on this server (SOURCE_DISABLED)");
  assert.equal(observationErrorMessage(502, ["SOURCE_UNAVAILABLE"]),
    "Error · Market Picture source unavailable (SOURCE_UNAVAILABLE)");
  assert.equal(observationErrorMessage(403, []), "Unauthorized · Market Picture source unavailable (HTTP 403)");
  assert.equal(observationErrorMessage(500, ["not a code", 7]), "Error · Market Picture source unavailable (HTTP 500)");
  assert.equal(observationErrorMessage(503, ["NEW_OWNER_CODE"]), "Error · NEW_OWNER_CODE (NEW_OWNER_CODE)", "unknown codes stay visible");
});
