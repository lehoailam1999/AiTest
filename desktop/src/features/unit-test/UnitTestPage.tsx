import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import GenerateUnitPage from "../../pages/GenerateUnitPage";

/**
 * Automate — Sinh mã Unit test (IDE-first).
 * Chỉ Unit; API test tạm ẩn khỏi product path.
 */
export default function UnitTestPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get("artifact") === "unit") return;
    const q = new URLSearchParams(searchParams);
    q.set("artifact", "unit");
    setSearchParams(q, { replace: true });
  }, [searchParams, setSearchParams]);

  return <GenerateUnitPage unitOnly />;
}
