import { createClient, withEndpoint, withHTTPHandle } from "@defjs/core";
import { expect, test } from "vitest";
import { fixtureExecute } from "@/test/dispatch-fixture";
import { readHealth, readPolicy } from "./snapshot";

test.each([
  { name: "health", read: readHealth, response: { databaseConnectivity: true } },
  { name: "policy", read: readPolicy, response: { policy: "{}" } },
])("$name reads propagate cancellation through the Defjs transport", async ({ read, response }) => {
  const replies = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  const client = createClient(
    withEndpoint("https://headscale.test"),
    withHTTPHandle((input, init) => {
      signals.push(new Request(input, init).signal);
      return replies.promise;
    }),
  );
  const controller = new AbortController();
  const reading = read(fixtureExecute(client), { signal: controller.signal }).then(
    () => ({ code: "SUCCESS" }),
    (error: unknown) => error,
  );
  await expect.poll(() => signals.length).toBe(1);
  controller.abort();
  const propagated = signals[0].aborted;
  replies.resolve(Response.json(response));
  const outcome = await reading;
  expect(propagated).toBe(true);
  expect(outcome).toMatchObject({ code: "NET_ABORTED" });
});
