import { describe, expect, it } from "vitest";
import { applyFanOutProgressToQueue } from "./applyFanOutProgressToQueue";

describe("applyFanOutProgressToQueue", () => {
  const base = [
    { title: "Auth", status: "pending" as const },
    { title: "Todo", status: "pending" as const },
    { title: "Settings", status: "pending" as const },
  ];

  it("marks module running / done / error from BE progress lines", () => {
    let q = applyFanOutProgressToQueue(base, "Module 1/3: Auth — đang gọi AI CLI…");
    expect(q?.[0].status).toBe("running");
    expect(q?.[1].status).toBe("pending");

    q = applyFanOutProgressToQueue(q, "Module 1/3: Auth — xong (+4 TC)");
    expect(q?.[0].status).toBe("done");

    q = applyFanOutProgressToQueue(q, "Module 2/3: Todo — lỗi: timed out");
    expect(q?.[1].status).toBe("error");
  });

  it("marks remaining done on Fan-out xong", () => {
    const q = applyFanOutProgressToQueue(
      [
        { title: "Auth", status: "done" },
        { title: "Todo", status: "running" },
      ],
      "Fan-out xong — 8 TC từ 2 module"
    );
    expect(q?.every((r) => r.status === "done")).toBe(true);
  });
});
