import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  digest, projectFrame, projectMicrostructureResponse, validateFrame,
} from "../src/features/market-picture/contract.mjs";

const fixture = () => JSON.parse(fs.readFileSync(
  new URL("../../tests/fixtures/market-picture.m1-components.fixture.json", import.meta.url), "utf8",
));
const omit = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
async function seal(frame) {
  frame.snapshot_id = await digest(omit(frame, "snapshot_id", "payload_digest"));
  frame.payload_digest = await digest(omit(frame, "payload_digest"));
  return frame;
}
async function companionFixture() {
  const frame = fixture();
  const scope = {
    ...Object.fromEntries(["stream_id", "epoch", "sequence", "revision", "source_kind", "cutoff_ms", "available_at_ms", "expires_at_ms"].map(key => [key, frame[key]])),
    universe_id: frame.universe.universe_id,
    universe_revision: frame.universe.revision,
    membership_hash: frame.universe.membership_hash,
    member_instrument_ids: frame.universe.member_instrument_ids,
    selected_numeraire: frame.universe.selected_numeraire,
  };
  const companion = {
    schema_version: "market-picture.microstructure-companion.v1", scope,
    capabilities: frame.source_capabilities, microstructure: frame.microstructure,
  };
  companion.component_id = await digest(companion);
  frame.microstructure_ref = {
    status: "available", component_id: companion.component_id,
    cutoff_ms: frame.cutoff_ms, available_at_ms: frame.available_at_ms,
    expires_at_ms: Math.min(frame.expires_at_ms,
      ...companion.microstructure.flows.map(row => row.expires_at_ms),
      ...companion.microstructure.liquidity.map(row => row.expires_at_ms)), reason_codes: [],
  };
  delete frame.microstructure;
  delete frame.source_capabilities;
  await seal(frame);
  const response = {
    schema_version: "market-picture.v1", snapshot_id: frame.snapshot_id,
    stream_id: frame.stream_id, frame_payload_digest: frame.payload_digest,
    read_at_ms: frame.published_at_ms + 100, companion,
  };
  return {frame, response};
}

test("a sealed companion preserves inline presentation without rewriting the frame", async () => {
  const inline = projectFrame(await validateFrame(fixture(), {allowFixture: true}));
  const {frame, response} = await companionFixture();
  const display = projectFrame(await validateFrame(frame, {allowFixture: true}));
  const projected = await projectMicrostructureResponse(response, display);
  assert.deepEqual(projected.microstructure, inline.microstructure);
  assert.deepEqual(projected.sourceCapabilities, inline.sourceCapabilities);
  assert.equal(display.raw, frame);
  assert.equal(display.raw.microstructure, undefined);
  assert.equal(response.companion.component_id, frame.microstructure_ref.component_id);
});

test("a companion cannot cross snapshot, frame digest, stream, scope or content identity", async () => {
  const mutations = [
    body => {body.snapshot_id = "f".repeat(64);},
    body => {body.frame_payload_digest = "f".repeat(64);},
    body => {body.stream_id = "different-source";},
    body => {body.companion.scope.membership_hash = "f".repeat(64);},
    body => {body.companion.scope.available_at_ms += 1;},
    body => {body.companion.capabilities[0].qualification = "not_probed";},
    body => {body.companion.microstructure.flows[0].buy_quote = "12345";},
    body => {body.companion.component_id = "f".repeat(64);},
  ];
  for (const mutate of mutations) {
    const {frame, response} = await companionFixture();
    mutate(response);
    await assert.rejects(projectMicrostructureResponse(response, projectFrame(frame)));
  }
});

test("resealing a private or future companion cannot bypass semantic qualification", async () => {
  for (const mutate of [
    body => {body.capabilities[0].access = "separately_authorized_private";},
    body => {body.microstructure.source_kind = "observed";},
    body => {body.microstructure.flows[0].available_at_ms = body.scope.available_at_ms + 1;},
  ]) {
    const {frame, response} = await companionFixture();
    mutate(response.companion);
    response.companion.microstructure.component_id = await digest(omit(response.companion.microstructure, "component_id"));
    response.companion.component_id = await digest(omit(response.companion, "component_id"));
    frame.microstructure_ref.component_id = response.companion.component_id;
    frame.flow_ref.snapshot_id = response.companion.microstructure.component_id;
    await seal(frame);
    response.snapshot_id = frame.snapshot_id;
    response.frame_payload_digest = frame.payload_digest;
    await assert.rejects(projectMicrostructureResponse(response, projectFrame(frame)));
  }
});

test("companion references reject contradictory inline content and unavailable identities", async () => {
  const {frame, response} = await companionFixture();
  frame.microstructure = response.companion.microstructure;
  await assert.rejects(validateFrame(await seal(frame), {allowFixture: true}));
  delete frame.microstructure;
  frame.microstructure_ref.status = "unavailable";
  frame.microstructure_ref.reason_codes = ["SOURCE_UNAVAILABLE"];
  await assert.rejects(validateFrame(await seal(frame), {allowFixture: true}));
});

test("companion responses retain the 2 MiB boundary and reject unsupported fields", async () => {
  const {frame, response} = await companionFixture();
  response.extra = "x".repeat(2 * 1024 * 1024);
  await assert.rejects(projectMicrostructureResponse(response, projectFrame(frame)), /large|limit|size/);
  response.extra = "unsupported";
  await assert.rejects(projectMicrostructureResponse(response, projectFrame(frame)));
});

test("the native adapter store and authenticated route fixture reaches the display boundary", async () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8"));
  const frame = await validateFrame(read("market-picture.microstructure-companion.frame.fixture.json"));
  const response = read("market-picture.microstructure-companion.response.fixture.json");
  const display = await projectMicrostructureResponse(response, projectFrame(frame));
  assert.equal(display.microstructure.flows.length,1);
  assert.equal(display.microstructure.liquidity.length,2);
  assert.equal(display.microstructure.flows[0].cumulativeAfter,"20");
  assert.equal(display.sourceCapabilities.length,2);
  assert.equal(display.flow.status,"available");
});
