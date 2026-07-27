import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import GenerateUnitPage from "../../pages/GenerateUnitPage";

/**
 * Automate — Unit Test Engine (AI CLI + project root).
 * Phase U4: IDE bridge chỉ viewer/boost tuỳ chọn — không còn happy path.
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
