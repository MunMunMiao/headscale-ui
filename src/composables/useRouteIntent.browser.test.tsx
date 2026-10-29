import { act } from "react";
import { describe, expect, test } from "vitest";
import { prepareTestSession, renderSessionPage } from "@/test/session";
import { useRouteIntent } from "./useRouteIntent";

function IntentProbe() {
  const intent = useRouteIntent();
  return <output data-testid="intent">{JSON.stringify(intent)}</output>;
}

describe("useRouteIntent", () => {
  test("narrows the cross-page query protocol and rejects malformed values after navigation", async () => {
    const session = await prepareTestSession();
    const screen = await renderSessionPage(
      session,
      <IntentProbe />,
      "/devices?from=home&popup=node&user=user-1&node=node-1&search=alpha&profile=profile-1",
    );
    expect(
      JSON.parse(screen.getByTestId("intent").element().textContent ?? ""),
    ).toEqual({
      from: "home",
      popup: "node",
      userId: "user-1",
      nodeId: "node-1",
      search: "alpha",
      returnSearch: null,
      profileId: "profile-1",
    });
    await act(async () => {
      await screen.router.navigate({
        to: "/devices",
        search: {
          from: "elsewhere",
          popup: "",
          user: ["one", "two"],
          node: null,
          search: "",
        },
      });
    });
    expect(
      JSON.parse(screen.getByTestId("intent").element().textContent ?? ""),
    ).toEqual({
      from: null,
      popup: null,
      userId: null,
      nodeId: null,
      search: null,
      returnSearch: null,
      profileId: null,
    });
  });
});
