/** Nhãn tiếng Việt cho UI — map cả mã Anh cũ lẫn giá trị Việt mới. */

export const reviewLabel: Record<string, string> = {
  Draft: "Nháp",
  InReview: "Nháp",
  Approved: "Đã duyệt",
  Rejected: "Nháp",
};

/** Hai trạng thái hiển thị: Nháp | Đã duyệt */
export function displayReviewStatus(status: string | null | undefined): {
  label: string;
  color: "default" | "success";
} {
  if (status === "Approved") {
    return { label: "Đã duyệt", color: "success" };
  }
  return { label: "Nháp", color: "default" };
}

export function isTcPendingReview(status: string | null | undefined): boolean {
  return status !== "Approved";
}

export const typeLabel: Record<string, string> = {
  Functional: "Chức năng",
  Negative: "Phủ định",
  Boundary: "Biên",
  Api: "API",
  API: "API",
  Unit: "Unit",
  E2E: "E2E",
  Journey: "E2E",
  UI: "E2E",
  "Chức năng": "Chức năng",
  "Phủ định": "Phủ định",
  Biên: "Biên",
  "End-to-End": "E2E",
  "End to End": "E2E",
};

export const priorityLabel: Record<string, string> = {
  Low: "Thấp",
  Medium: "Trung bình",
  High: "Cao",
  Critical: "Nghiêm trọng",
  Thấp: "Thấp",
  "Trung bình": "Trung bình",
  Cao: "Cao",
  "Nghiêm trọng": "Nghiêm trọng",
};

export const jobStatusLabel: Record<string, string> = {
  Pending: "Chờ",
  Queued: "Hàng đợi",
  PendingWorker: "Chờ worker",
  Running: "Đang chạy",
  Completed: "Hoàn thành",
  Failed: "Thất bại",
};

export function labelOf(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  return map[value] ?? value;
}
