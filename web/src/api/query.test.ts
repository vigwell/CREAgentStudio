import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setTokenProvider } from "./client";
import { fetchQuery, invalidate, useQuery } from "./query";

let calls = 0;
beforeEach(() => {
  calls = 0;
  setTokenProvider(async () => "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ n: calls }), { status: 200 });
    }),
  );
});

describe("query cache", () => {
  it("shares a request already in flight", async () => {
    const [a, b] = await Promise.all([fetchQuery<{ n: number }>("/x"), fetchQuery<{ n: number }>("/x")]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("a screen seen before opens from memory, then refreshes when invalidated", async () => {
    const first = renderHook(() => useQuery<{ n: number }>("/y"));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    first.unmount();
    const again = renderHook(() => useQuery<{ n: number }>("/y"));
    expect(again.result.current.data).toEqual({ n: 1 }); // instant, no skeleton
    expect(again.result.current.isLoading).toBe(false);
    act(() => invalidate("/y"));
    await waitFor(() => expect(again.result.current.data).toEqual({ n: 2 }));
  });
});
